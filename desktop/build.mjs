/**
 * 打包便携版 exe。
 *
 * 做法：Electron 官方的「手工打包」——把 electron 的运行时整套复制一份，
 * 改掉 exe 名字，再把应用塞进 resources/app/。不依赖 electron-builder
 * （它会额外拉一堆依赖，且在本机受限环境里容易在 build 脚本阶段被拦）。
 *
 * 产物结构：
 *   dist/微信读书打卡/
 *     微信读书打卡.exe          ← 由 electron.exe 改名
 *     *.dll / *.pak / locales/  ← 原样复制
 *     resources/
 *       app/
 *         package.json          ← 精简版
 *         main.js
 *         renderer/ theme/      ← 外壳
 *         plugin/               ← 插件本体（index.js 等五个文件，原样）
 *         vendor/               ← React 四个 production 构建（扁平）
 *
 * 用法：node build.mjs [--out <目录>]
 */

import { cp, mkdir, rm, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(HERE, '..');

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const OUT_ROOT = outIndex >= 0 && args[outIndex + 1]
  ? args[outIndex + 1]
  : join(HERE, 'dist', '微信读书打卡');

const ELECTRON_DIST = join(HERE, 'node_modules', 'electron', 'dist');
const APP_DIR_NAME = '微信读书打卡';
const EXE_NAME = `${APP_DIR_NAME}.exe`;

/** 插件本体要随 exe 一起走的文件（不含 probe / 文档 / 发版脚本）。 */
const PLUGIN_FILES = [
  'index.js',
  'client.js',
  'weread-api.js',
  'weread-verify.js',
  'weread-login.js',
  'package.json',
  'README.md',
  'LICENSE',
];

/** React 四个 production 构建：源路径 → 打包后的扁平名字。 */
const VENDOR_FILES = [
  [join('node_modules', 'scheduler', 'cjs', 'scheduler.production.js'), 'scheduler.js'],
  [join('node_modules', 'react', 'cjs', 'react.production.js'), 'react.js'],
  [join('node_modules', 'react-dom', 'cjs', 'react-dom.production.js'), 'react-dom.js'],
  [join('node_modules', 'react-dom', 'cjs', 'react-dom-client.production.js'), 'react-dom-client.js'],
];

function say(...parts) {
  console.log(...parts);
}

async function main() {
  if (!existsSync(ELECTRON_DIST)) {
    throw new Error(`找不到 Electron 运行时：${ELECTRON_DIST}\n先跑 npm install 并把 electron 的 dist 下载下来。`);
  }

  say('清理输出目录', OUT_ROOT);
  await rm(OUT_ROOT, { recursive: true, force: true });
  await mkdir(OUT_ROOT, { recursive: true });

  say('复制 Electron 运行时…');
  await cp(ELECTRON_DIST, OUT_ROOT, { recursive: true });

  // 改 exe 名字：Electron 靠「同级 resources/」找应用，名字本身无所谓
  const exeSrc = join(OUT_ROOT, 'electron.exe');
  const exeDst = join(OUT_ROOT, EXE_NAME);
  if (existsSync(exeSrc)) {
    await cp(exeSrc, exeDst);
    await rm(exeSrc, { force: true });
  } else {
    throw new Error('运行时里没有 electron.exe');
  }

  const appRoot = join(OUT_ROOT, 'resources', 'app');
  await rm(appRoot, { recursive: true, force: true });
  await mkdir(appRoot, { recursive: true });

  say('复制外壳与主题…');
  await cp(join(HERE, 'main.js'), join(appRoot, 'main.js'));
  await cp(join(HERE, 'renderer'), join(appRoot, 'renderer'), { recursive: true });
  await cp(join(HERE, 'theme'), join(appRoot, 'theme'), { recursive: true });

  say('复制插件本体…');
  const pluginOut = join(appRoot, 'plugin');
  await mkdir(pluginOut, { recursive: true });
  for (const file of PLUGIN_FILES) {
    const from = join(PLUGIN_DIR, file);
    if (!existsSync(from)) {
      say(`  ! 缺少 ${file}，跳过`);
      continue;
    }
    await cp(from, join(pluginOut, file));
  }

  say('复制 React 运行时…');
  const vendorOut = join(appRoot, 'vendor');
  await mkdir(vendorOut, { recursive: true });
  for (const [from, flat] of VENDOR_FILES) {
    const src = join(HERE, from);
    if (!existsSync(src)) throw new Error(`缺少 React 构建：${src}`);
    await cp(src, join(vendorOut, flat));
  }

  // 打包版的 package.json：不要 dependencies（node_modules 没跟着走），
  // 但要保留 main 与 name，Electron 靠它找入口。
  const srcPkg = JSON.parse(await readFile(join(HERE, 'package.json'), 'utf8'));
  const pluginPkg = JSON.parse(await readFile(join(PLUGIN_DIR, 'package.json'), 'utf8'));
  const pkg = {
    name: srcPkg.name,
    productName: APP_DIR_NAME,
    version: pluginPkg.version,
    description: srcPkg.description,
    main: 'main.js',
    // main.js 是 ESM（import electron / import ...）。不写 type 时 Node 会先按 CJS 解析，
    // 失败后回退 ESM，并在 stderr 打 MODULE_TYPELESS_PACKAGE_JSON 警告。
    type: 'module',
    private: true,
  };
  await writeFile(join(appRoot, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

  // 概览
  let total = 0;
  let files = 0;
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        files += 1;
        total += (await stat(full)).size;
      }
    }
  }
  await walk(OUT_ROOT);

  say('');
  say(`完成：${join(OUT_ROOT, EXE_NAME)}`);
  say(`文件数 ${files}，合计 ${(total / 1024 / 1024).toFixed(1)} MB`);
  say(`版本 v${pkg.version}`);
}

main().catch((err) => {
  console.error('打包失败：', err?.message ?? err);
  process.exit(1);
});

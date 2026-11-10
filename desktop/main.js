/**
 * 微信读书打卡 —— 独立桌面客户端（Electron 主进程）
 *
 * 设计要点：不复制一份插件代码，而是**原样加载仓库里的插件**
 *   · `../index.js`   —— 插件本体，用桩 ctx 调 apply()，拿到 /weread/api 的 handler
 *   · `../client.js`  —— 浏览器半边，原样喂给渲染进程（提供 window.__ModuleLoader__ 垫片）
 * 这样界面与功能天然和插件一致，插件升级后客户端只需重新打包，不必二次维护。
 *
 * 进程分工：
 *   主进程  起一个只监听 127.0.0.1 的 HTTP 服务，同时提供 /weread/api/* 与静态资源
 *   渲染进程 加载同一份 client.js + React（从 vendor/ 或 node_modules/ 直接读 production cjs）
 *
 * 之所以走 HTTP 而不是 IPC：client.js 里所有请求都是相对路径 fetch('/weread/api/xxx')，
 * 给它一个同源服务就一行都不用改。
 */

import electron from 'electron';
import { createServer } from 'node:http';
import { readFile, copyFile, mkdir } from 'node:fs/promises';
import { existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, normalize, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// 具名导入在 Electron 38 的 ESM 里不稳（namespace 形状随加载方式变化），统一走默认导入
const { app, BrowserWindow, Menu, dialog, shell } = electron;

/**
 * 启动日志：Windows 是 GUI 子系统程序，控制台看不到 stdout，
 * 出问题只能靠文件。放在 userData 下，发布版也留着（体积很小、便于排障）。
 */
let LOG_FILE = '';
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.map((p) => (typeof p === 'string' ? p : String(p))).join(' ')}\n`;
  process.stdout.write(line);
  if (!LOG_FILE) return;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(LOG_FILE, line, 'utf8');
  } catch { /* 日志写不了不该影响主流程 */ }
}

/* ------------------------------------------------------------------ *
 * 0. 启动环境
 * ------------------------------------------------------------------ */

app.setAppUserModelId('com.zhangyxx.weread-checkin');

// 单实例：两个客户端同时跑会各开一份自动打卡定时器，重复上报
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const APP_ROOT = app.getAppPath();

/**
 * 数据目录默认落在系统标准的 userData（%APPDATA%\weread-checkin-desktop）。
 * 支持 WEREAD_DESKTOP_DATA 覆盖，用于「绿色版」把数据放在 exe 同目录，
 * 也方便在受限环境里指到别的可写位置。
 */
const DATA_OVERRIDE = process.env.WEREAD_DESKTOP_DATA?.trim();
if (DATA_OVERRIDE) {
  try { app.setPath('userData', DATA_OVERRIDE); } catch { /* 路径非法就退回默认 */ }
}
const DATA_DIR = app.getPath('userData');
LOG_FILE = join(DATA_DIR, 'desktop.log');

/** 插件本体所在目录：打包后在 resources/app/plugin，开发时就是仓库根。 */
const PLUGIN_DIR = existsSync(join(APP_ROOT, 'plugin'))
  ? join(APP_ROOT, 'plugin')
  : join(APP_ROOT, '..');

const RENDERER_DIR = join(APP_ROOT, 'renderer');
const THEME_DIR = join(APP_ROOT, 'theme');

/**
 * React 的四个 production 构建。
 * 打包版从 vendor/ 读扁平副本；开发版直接读 node_modules 里的原始文件。
 * 之所以能这么干：四个文件里 `process.env` 命中数为 0（已逐个验证），
 * 不需要任何 NODE_ENV 注入，也不必打包。
 */
const VENDOR = [
  ['scheduler', 'scheduler.js', join('scheduler', 'cjs', 'scheduler.production.js')],
  ['react', 'react.js', join('react', 'cjs', 'react.production.js')],
  ['react-dom', 'react-dom.js', join('react-dom', 'cjs', 'react-dom.production.js')],
  ['react-dom-client', 'react-dom-client.js', join('react-dom', 'cjs', 'react-dom-client.production.js')],
];

function vendorFile(flatName, nestedPath) {
  const flat = join(APP_ROOT, 'vendor', flatName);
  if (existsSync(flat)) return flat;
  return join(APP_ROOT, 'node_modules', nestedPath);
}

/* ------------------------------------------------------------------ *
 * 1. 环境与数据目录准备
 * ------------------------------------------------------------------ */

/**
 * 读取用户级环境变量里的 WEREAD_API_KEY。
 *
 * 必要性：插件从 process.env.WEREAD_API_KEY 取官方 API Key。从资源管理器启动的
 * 进程能继承用户环境变量，但从某些启动器/脚本拉起时可能拿不到，界面就会显示
 * 「未配置 API Key」。这里兜底查一次注册表，读到就注入当前进程。
 * 绝不打印值本身。
 */
function hydrateApiKeyFromRegistry() {
  if (process.env.WEREAD_API_KEY) return false;
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', 'WEREAD_API_KEY'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000,
    });
    const hit = out.match(/WEREAD_API_KEY\s+REG_[A-Z_]+\s+(.+)/);
    const value = hit?.[1]?.trim();
    if (value) {
      process.env.WEREAD_API_KEY = value;
      return true;
    }
  } catch {
    // 没装 reg / 没这个变量：静默跳过，界面会提示用户手动填
  }
  return false;
}

/**
 * 首次运行时把 DSH 插件已有的凭据复制过来。
 *
 * 目的：用户本来就在 DSH 里用同一个账号，客户端第一次打开就该能直接看到数据，
 * 而不是再扫一次码。只复制凭据（Cookie / API Key），**不复制状态文件**——
 * 免得把「今天已打卡」与自动打卡记账带过来，导致两边的判断互相干扰。
 */
async function migrateCredentialsFromPlugin() {
  const target = join(DATA_DIR, 'weread-credentials.json');
  if (existsSync(target)) return false;
  const legacy = join(homedir(), '.dsh', 'weread-credentials.json');
  if (!existsSync(legacy)) return false;
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await copyFile(legacy, target);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * 2. 用桩 ctx 拉起插件本体
 * ------------------------------------------------------------------ */

const disposers = [];
let apiHandler = null;
let pluginError = null;

/**
 * 插件的 ctx 只需要两种能力：
 *   · effect(fn)            —— 立即执行；fn 若返回函数则登记为清理器
 *   · webServer.register()  —— 交出 /weread/api 的 handler
 * tools / commands 只在 DSH 里有意义（对话触发），客户端不注册，代码里都有 if 守卫。
 */
async function startPlugin() {
  const ctx = {
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
    webServer: {
      register({ handler }) {
        apiHandler = handler;
        return () => { apiHandler = null; };
      },
    },
  };

  const entry = pathToFileURL(join(PLUGIN_DIR, 'index.js')).href;
  const mod = await import(entry);

  // 状态与凭据都落在客户端自己的 userData 里，不碰 ~/.dsh，
  // 避免和插件同时运行时互相覆盖同一个 json。
  mod.apply(ctx, {
    stateFile: join(DATA_DIR, 'weread-state.json'),
    credentialsFile: join(DATA_DIR, 'weread-credentials.json'),
  });
}

/* ------------------------------------------------------------------ *
 * 3. 本地 HTTP 服务
 * ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload ?? {}), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** 把相对路径限制在 root 之内，挡住 ../ 越界。 */
function safeJoin(root, rel) {
  const base = normalize(root + sep);
  const target = normalize(join(root, rel));
  if (target !== normalize(root) && !target.startsWith(base)) {
    const err = new Error('path out of root');
    err.code = 'EOUT';
    throw err;
  }
  return target;
}

async function sendFile(res, filePath, extraHeaders) {
  const buf = await readFile(filePath);
  res.writeHead(200, {
    'content-type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
    'content-length': buf.length,
    'cache-control': 'no-cache',
    ...(extraHeaders ?? {}),
  });
  res.end(buf);
}

/** 把 production cjs 包成「往 __cjs 注册一个模块」的形式。 */
async function sendVendor(res, flatName, nestedPath) {
  const file = vendorFile(flatName, nestedPath);
  const code = await readFile(file, 'utf8');
  const moduleId = flatName.replace(/\.js$/, '');
  const wrapped = `window.__cjs.define(${JSON.stringify(moduleId)}, function (module, exports, require) {\n${code}\n});\n`;
  const buf = Buffer.from(wrapped, 'utf8');
  res.writeHead(200, {
    'content-type': 'text/javascript; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-cache',
  });
  res.end(buf);
}

async function route(req, res) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendJson(res, 400, { ok: false, error: 'bad path' });
    return;
  }

  // 插件 API：原样交给 index.js 注册的 handler（它自己处理 405/404/500）
  if (pathname === '/weread/api' || pathname.startsWith('/weread/api/')) {
    if (!apiHandler) {
      sendJson(res, 503, {
        ok: false,
        error: pluginError ? `插件加载失败：${pluginError}` : '插件尚未就绪',
      });
      return;
    }
    await apiHandler(req, res);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('method not allowed');
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    await sendFile(res, join(RENDERER_DIR, 'index.html'));
    return;
  }

  if (pathname === '/plugin/client.js') {
    // 原样喂插件的前端半边，一个字节都不改
    await sendFile(res, join(PLUGIN_DIR, 'client.js'));
    return;
  }

  const vendorHit = VENDOR.find(([, flat]) => pathname === `/vendor/${flat}`);
  if (vendorHit) {
    await sendVendor(res, vendorHit[1], vendorHit[2]);
    return;
  }

  if (pathname.startsWith('/renderer/')) {
    await sendFile(res, safeJoin(RENDERER_DIR, pathname.slice('/renderer/'.length)));
    return;
  }
  if (pathname.startsWith('/theme/')) {
    await sendFile(res, safeJoin(THEME_DIR, pathname.slice('/theme/'.length)));
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
}

function startServer() {
  const server = createServer((req, res) => {
    route(req, res).catch((err) => {
      if (res.headersSent) { res.end(); return; }
      const status = err?.code === 'ENOENT' ? 404 : err?.code === 'EOUT' ? 403 : 500;
      sendJson(res, status, { ok: false, error: String(err?.message ?? err) });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

/* ------------------------------------------------------------------ *
 * 4. 窗口
 * ------------------------------------------------------------------ */

let win = null;

function createWindow(baseUrl) {
  win = new BrowserWindow({
    width: 1120,
    height: 800,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: '微信读书打卡',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // 外链走系统浏览器，别在客户端里开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  // 没有原生菜单栏，快捷键自己接
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12') {
      win.webContents.toggleDevTools();
      event.preventDefault();
      return;
    }
    if ((input.control || input.meta) && input.key.toLowerCase() === 'r') {
      win.webContents.reload();
      event.preventDefault();
      return;
    }
    if ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i') {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  win.loadURL(baseUrl);
  win.on('closed', () => { win = null; });
}

/* ------------------------------------------------------------------ *
 * 5. 生命周期
 * ------------------------------------------------------------------ */

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  // 倒序清理：插件的 effect 会关掉一键登录留下的浏览器窗口、停掉定时器与长跑打卡
  for (let i = disposers.length - 1; i >= 0; i -= 1) {
    try { disposers[i](); } catch { /* 清理失败不该阻止退出 */ }
  }
  disposers.length = 0;
});

async function main() {
  Menu.setApplicationMenu(null);
  log('启动', `APP_ROOT=${APP_ROOT}`, `PLUGIN_DIR=${PLUGIN_DIR}`, `DATA_DIR=${DATA_DIR}`);

  hydrateApiKeyFromRegistry();
  const migrated = await migrateCredentialsFromPlugin();

  try {
    await startPlugin();
    log('插件已加载，api handler =', apiHandler ? 'ok' : 'missing');
  } catch (err) {
    pluginError = String(err?.stack ?? err?.message ?? err);
    log('插件加载失败：', pluginError);
    dialog.showErrorBox(
      '微信读书打卡',
      `插件加载失败，界面将无法读取数据。\n\n${pluginError}`,
    );
  }

  const { port } = await startServer();
  const baseUrl = `http://127.0.0.1:${port}/`;
  log('本地服务已启动', baseUrl);
  createWindow(baseUrl);

  if (migrated) log('已从 DSH 插件迁移凭据到', DATA_DIR);
}

app.whenReady().then(main).catch((err) => {
  log('启动失败', String(err?.stack ?? err));
  dialog.showErrorBox('微信读书打卡 启动失败', String(err?.stack ?? err));
  app.quit();
});

# 微信读书打卡 · 桌面客户端

把 DSH 插件 `dsh-weread-checkin` 原样装进一个 Electron 壳里，做成双击即用的独立 exe。
界面、交互、数据与插件完全一致——因为**渲染层跑的就是插件的 `client.js`，业务层跑的就是插件的 `index.js`**，这里只补了一个浏览器外壳。

```
desktop/
├─ main.js                 Electron 主进程：加载插件 + 本地静态服务 + 单实例
├─ renderer/
│  ├─ index.html           外壳页面（引主题 CSS + vendor + 插件 client.js + app.js）
│  ├─ bootstrap.js         最小 CJS 加载器（window.__cjs）+ 插件模块登记（window.__ModuleLoader__）
│  └─ app.js               外壳 React：左侧 rail（打卡 / 设置 / 主题）+ slots 垫片
├─ theme/                  从 DSH 抽出的设计令牌（palette / light / dark 三份 CSS）
└─ build.mjs               手工打包脚本：electron dist + 插件源码 → dist/微信读书打卡
```

## 复刻原理

插件的 `client.js` 是一个 DSH 模块包，外层是：

```js
window.__ModuleLoader__.load({ id: 'dsh-weread-checkin', factory(require) { ... } })
```

内部只 `require('react')`，渲染靠 `ctx.slots.register({ name: 'main' | 'sidebar.panellist' | 'plugins.bundle.config' }, Component)`。

所以外壳只要做三件事：

1. **提供 `window.__ModuleLoader__`**，把 factory 接住（`renderer/bootstrap.js`）；
2. **提供 `window.__cjs`**，把 React / ReactDOM 的 production CJS 包注册成模块（`main.js` 把它们包成 `define(id, function(module, exports, require){...})` 再下发）；
3. **提供 `ctx.slots` 垫片**，把 `main` 收成主内容区、`sidebar.panellist` 收成左边 rail 图标、`plugins.bundle.config` 收成设置页（`renderer/app.js`）。

`client.js` 里没有 `new Function` / `eval`，所以可以直接用普通 `<script>` 加载，不需要放宽 CSP。

业务侧同理：`main.js` 直接 `import()` 插件的 `index.js`，传一个假 ctx（只有 `effect` 和 `webServer.register`）就拿到了完整的 API handler。

```js
const ctx = {
  effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return d; },
  webServer: { register({ handler }) { apiHandler = handler; return () => { apiHandler = null; }; } },
};
const mod = await import(pathToFileURL(join(PLUGIN_DIR, 'index.js')).href);
mod.apply(ctx, {
  stateFile: join(DATA_DIR, 'weread-state.json'),
  credentialsFile: join(DATA_DIR, 'weread-credentials.json'),
});
```

`index.js` 的 `ctx.tools` / `ctx.commands` / `ctx.webServer` 全都带 `if (ctx.x)` 守卫，缺了也不报错；`config.stateFile` 与 `config.credentialsFile` 可以覆盖数据文件路径，所以**客户端的数据存在自己的 `userData` 里，不碰 `~/.dsh`**。

## 打包

```powershell
cd D:\DSH工作区\微信读书插件\desktop
npm install            # 只需一次，装 electron + react
node build.mjs         # → desktop\dist\微信读书打卡
```

产物约 325 MB / 95 个文件，只有 1 个 exe：`dist\微信读书打卡\微信读书打卡.exe`。
`build.mjs` 做的是「复制 electron dist → 改名 exe → 塞 `resources/app/{main.js,renderer,theme,vendor,plugin}`」，不依赖 electron-builder。

**用之前记得把产物从仓库目录复制出去再运行**：

```powershell
Copy-Item desktop\dist\微信读书打卡 D:\微信读书打卡 -Recurse
```

## ⚠️ 不能放在 D:\DSH工作区 下运行

`D:\DSH工作区` 这个目录带有一条**可继承的低完整性级别标签**：

```
Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)
```

任何复制进它的文件都会继承 Low IL。Electron / Chromium 的 GUI 启动需要写 shader cache、需要对自身目录做映射，而 Low IL 进程无法向上写 Medium IL 对象 —— 结果是**进程秒退**：

```
Received fatal exception EXCEPTION_BREAKPOINT
    Cr_z_uncompress
    v8::ScriptCompiler::ScriptStreamingTask::ScriptStreamingTask
事件日志：electron.exe 38.8.6.0，异常代码 0x80000003，错误偏移 0x00000000073d0e6c
```

已验证：
- 同一份产物（SHA256 `62C62D17...`）放在 `D:\微信读书打卡` → 正常启动、4 个进程、能读到数据
- 放进 `D:\DSH工作区\任何子目录` → 秒退，且 `icacls` 显示 `Mandatory Label\Low Mandatory Level`
- 只有 GUI 模式崩；`ELECTRON_RUN_AS_NODE=1`（纯 node 模式，不起渲染子进程）在工作区内正常
- `notepad` / `regedit` 在工作区内能起（它们不需要那些跨完整性级别的写操作）

ACL、8.3 短名、`subst` 映射、`--no-sandbox` 系列开关、Defender 受控文件夹访问都已排除。

## 数据位置

| 内容 | 路径 |
| --- | --- |
| 凭据 / 状态 | `%APPDATA%\微信读书打卡\weread-credentials.json`、`weread-state.json` |
| 运行日志 | `%APPDATA%\微信读书打卡\desktop.log`（每次启动追加：端口、插件加载、凭据迁移） |

首次启动会做两件环境适配：

1. **迁凭据**：`~/.dsh/weread-credentials.json` → 客户端自己的目录（只迁凭据，不迁 state，避免两边「今日已打卡」互相干扰）；
2. **补 API Key**：`process.env.WEREAD_API_KEY` 为空时读注册表 `HKCU\Environment`，读到了就注回 `process.env`。

想换数据目录，设 `WEREAD_DESKTOP_DATA` 环境变量即可。

## 自检

```powershell
# 起了客户端之后，从 desktop.log 里拿端口
node desktop\_selftest.mjs http://127.0.0.1:<port>
# → ALL GOOD  或列出失败项
```

`_selftest.mjs` 会逐个请求 `/`、三个主题 CSS、bootstrap/app、`/plugin/client.js`、四个 vendor，再 POST `/weread/api/{status,badge,dashboard}`，全 200 才通过。

## 已知限制

- 单实例：`requestSingleInstanceLock()`，再次双击只会把已有窗口提到前面（避免两个客户端各跑一份自动打卡定时器重复上报）。
- 自动打卡定时器只在客户端运行时有效；要用 DSH 后台常驻，就继续用插件本体。
- 右侧布局用 CDP 量过：卡片两列 `492.6px 492.6px`、右边缘 1076 < 窗口内宽 1106，无溢出。

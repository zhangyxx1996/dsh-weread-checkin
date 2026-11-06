/**
 * 微信读书打卡插件 —— 一键获取 Cookie（Host 端）。
 *
 * 为什么不直接在页面里读 document.cookie：
 *   实测登录后 document.cookie 只有 34 字符（wr_gid / wr_fp），真正的
 *   wr_skey / wr_vid / wr_rt 全是 httpOnly，页面 JS 读不到。
 *   所以必须走浏览器调试协议（CDP）从进程外读 Network.getAllCookies。
 *
 * 流程：拉起一个**隔离 profile** 的浏览器窗口 → 用户微信扫码 → 轮询 CDP
 * 直到 cookie 里出现 wr_skey + wr_vid → 取全量 cookie → 关窗口 → 写凭据。
 *
 * 用隔离 profile 而不是用户日常的 profile，原因有三：
 *   1. 日常 profile 被正在运行的浏览器锁着，起不来第二个调试实例；
 *   2. 不该去读用户浏览器里所有站点的 cookie；
 *   3. 用完即删，不留下任何东西。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 登录页。 */
const LOGIN_URL = 'https://weread.qq.com/';
/** 等用户扫码的总时长。 */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
/** 轮询 CDP 取 cookie 的间隔。 */
const POLL_MS = 1000;
/** 等 CDP 端口就绪的上限。 */
const CDP_READY_TRIES = 80;

/**
 * 候选浏览器。Windows 上通常只装了 Edge，所以 Edge 排前面；
 * 同时留 macOS / Linux 的常见路径，方便同一份代码在别的机器上也能用。
 */
function browserCandidates() {
  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

  const list = [
    // Edge（Windows）
    { name: 'Edge', path: join(programFilesX86, 'Microsoft\\Edge\\Application\\msedge.exe') },
    { name: 'Edge', path: join(programFiles, 'Microsoft\\Edge\\Application\\msedge.exe') },
    // Chrome（Windows）
    { name: 'Chrome', path: join(localAppData, 'Google\\Chrome\\Application\\chrome.exe') },
    { name: 'Chrome', path: join(programFiles, 'Google\\Chrome\\Application\\chrome.exe') },
    { name: 'Chrome', path: join(programFilesX86, 'Google\\Chrome\\Application\\chrome.exe') },
    // Edge / Chrome（macOS）
    { name: 'Edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
    { name: 'Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
  ];

  // Linux：优先读 PATH 上的命令名
  if (process.platform === 'linux') {
    list.push(
      { name: 'Chrome', command: 'google-chrome' },
      { name: 'Chromium', command: 'chromium' },
      { name: 'Chromium', command: 'chromium-browser' },
      { name: 'Edge', command: 'microsoft-edge' },
    );
  }
  return list;
}

/** 找一个可用的浏览器；找不到返回 null。 */
export function findBrowser() {
  for (const cand of browserCandidates()) {
    if (cand.command) return cand; // Linux 的命令名交给 spawn 自己解析
    if (existsSync(cand.path)) return cand;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 会话表：一个「点一次」对应一个会话，前端靠 sessionId 轮询             */
/* ------------------------------------------------------------------ */

/** @type {Map<string, {child: any, profile: string, port: number, state: string, message: string, cookie: string, startedAt: number, timer: any, ws: any}>} */
const sessions = new Map();
let seq = 0;

function newSessionId() {
  seq += 1;
  return `login-${Date.now().toString(36)}-${seq}`;
}

/** 挑一个空闲端口：用 0 让系统分配不可行（CDP 要提前知道端口），故在范围内探测。 */
async function pickPort() {
  for (let port = 9410; port < 9500; port++) {
    const free = await new Promise((resolve) => {
      import('node:net').then(({ createServer }) => {
        const srv = createServer();
        srv.once('error', () => resolve(false));
        srv.once('listening', () => srv.close(() => resolve(true)));
        srv.listen(port, '127.0.0.1');
      }).catch(() => resolve(false));
    });
    if (free) return port;
  }
  throw new Error('找不到空闲端口启动浏览器调试');
}

async function fetchJson(url, tries = 1) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {
      /* 浏览器还没起来，继续等 */
    }
    if (i < tries - 1) await sleep(250);
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 连上页面 target 并执行 CDP 命令。
 * 刻意不引入 playwright / puppeteer：插件不应为这一个功能加几十 MB 依赖，
 * Node 20+ 自带全局 WebSocket，够用。
 */
async function withCdp(wsUrl, fn) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('连接浏览器调试端口失败'));
    setTimeout(() => reject(new Error('连接浏览器调试端口超时')), 5000);
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    const cb = pending.get(msg.id);
    if (cb) {
      pending.delete(msg.id);
      cb(msg);
    }
  };
  const call = (method, params = {}) => new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  try {
    return await fn(call);
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * 从 CDP 的 cookie 列表里拼出可用的 Cookie 字符串。
 * 只取 weread.qq.com 域下的，并按「wr_ 开头优先」排序，方便人眼核对。
 */
function buildCookieString(cookies) {
  const wr = cookies
    .filter((c) => typeof c.domain === 'string' && c.domain.includes('weread.qq.com'))
    .filter((c) => c.name && typeof c.value === 'string' && c.value !== '');
  // 同名 cookie 可能在不同 path 上各有一份，取 path 更长的（更具体）
  const byName = new Map();
  for (const c of wr) {
    const prev = byName.get(c.name);
    if (!prev || (c.path || '').length > (prev.path || '').length) byName.set(c.name, c);
  }
  const names = [...byName.keys()].sort((a, b) => {
    const aw = a.startsWith('wr_') ? 0 : 1;
    const bw = b.startsWith('wr_') ? 0 : 1;
    return aw - bw || a.localeCompare(b);
  });
  return names.map((n) => `${n}=${byName.get(n).value}`).join('; ');
}

/** 读一次 cookie，判断是否已经登录完成。 */
async function readLoginState(port) {
  const tabs = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  // 必须按 type=page + http(s) 选 target：否则会选中扩展后台页，cookie 永远是 0 个
  const page = (tabs || []).find((t) => t.type === 'page' && /^https?:/.test(t.url));
  if (!page?.webSocketDebuggerUrl) return { ready: false };

  const result = await withCdp(page.webSocketDebuggerUrl, async (call) => {
    await call('Network.enable');
    const res = await call('Network.getAllCookies');
    return res?.result?.cookies ?? [];
  });

  const jar = {};
  for (const c of result) {
    if (jar[c.name] === undefined && c.value) jar[c.name] = c.value;
  }
  // wr_skey 是会话票据、wr_vid 是长期身份，两者齐了才算真的登录成功。
  // 只判 wr_skey 不够：续期接口缺 wr_vid 会返回「参数格式错误」。
  const done = Boolean(jar.wr_skey) && Boolean(jar.wr_vid);
  return {
    ready: true,
    done,
    cookie: done ? buildCookieString(result) : '',
    url: page.url,
  };
}

/** 关掉浏览器并清理临时 profile。 */
function teardown(session) {
  try {
    if (session.timer) clearInterval(session.timer);
  } catch {
    /* ignore */
  }
  try {
    session.child?.kill();
  } catch {
    /* ignore */
  }
  // Windows 上 kill 后文件句柄可能还没释放，删不掉就留给系统临时目录清理
  setTimeout(() => {
    try {
      rmSync(session.profile, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }, 1500);
}

/**
 * 启动一次登录：打开浏览器窗口，立刻返回 sessionId，由前端轮询。
 *
 * 返回 {ok, sessionId, browser} 或 {ok:false, reason}
 */
export async function loginStart({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const browser = findBrowser();
  if (!browser) {
    return {
      ok: false,
      reason: '没有找到可用的浏览器。请先安装 Edge 或 Chrome，再用下方的手动方式粘贴 Cookie。',
    };
  }

  let port;
  try {
    port = await pickPort();
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err) };
  }

  const profile = mkdtempSync(join(tmpdir(), 'weread-login-'));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--window-size=520,780',
    LOGIN_URL,
  ];

  let child;
  try {
    child = spawn(browser.command || browser.path, args, {
      detached: false,
      stdio: 'ignore',
      windowsHide: false,
    });
  } catch (err) {
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return { ok: false, reason: `启动浏览器失败：${err?.message ?? err}` };
  }

  const sessionId = newSessionId();
  const session = {
    child,
    profile,
    port,
    state: 'waiting',
    message: '已打开浏览器，请用微信扫码登录',
    cookie: '',
    startedAt: Date.now(),
    timer: null,
  };
  sessions.set(sessionId, session);

  // 浏览器自己退出（用户关了窗口）→ 直接判失败，别让前端白等
  child.on('exit', () => {
    if (session.state === 'waiting') {
      session.state = 'failed';
      session.message = '浏览器窗口已关闭，未完成登录';
    }
    teardown(session);
  });
  child.on('error', (err) => {
    session.state = 'failed';
    session.message = `浏览器启动出错：${err?.message ?? err}`;
    teardown(session);
  });

  // 等 CDP 就绪，顺带确认窗口真的起来了
  const ready = await fetchJson(`http://127.0.0.1:${port}/json/version`, CDP_READY_TRIES);
  if (!ready) {
    session.state = 'failed';
    session.message = '浏览器调试端口没有就绪。可能是浏览器版本过低，或被杀毒软件拦截。';
    teardown(session);
    return { ok: false, reason: session.message };
  }

  session.timer = setInterval(async () => {
    if (session.state !== 'waiting') return;
    if (Date.now() - session.startedAt > timeoutMs) {
      session.state = 'failed';
      session.message = '等待扫码超时（5 分钟），请重试。';
      teardown(session);
      return;
    }
    try {
      const st = await readLoginState(session.port);
      if (st.done && st.cookie) {
        session.cookie = st.cookie;
        session.state = 'done';
        session.message = '登录成功，Cookie 已取得';
        teardown(session);
      }
    } catch {
      /* 页面还在跳转，下一轮再看 */
    }
  }, POLL_MS);
  session.timer.unref?.();

  return { ok: true, sessionId, browser: browser.name, port };
}

/**
 * 查询登录进度。
 * 返回 {ok, state, message, cookie?}；state 取 waiting / done / saved / failed / unknown。
 */
export async function loginStatus({ sessionId } = {}) {
  const session = sessionId ? sessions.get(sessionId) : null;
  if (!session) {
    return { ok: false, state: 'unknown', message: '这次登录会话已结束，请重新点击「一键获取」' };
  }
  if (session.state === 'done') {
    return { ok: true, state: 'done', message: session.message, cookie: session.cookie };
  }
  if (session.state === 'saved') {
    // 已经落盘过一次，cookie 已抹掉，重复轮询不会再写一遍
    return { ok: true, state: 'saved', message: session.message };
  }
  if (session.state === 'failed') {
    return { ok: false, state: 'failed', message: session.message };
  }
  return { ok: true, state: 'waiting', message: session.message };
}

/** cookie 已经写进凭据文件：抹掉明文并标记，防止重复轮询重复保存。 */
export function loginConsume({ sessionId, message } = {}) {
  const session = sessionId ? sessions.get(sessionId) : null;
  if (!session) return { ok: true };
  session.cookie = '';
  session.state = 'saved';
  if (typeof message === 'string' && message) session.message = message;
  return { ok: true };
}

/** 用户主动取消，或拿到 cookie 后收摊。 */
export function loginCancel({ sessionId } = {}) {
  const session = sessionId ? sessions.get(sessionId) : null;
  if (session) {
    if (session.state === 'waiting') {
      session.state = 'failed';
      session.message = '已取消';
    }
    teardown(session);
    sessions.delete(sessionId);
  }
  return { ok: true };
}

/** 插件卸载时清掉所有残留窗口。 */
export function loginShutdown() {
  for (const [, session] of sessions) teardown(session);
  sessions.clear();
}

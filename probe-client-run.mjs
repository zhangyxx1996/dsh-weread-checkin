/**
 * 离线模拟浏览器半边：伪造 window.__ModuleLoader__ / React / document / fetch，
 * 执行 client.js 的 factory，调用 apply(ctx)，再用真实数据渲染各组件。
 *
 * 关键：模拟器给每个组件实例分配独立的 hook 槽位并跨多次渲染保留，
 * 这样异步 setData 之后的「有数据」渲染也能被验证到。
 */
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

// 按本文件所在目录定位 client.js，避免写死仓库绝对路径（仓库 2026-11-01 从
// dsh-weread-checkin 迁到「微信读书插件」，写死路径会直接读不到文件）
const here = dirname(fileURLToPath(import.meta.url));
const src = await readFile(join(here, 'client.js'), 'utf8');

// ---------- 假 React（每组件独立 hook 槽位，可多次渲染） ----------
const stores = new Map(); // comp -> {state:[], effects:[], pending:[], cursor:0}
let current = null;

const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) };
  },
  useState(init) {
    const s = current;
    const i = s.cursor++;
    // 用 hasOwnProperty 而不是 `in`：state 是稀疏数组，`in` 会命中原型链上的
    // "0"/"1" 之类，导致新增的 state 永远拿不到初值。
    if (!Object.prototype.hasOwnProperty.call(s.state, i)) {
      s.state[i] = typeof init === 'function' ? init() : init;
    }
    return [s.state[i], (v) => { s.state[i] = typeof v === 'function' ? v(s.state[i]) : v; }];
  },
  useCallback(fn) { current.cursor++; return fn; },
  useMemo(fn) { current.cursor++; return fn(); },
  useRef(v) { current.cursor++; return { current: v }; },
  useEffect(fn) { current.cursor++; current.pending.push(fn); },
};

// ---------- 假 document ----------
const styleTags = [];
const document = {
  head: { appendChild: (el) => styleTags.push(el) },
  createElement: (tag) => ({ tagName: tag, dataset: {}, setAttribute(k, v) { this.dataset[k.replace('data-', '')] = v; }, textContent: '' }),
  querySelector: () => null,
  querySelectorAll: () => [],
};

// ---------- 相对「今天」的时间坐标 ----------
// 这些假数据必须跟着真实日期走：日历组件全部按 new Date() 判定「本周 / 上月 / 未来」，
// 一旦把日期写死（历史版本写死成 2026-10-31），换个星期跑就会满屏假失败。
const pad2 = (n) => String(n).padStart(2, '0');
const ymdOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const CAL_NOW = new Date();
const TODAY_YMD = ymdOf(CAL_NOW);
/** 本周周一（与 client.js 的 weekStartYmd 同口径）。 */
const WEEK_MONDAY = (() => {
  const d = new Date(CAL_NOW.getFullYear(), CAL_NOW.getMonth(), CAL_NOW.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
})();
const THIS_WEEK = Array.from({ length: 7 }, (_, i) => ymdOf(addDays(WEEK_MONDAY, i)));
/** 上一周：dashboard 完全不覆盖这 7 天，正是周历 bug 的现场。 */
const LAST_WEEK = Array.from({ length: 7 }, (_, i) => ymdOf(addDays(WEEK_MONDAY, -7 + i)));
const TODAY_SEC = 1230;

/**
 * 某一天的「真实」秒数——history 与 dashboard.month 共用同一个来源。
 *
 * 必须共用：两段数据在真实后端里描述的是同一天同一个数字。如果假数据里它们
 * 互相打架（比如 history 说 11-01 有 3000 秒、month 说 900 秒），测试断言就成了
 * 在验证「哪段覆盖哪段」的偶然结果，而不是验证功能。
 */
function secForDate(ymd) {
  if (ymd === TODAY_YMD) return 0; // history 里今日刻意给 0，用来证明 dashboard 覆盖它
  if (LAST_WEEK.includes(ymd)) return 3000; // 上一周：只有 history 才有这段
  const [y, m, d] = ymd.split('-').map(Number);
  const idx = Math.round((new Date(y, m - 1, d) - new Date(2026, 0, 1)) / 86400000);
  if (idx < 0) return 0;
  return idx % 5 === 0 ? 2400 : (idx % 3 === 0 ? 420 : 0);
}

// ---------- 假后端 ----------
const responses = {
  status: {
    ok: true, configured: true, hasCookie: true, hasBase: true, baseFromBuiltin: true,
    canVerify: true, running: false, lastRunAt: 0, lastDay: TODAY_YMD, lastDone: 20, lastErrors: [],
    minutes: 10, goalMinutes: 20, autoTime: '08:30', today: TODAY_YMD, lastDayDone: true, lastFail: '',
    version: JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version,
  },
  // v0.2.0 侧边栏三色点：没这个假响应时 SidebarIcon 会走 catch 一律变红
  badge: { ok: true, level: 'green', reason: '', todaySec: 1230, goalMinutes: 20, readDays: 558 },
  checkin: { ok: true, done: 20, minutes: 10, errors: [], skeyRefreshes: 1, verified: true, dToday: 600, todaySec: 1830, readDays: 559, goalMinutes: 20, goalReached: true },
  // v1.1.0 停止接口
  stop: { ok: true, message: '正在停止…' },
  setupMinutes: { ok: true, minutes: 15, message: '单次打卡时长已设为 15 分钟' },
  setupGoal: { ok: true, goalMinutes: 20, message: '每日目标已设为 20 分钟' },
  setupAuto: { ok: true, autoTime: '09:15', message: '已设为每天 09:15 自动打卡' },
  renew: { ok: true, reason: '' },
  /**
   * 历史日级序列（2026-01-01 至今），供日历翻看历史用。
   *
   * 刻意让今日在 history 里是 0：dashboard 才是新鲜数据源，它覆盖 history 之后
   * 今日格子必须仍然达标。若覆盖逻辑写反（history 优先），今日就会变成「未读」。
   * 上一周（LAST_WEEK）给满 3000 秒：那正是 dashboard 不覆盖、必须靠 history 的区间。
   */
  history: {
    ok: true, months: 11, goalMinutes: 20, checkedDays: 17, totalSec: 91452,
    series: (() => {
      const out = [];
      const start = new Date(2026, 0, 1);
      const end = new Date(CAL_NOW.getFullYear(), CAL_NOW.getMonth(), CAL_NOW.getDate());
      for (let i = 0; ; i += 1) {
        const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        if (d > end) break;
        const ymd = ymdOf(d);
        out.push({ date: ymd, sec: secForDate(ymd) });
      }
      return out;
    })(),
  },
  // v0.3.0 书架（每本书的阅读时长）
  shelf: {
    ok: true, total: 28, bookCount: 27, albumCount: 0, hasMp: true,
    yearTotalSec: 86040, coveredCount: 7, goalMinutes: 20,
    books: [
      { bookId: 'a', title: '绍宋', author: '', cover: '', finished: false, yearSec: 38520, totalSec: null },
      { bookId: 'b', title: '太白金星有点烦', author: '马伯庸', cover: '', finished: true, yearSec: 18720, totalSec: null },
      { bookId: 'c', title: '刑法罗盘', author: '罗翔', cover: '', finished: false, yearSec: 1080, totalSec: null },
      { bookId: 'd', title: '金粉世家（全集）', author: '张恨水', cover: '', finished: false, yearSec: 720, totalSec: null },
      { bookId: 'e', title: '三体全集（全三册）', author: '刘慈欣', cover: '', finished: false, yearSec: null, totalSec: null },
    ],
    albums: [],
  },
  /**
   * v1.2.0 阅读画像。hours 已经是「0 点到 23 点」的自然顺序（服务端重排过），
   * 客户端不该再做任何位移——这里把峰值放在 15 点，若谁把 +6 的位移挪到前端，
   * 断言里的「最常在 15 点」就会错位成 21 点，立刻暴露。
   */
  profile: {
    ok: true,
    hours: Array.from({ length: 24 }, (_, hh) => (hh === 15 ? 33380 : (hh < 6 ? 100 : 12000))),
    hourTotalSec: 418159, peakHour: 15, peakSec: 33380,
    timeWord: '偏好下午与夜晚阅读', categoryWord: '偏好阅读男生小说',
    categories: [
      { title: '男生小说', parent: '', count: 77, sec: 1067851 },
      { title: '文学', parent: '', count: 12, sec: 49200 },
    ],
    catMaxSec: 1067851,
    authorCount: 73,
    authors: [{ name: '余华', count: 3, readTime: '6小时45分钟' }, { name: '刘慈欣', count: 2, readTime: '2小时' }],
    medals: [
      { id: 'M9-0-10', hint: '阅读 10 本神作', title: '阅读神作', rankText: '第3994406位获得此勋章的书友', ctime: 1700000000 },
      { id: 'M2-1-5', hint: '连续阅读 5 天', title: '持之以恒', rankText: '第100位获得此勋章的书友', ctime: 1690000000 },
    ],
  },
  // v1.3.0 笔记列表：刻意留一本「有笔记数但没有划线原文」的（囚徒健身那类真实情况）
  notebooks: {
    ok: true, totalBookCount: 3, totalNoteCount: 9, noteTotal: 9, truncated: false,
    books: [
      { bookId: '834464', title: '活着', author: '余华', cover: '', noteCount: 7, raw: [7, 0, 0], lastAt: new Date(2024, 4, 15).getTime(), progress: 100 },
      { bookId: '750578', title: '囚徒健身', author: '保罗·威德', cover: '', noteCount: 2, raw: [0, 2, 0], lastAt: new Date(2022, 5, 1).getTime(), progress: 97 },
    ],
  },
  // v1.3.0 单本划线：传给活着的 bookId 才有内容，其余返回空（模拟「想法不是划线」）
  bookmarks: {
    ok: true, bookId: '834464', title: '活着', author: '余华', total: 1,
    marks: [{ id: '834464_5_1', text: '我知道黄昏正在转瞬即逝，黑夜从天而降了。', chapter: '五', at: 1557891659000, range: '15073-15141' }],
  },
  dashboard: {
    ok: true, configured: true, autoTime: '08:30', minutes: 10, goalMinutes: 20, lastDayDone: true, lastRunAt: Date.now(), lastFail: '',
    progress: { done: 0, total: 0, startedAt: 0, todayBefore: 0, todaySec: null, phase: 'idle' },
    today: { date: TODAY_YMD, sec: TODAY_SEC, min: 20.5, reached: true, threshold: 300 },
    week: {
      start: THIS_WEEK[0], end: THIS_WEEK[6], totalSec: 15376, checkedDays: 3, compare: -0.2746,
      series: THIS_WEEK.map((date) => ({
        date,
        sec: date > TODAY_YMD ? 0 : (date === TODAY_YMD ? TODAY_SEC : secForDate(date)),
      })),
      topBooks: [
        { title: '绍宋', author: '', sec: 14641, cover: '' },
        { title: '三体全集（全三册）', author: '刘慈欣', sec: 490, cover: 'https://example.com/c.jpg' },
      ],
    },
    month: {
      year: CAL_NOW.getFullYear(), month: CAL_NOW.getMonth() + 1, firstWeekday: 4, daysInMonth: 31,
      checkedDays: 5, totalSec: 40108,
      series: Array.from({ length: CAL_NOW.getDate() }, (_, i) => {
        const date = `${CAL_NOW.getFullYear()}-${pad2(CAL_NOW.getMonth() + 1)}-${pad2(i + 1)}`;
        return { date, sec: date === TODAY_YMD ? TODAY_SEC : secForDate(date) };
      }),
    },
    overall: {
      totalSec: 1639101, readDays: 558,
      stat: [
        { label: '读过', value: '168本' }, { label: '读完', value: '19本' },
        { label: '阅读', value: '558天' }, { label: '笔记', value: '23条' },
      ],
    },
  },
};

let loaded = null;
globalThis.window = { __ModuleLoader__: { load(reg) { loaded = reg; } } };

const requested = [];
// 挂起中的请求数：用于模拟「打卡正在跑、接口还没返回」的状态
const pendingHolds = new Set();
/**
 * 一次性故障注入：method → 只失败一次的响应体。
 *
 * 用来验证「读取历史失败 → 提示 + 重试按钮 → 点重试后确实重新拉」这条路径。
 * 只失败一次，所以第二次请求会拿到正常假数据。
 */
const onceFailures = new Map();
async function fakeFetch(url) {
  requested.push(url);
  const method = String(url).split('/').pop();
  if (pendingHolds.has(method)) {
    // 永不 resolve，让 busy 一直保持 true
    await new Promise(() => {});
  }
  if (onceFailures.has(method)) {
    const body = onceFailures.get(method);
    onceFailures.delete(method);
    return { ok: true, status: 200, json: async () => body };
  }
  const body = responses[method] ?? { ok: false, error: 'unknown method ' + method };
  return { ok: true, status: 200, json: async () => body };
}

// ---------- 执行 client.js ----------
const fn = new Function('window', 'document', 'fetch', 'setInterval', 'clearInterval', 'console', src);
fn(globalThis.window, document, fakeFetch, () => 0, () => {}, console);

assert.ok(loaded, 'client.js 没有调用 __ModuleLoader__.load');
assert.strictEqual(loaded.id, 'dsh-weread-checkin');
console.log('✓ bundle id:', loaded.id);

const mod = loaded.factory((name) => {
  if (name === 'react') return React;
  throw new Error('unexpected require: ' + name);
});
assert.strictEqual(typeof mod.apply, 'function');
assert.ok(Array.isArray(mod.inject));
console.log('✓ factory →', Object.keys(mod), 'inject =', mod.inject);

assert.ok(styleTags.length >= 1, '样式没有在 factory 内注入');
console.log('✓ 样式在 factory 内注入，长度', styleTags[0].textContent.length);
assert.ok(styleTags[0].textContent.includes('--dsw-alias-'), '样式没用主题令牌');
// v0.2.0：iOS 观感与三色徽标的关键类必须存在
for (const cls of ['.wr-group', '.wr-seg', '.wr-nav-dot-green', '.wr-nav-dot-yellow', '.wr-nav-dot-red', '.wr-track']) {
  assert.ok(styleTags[0].textContent.includes(cls), `样式缺少 ${cls}`);
}
console.log('✓ iOS 风格类与三色徽标类齐全');

// ---------- 假 ctx ----------
const registered = { slots: [] };
const ctx = {
  effect(fn, label) { return fn(); },
  slots: {
    inject(name, fn) { return fn(); },
    register(reg, comp) { registered.slots.push({ reg, comp }); return () => {}; },
  },
  layout: { selectPanel() {} },
};
mod.apply(ctx);
console.log('✓ apply ok →', registered.slots.map((s) => `${s.reg.name}[${s.reg.key ?? s.reg.id}]`).join(', '));
assert.strictEqual(registered.slots.length, 3);

// ---------- 渲染器：每组件独立槽位 ----------
/**
 * 把一个元素树摊成纯文本。遇到函数组件就真正调用它（每个组件实例在 stores 里
 * 有自己的 hook 槽位），这样嵌套的 TodayCard/WeekCard 等也都会被渲染验证。
 */
function flattenText(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node !== 'object') return '';
  if (typeof node.type === 'function') {
    return render(node.type, node.props ?? {});
  }
  let t = '';
  for (const c of node.children ?? []) t += flattenText(c);
  return t;
}

/** 收集元素树里所有 className，用于断言徽标颜色。 */
function collectClasses(node, acc = []) {
  if (node === null || node === undefined || typeof node !== 'object') return acc;
  const cn = node.props?.className;
  if (typeof cn === 'string') acc.push(cn);
  for (const c of node.children ?? []) collectClasses(c, acc);
  return acc;
}

/** 渲染一次组件，返回原始元素树（hook 槽位里的 current 在内部置好）。 */
function renderTree(comp, props = {}, runEffects = true) {
  const store = stores.get(comp) ?? { state: [], effects: [], pending: [], cursor: 0 };
  stores.set(comp, store);
  const outer = current;
  store.cursor = 0;
  current = store;
  let out;
  try {
    out = comp(props);
  } catch (e) {
    current = outer;
    throw new Error(`组件 ${comp.name} 渲染抛错: ${e.message}`, { cause: e });
  }
  // 首次挂载才跑 effect
  const fresh = store.pending;
  store.pending = [];
  current = outer;
  if (runEffects) {
    for (const eff of fresh) {
      try { eff(); } catch (e) {
        throw new Error(`组件 ${comp.name} 的 effect 抛错: ${e.message}`, { cause: e });
      }
    }
  }
  return out;
}

/**
 * 只读渲染：递归展开函数组件以拿到完整元素树，但**不写回任何 hook 槽位**。
 *
 * 为什么需要它：findNode / flattenText / collectAllClasses 这类纯查找函数
 * 每次都会重渲染涉及的组件，而真实 React 里组件渲染是按部就班、槽位有状态的。
 * 若让查找也走 renderTree，它会推进 cursor 并可能覆盖 state 槽位，导致
 * 「点了一下按钮，状态却读不到」这类假失败。这里把 store 快照进出还原，
 * 让查找对状态完全无副作用。
 */
function peekTree(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node;
  if (typeof node.type !== 'function') {
    return {
      ...node,
      children: (node.children ?? []).map((c) => peekTree(c)),
    };
  }
  const saved = stores.get(node.type);
  const snapshot = saved
    ? { state: [...saved.state], pending: [...saved.pending], cursor: saved.cursor }
    : null;
  try {
    return peekTree(renderTree(node.type, node.props ?? {}, false));
  } finally {
    if (snapshot) {
      saved.state = snapshot.state;
      saved.pending = snapshot.pending;
      saved.cursor = snapshot.cursor;
    } else if (saved) {
      stores.delete(node.type);
    }
  }
}

/** 渲染一次组件并摊成纯文本。 */
function render(comp, props = {}) {
  return flattenText(renderTree(comp, props));
}

const tick = () => new Promise((r) => setTimeout(r, 0));

const panelComp = registered.slots.find((s) => s.reg.name === 'main').comp;
const iconComp = registered.slots.find((s) => s.reg.name === 'sidebar.panellist').comp;
const settingsComp = registered.slots.find((s) => s.reg.name === 'plugins.bundle.config').comp;

// 1) 首帧：加载中
let txt = render(panelComp);
assert.ok(txt.includes('加载中'), '首帧应显示加载中，实际: ' + txt.slice(0, 60));
console.log('✓ Panel 首帧 → 加载中');

// 2) 等 dashboard 返回后重渲染：应出现真实数字
await tick();
await tick();
txt = render(panelComp);
console.log('✓ Panel 有数据帧文本 →', txt.replace(/\s+/g, ' ').slice(0, 260));
assert.ok(txt.includes('20.5'), '应显示今日 20.5 分钟');
assert.ok(txt.includes('已达标'), '今日已达标应显示');
// v1.1.5：日历周视图不再展示「读得最多」，假数据里的 topBooks 不应出现在文本里
assert.ok(!txt.includes('读得最多'), '打卡日历不应再有「读得最多」区块');
assert.ok(txt.includes('每天 08:30'), '应显示自动打卡时间');
assert.ok(txt.includes('558'), '应显示累计阅读天数');

// 3) 图标能渲染，且按 badge 返回画绿点
render(iconComp);
await tick();
{
  const cls = collectClasses(renderTree(iconComp, { size: 18 })).join(' ');
  assert.ok(cls.includes('wr-nav-dot'), '图标里没有状态点');
  assert.ok(cls.includes('wr-nav-dot-green'), 'badge 返回 green 时应画绿点，实际: ' + cls);
  console.log('✓ SidebarIcon 徽标 →', /wr-nav-dot-\w+/.exec(cls)?.[0]);
}

// 4) 设置页首帧 + 等 status 返回
let st = render(settingsComp);
await tick();
await tick();
st = render(settingsComp);
console.log('✓ Settings 文本 →', st.replace(/\s+/g, ' ').slice(0, 200));
assert.ok(st.includes('已配置'), '应显示 Cookie 已配置');
assert.ok(st.includes('可核对时长'), '应显示可核对时长');
assert.ok(st.includes('内置模板'), '应显示内置模板');

// 4b) 设置页必须展示版本号，且与 package.json 一致
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
assert.ok(st.includes('关于'), '设置页应有「关于」分组');
assert.ok(st.includes('v' + pkg.version), `设置页应显示 v${pkg.version}，实际未见`);
assert.ok(st.includes('dsh-weread-checkin'), '设置页应显示包名');
console.log('✓ 设置页版本号 → v' + pkg.version);

// 4c) 面板底部也要有版本号
assert.ok(txt.includes('微信读书打卡'), '面板底部应有插件名');
assert.ok(txt.includes('v' + pkg.version), `面板底部应显示 v${pkg.version}`);
console.log('✓ 面板底部版本号 → v' + pkg.version);

// 5) v0.2.0 新增：时长档位与徽标接口都要真的被请求过
for (const m of ['dashboard', 'badge', 'status']) {
  assert.ok(requested.some((u) => u.endsWith('/' + m)), `没有请求 ${m}`);
}
console.log('✓ 徽标 / 设置接口均已请求');

// ---------- 以下为 v0.3.0 新增能力的验证 ----------
/** 在元素树里找满足条件的第一个节点（遇到函数组件会展开进去找）。 */
function findNode(node, pred) {
  if (node === null || node === undefined || typeof node !== 'object') return null;
  if (typeof node.type === 'function') {
    return findNode(renderTree(node.type, node.props ?? {}, false), pred);
  }
  let ok = false;
  try { ok = pred(node); } catch { ok = false; }
  if (ok) return node;
  for (const c of node.children ?? []) {
    const hit = findNode(c, pred);
    if (hit) return hit;
  }
  return null;
}
/** 递归渲染整棵树（含函数子组件）并真正执行它们的 effect。 */
function mountDeep(node, depth = 0) {
  if (node === null || node === undefined || typeof node !== 'object' || depth > 12) return;
  if (typeof node.type === 'function') {
    mountDeep(renderTree(node.type, node.props ?? {}, true), depth + 1);
    return;
  }
  for (const c of node.children ?? []) mountDeep(c, depth + 1);
}

/** 点一下元素树里文字匹配的按钮，然后整树重挂让 setState 与 effect 生效。 */
function clickButton(comp, props, label) {
  const tree = renderTree(comp, props);
  const btn = findNode(tree, (n) => n.type === 'button'
    && flattenText(n).includes(label) && typeof n.props?.onClick === 'function');
  assert.ok(btn, `没找到按钮「${label}」`);
  btn.props.onClick();
  mountDeep(renderTree(comp, props));
  return true;
}
/** 连续整树挂载 + 让出事件循环，等待异步 fetch 落地后 setState 再次生效。 */
async function settle(comp, props, times = 4) {
  for (let i = 0; i < times; i += 1) {
    mountDeep(renderTree(comp, props));
    await tick();
  }
}
/** 把整棵树（含函数组件）里所有节点的 className 收集起来。 */
function collectAllClasses(node, acc = []) {
  if (node === null || node === undefined || typeof node !== 'object') return acc;
  if (typeof node.type === 'function') {
    collectAllClasses(renderTree(node.type, node.props ?? {}, false), acc);
    return acc;
  }
  const cn = node.props?.className;
  if (typeof cn === 'string') acc.push(cn);
  for (const c of node.children ?? []) collectAllClasses(c, acc);
  return acc;
}

/** 收集所有 title 属性（书架封面网格把书名放在 title 上）。 */
function collectTitleAttrs(node, acc = []) {
  if (node === null || node === undefined || typeof node !== 'object') return acc;
  if (typeof node.type === 'function') {
    collectTitleAttrs(renderTree(node.type, node.props ?? {}, false), acc);
    return acc;
  }
  if (typeof node.props?.title === 'string') acc.push(node.props.title);
  for (const c of node.children ?? []) collectTitleAttrs(c, acc);
  return acc;
}

/**
 * 收集日历格子 → [{ date, cls }]。
 * 日历格子的颜色类名和日期是分开的两个属性（className / title），必须一起取，
 * 否则没法断言「某一天是红是绿」。
 */
function collectCells(node, acc = []) {
  if (node === null || node === undefined || typeof node !== 'object') return acc;
  if (typeof node.type === 'function') {
    collectCells(renderTree(node.type, node.props ?? {}, false), acc);
    return acc;
  }
  const cn = node.props?.className;
  const title = node.props?.title;
  if (typeof cn === 'string' && cn.includes('wr-cal-cell') && typeof title === 'string') {
    const date = /^\d{4}-\d{2}-\d{2}/.exec(title)?.[0];
    if (date) acc.push({ date, cls: cn });
  }
  for (const c of node.children ?? []) collectCells(c, acc);
  return acc;
}

// 6) 进度条按「每日目标」而非固定 5 分钟：goal=20、sec=1230(20.5min) 应 100% 且变绿
{
  const tree = renderTree(panelComp);
  const fill = findNode(tree, (n) => typeof n.props?.className === 'string'
    && n.props.className.includes('wr-track-fill'));
  assert.ok(fill, '没找到进度条');
  assert.ok(fill.props.className.includes('wr-track-fill-on'), '达成目标后进度条应变绿');
  const w = String(fill.props.style?.width ?? '');
  assert.strictEqual(w, '100%', `目标 20 分钟读 20.5 分钟应 100%，实际 ${w}`);
  const legend = flattenText(tree);
  assert.ok(legend.includes('目标 20 分钟'), '进度条图例应写目标 20 分钟');
  console.log('✓ 进度条按每日目标计算 →', w, '且已变绿');
}

// 7) 日历周视图：本周自足不预取；往回翻必须补拉历史，且历史日不能画成「未读」
{
  // 进界面时是本週视图，dashboard 的 week.series 恰好铺满本周，足够了 → 不该预取
  assert.ok(!requested.some((u) => u.endsWith('/history')), '进界面不该预取 history（本周视图是自足的）');
  const thisWeekCells = collectCells(renderTree(panelComp));
  assert.ok(thisWeekCells.length >= 7, `周视图应有 7 格，实际 ${thisWeekCells.length}`);
  assert.ok(
    thisWeekCells.every((c) => THIS_WEEK.includes(c.date)),
    '周视图默认应展示本周：' + thisWeekCells.map((c) => c.date).join(','),
  );
  console.log('✓ 周视图首屏 → 本周 7 格，未预取 history');

  // 往回翻一周：这 7 天 dashboard 完全不覆盖，必须靠 history 补齐。
  // 修复前这里不拉 history，7 天全是 0 秒 →「未读」红色（用户的原始反馈）。
  clickButton(panelComp, {}, '‹');
  await settle(panelComp, {}, 6);
  assert.ok(requested.some((u) => u.endsWith('/history')), '周视图往回翻时应补拉 history');
  const prevCells = collectCells(renderTree(panelComp));
  assert.ok(
    prevCells.every((c) => LAST_WEEK.includes(c.date)),
    '往回翻一周后应展示上一周：' + prevCells.map((c) => c.date).join(','),
  );
  const prevMap = new Map(prevCells.map((c) => [c.date, c.cls]));
  const missing = LAST_WEEK.filter((d) => !prevMap.has(d));
  assert.strictEqual(missing.length, 0, '上一周有日期没画出来: ' + missing.join(','));
  // 假数据里上一周每天 3000 秒（50 分钟 > 目标 20 分钟）→ 必须达标上绿，绝不能是「未读」红
  for (const d of LAST_WEEK) {
    const cls = prevMap.get(d);
    assert.ok(!cls.includes('wr-cal-red-0'), `${d} 明明读过却画成「未读」红，class=${cls}`);
    assert.ok(cls.includes('wr-cal-ok-'), `${d} 读过 3000 秒应达标上绿，class=${cls}`);
  }
  console.log('✓ 周视图往回翻 → 补拉 history，上一周 7 天均按实际秒数上绿（非「未读」红）');

  // 今日必须取 dashboard 的新鲜值，不能被 history 里的 0 秒盖掉（假数据里 history 今日=0）
  clickButton(panelComp, {}, '›');
  await settle(panelComp, {}, 4);
  const backCells = new Map(collectCells(renderTree(panelComp)).map((c) => [c.date, c.cls]));
  const todayCls = backCells.get(TODAY_YMD);
  assert.ok(todayCls, '回到本周后应有今日格子');
  assert.ok(
    !todayCls.includes('wr-cal-red-0'),
    `今日取 dashboard 的 ${TODAY_SEC} 秒，不该被 history 的 0 秒覆盖成「未读」，class=${todayCls}`,
  );
  console.log('✓ 今日格子 → dashboard 覆盖 history，打卡后不会退回「未读」');
}

// 7b) 月视图：history 已经在上面拉过了，直接翻月验证绿/红齐备
{
  clickButton(panelComp, {}, '月');
  await settle(panelComp, {}, 4);
  // 本月可能还没过几天，退回上个月才能看到整月的绿/红分布
  clickButton(panelComp, {}, '‹');
  await settle(panelComp, {}, 3);
  const tree = renderTree(panelComp);
  const txt2 = flattenText(tree);
  assert.ok(txt2.includes('年') && txt2.includes('月'), '月视图应显示年月标题');
  const cells = collectAllClasses(tree).filter((c) => c.includes('wr-cal-cell'));
  assert.ok(cells.some((c) => c.includes('wr-cal-ok-')), '达标日应上绿色');
  assert.ok(cells.some((c) => c.includes('wr-cal-red-')), '未达标日应上红色');
  console.log('✓ 日历月视图 → 绿/红达标色齐备，格子数', cells.length);
}

// 8) 书架：常驻展示并预取，封面网格（默认裁到两排）
{
  assert.ok(requested.some((u) => u.endsWith('/shelf')), '书架常驻显示，进界面就该请求 shelf');
  const tree3 = renderTree(panelComp);
  const t3 = flattenText(tree3);
  // 封面网格里书名只放在 title 属性上，靠 hover 显示
  const titles3 = collectTitleAttrs(tree3).join(' ');
  assert.ok(titles3.includes('绍宋'), '书架应显示书名（title 属性）');
  // 38520 秒 = 10.7 小时，fmtDuration 在 >=10 小时时取整，所以显示「11 小时」
  assert.ok(t3.includes('11 小时'), '书架应显示每本书的阅读时长');
  assert.ok(t3.includes('5.2 小时'), '书架应显示小数小时');
  assert.ok(t3.includes('—'), '进不了榜单的书应显示占位符');
  assert.ok(t3.includes('时长覆盖'), '书架应如实标注时长覆盖率');

  const cls3 = collectAllClasses(tree3);
  assert.ok(cls3.some((c) => c.includes('wr-cover-grid')), '书架应是封面网格');
  assert.ok(
    cls3.some((c) => c.includes('wr-cover-grid') && c.includes('wr-cover-grid-clip')),
    '默认应裁切到两排封面（wr-cover-grid-clip）',
  );
  assert.ok(cls3.some((c) => c.includes('wr-cover-tile')), '应渲染封面格子');
  assert.ok(cls3.some((c) => c.includes('wr-cover')), '应渲染封面图');

  // 展开全部 → 解除裁切（假数据不足 8 本时该按钮不出现，跳过）
  const hasAllBtn = flattenText(renderTree(panelComp)).includes('全部');
  if (hasAllBtn) {
    clickButton(panelComp, {}, '全部');
    await settle(panelComp, {}, 3);
    const cls3b = collectAllClasses(renderTree(panelComp));
    assert.ok(
      !cls3b.some((c) => c.includes('wr-cover-grid') && c.includes('wr-cover-grid-clip')),
      '点「全部」后应解除两排裁切',
    );
  }
  console.log('✓ 书架常驻显示 → 封面网格 + 两排裁切', hasAllBtn ? '+ 全部展开' : '(假数据 <8 本)');
}

// 9) 周视图默认从周一开头
{
  const css = styleTags[0].textContent;
  assert.ok(css.includes('.wr-cal-dow'), '缺少星期表头样式');
  const src = readFileSync(new URL('./client.js', import.meta.url), 'utf8');
  assert.ok(
    src.includes("['一', '二', '三', '四', '五', '六', '日']"),
    '星期表头应以周一开头',
  );
  assert.ok(
    src.includes('((d.getDay() + 6) % 7)'),
    'weekStartYmd / firstWeekday 应换算成周一开头',
  );
  console.log('✓ 周视图 → 周一开头（表头 + 偏移均换算）');
}

// 9) 打卡中：按钮灰色、不可点、文案为「打卡中」
{
  const css = styleTags[0].textContent;
  assert.ok(css.includes('.wr-btn-loading'), '缺少打卡中的灰色按钮样式');
  assert.ok(css.includes('.wr-spin'), '缺少打卡中的转圈样式');
  assert.ok(/\.wr-btn-loading[^{]*\{[^}]*cursor:\s*not-allowed/.test(css), '打卡中样式应含 cursor:not-allowed');
  console.log('✓ 打卡中按钮样式 → 灰色 .wr-btn-loading + 转圈 + not-allowed');
}

// 10) 继续打卡（v1.1.0）：达标后出现「继续打卡」→ 弹出时长输入 → 可随时停止
{
  const css = styleTags[0].textContent;
  assert.ok(css.includes('.wr-btn-run'), '缺少「停止」按钮样式（.wr-btn-run）');
  assert.ok(!css.includes('.wr-btn-stop'), '残留的旧「停止」按钮样式 .wr-btn-stop 应已删除');
  assert.ok(css.includes('.wr-ask'), '缺少「继续打卡」时长询问面板样式');

  // 达标状态下应能看到「继续打卡」，且今日大按钮是「已达标」的绿态
  const treeA = renderTree(panelComp);
  const txtA = flattenText(treeA);
  assert.ok(txtA.includes('继续打卡'), '达标后应出现「继续打卡」按钮');
  const mainBtnA = findNode(treeA, (n) => n.type === 'button'
    && typeof n.props?.className === 'string'
    && n.props.className.includes('wr-btn-done'));
  assert.ok(mainBtnA, '达标后主按钮应是 wr-btn-done（绿色）');
  assert.strictEqual(mainBtnA.props.disabled, true, '达标后主按钮应不可点');

  // 点「继续打卡」→ 弹出输入面板，留空即「一直打卡」
  clickButton(panelComp, {}, '继续打卡');
  await settle(panelComp, {}, 2);
  const treeB = renderTree(panelComp);
  const txtB = flattenText(treeB);
  assert.ok(txtB.includes('继续打卡多久'), '点「继续打卡」后应询问时长');
  assert.ok(txtB.includes('一直打卡'), '留空时按钮文案应是「一直打卡」');
  const input = findNode(treeB, (n) => n.type === 'input'
    && typeof n.props?.placeholder === 'string'
    && n.props.placeholder.includes('留空'));
  assert.ok(input, '应有可输入的时长输入框');

  // 不输入直接点「一直打卡」→ 请求 unlimited 模式
  requested.length = 0;
  const btnGo = findNode(treeB, (n) => n.type === 'button'
    && flattenText(n).includes('一直打卡') && typeof n.props?.onClick === 'function');
  assert.ok(btnGo, '应有「一直打卡」按钮');
  btnGo.props.onClick();
  await settle(panelComp, {}, 6);
  assert.ok(requested.some((u) => u.endsWith('/checkin')), '「一直打卡」应发起 checkin 请求');

  // 输入 30 分钟 → 按钮变「开始」
  clickButton(panelComp, {}, '继续打卡');
  await settle(panelComp, {}, 2);
  const treeC = renderTree(panelComp);
  const inputC = findNode(treeC, (n) => n.type === 'input'
    && typeof n.props?.placeholder === 'string'
    && n.props.placeholder.includes('留空'));
  assert.ok(inputC, '重新打开后应仍有输入框');
  inputC.props.onChange({ target: { value: '30' } });
  await settle(panelComp, {}, 2);
  const txtC = flattenText(renderTree(panelComp));
  assert.ok(txtC.includes('开始'), '填了时长后按钮应变成「开始」');
  assert.ok(txtC.includes('60 次') || txtC.includes('约'), '应提示将要上报的次数');
  console.log('✓ 继续打卡 → 时长输入面板 + 留空「一直打卡」+ 填值「开始」');
}

// 11) 无限模式进行中：按钮变「停止」且可点
{
  const dash = responses.dashboard;
  const originalProgress = dash.progress;
  // 先让 checkin 挂起，点「继续打卡 → 一直打卡」把无限模式启动起来。
  // 注意：不能先改 progress.phase='reporting' —— 那样「继续打卡」按钮会因为
  // running=true 而消失（真实场景里 phase 也只有真在跑时才是 reporting）。
  pendingHolds.add('checkin');
  clickButton(panelComp, {}, '继续打卡');
  await settle(panelComp, {}, 2);
  const treeAsk = renderTree(panelComp);
  const btnGo = findNode(treeAsk, (n) => n.type === 'button'
    && flattenText(n).includes('一直打卡') && typeof n.props?.onClick === 'function');
  assert.ok(btnGo, '应能找到「一直打卡」按钮');
  // 假后端此时报告「正在跑无限打卡」，点完按钮触发的 refresh() 就会读到它
  dash.progress = {
    done: 12, total: 0, startedAt: Date.now(), todayBefore: 1230,
    todaySec: 1230, phase: 'reporting', unlimited: true, targetMinutes: 0,
  };
  btnGo.props.onClick();
  await tick();
  await tick();
  await tick();

  const tree = renderTree(panelComp);
  const txt = flattenText(tree);
  // v1.1.3 起：停止入口挂在「继续打卡」按钮上；v1.1.9 起文案简化成「停止打卡」，
  // 用时只留一处（上方状态行），避免同一屏把「已运行 N 分钟」说三遍。
  assert.ok(txt.includes('停止打卡'), '无限模式进行中，应出现「停止打卡」，实际: ' + txt.slice(0, 140));
  assert.ok(txt.includes('已运行'), '运行时应显示「已运行 X 分钟」，不显示上报次数');
  const runTimeCount = (txt.match(/已运行/g) ?? []).length;
  assert.strictEqual(runTimeCount, 1, `「已运行」只该出现一次（状态行），实际 ${runTimeCount} 次: ` + txt.slice(0, 200));
  assert.ok(!/\d+\s*次上报中/.test(txt), '不应再显示「N 次上报中」');
  assert.ok(!txt.includes('持续打卡中'), '旧的「持续打卡中」文案应已移除');
  // 主按钮（今日状态位）此时必须仍是绿色达标、不可点，且不随运行变化
  const mainBtn = findNode(tree, (n) => n.type === 'button'
    && typeof n.props?.className === 'string'
    && n.props.className.includes('wr-btn-done'));
  assert.ok(mainBtn, '达标后主按钮应保持绿色 wr-btn-done');
  assert.strictEqual(mainBtn.props.disabled, true, '达标主按钮应不可点（它是状态展示位）');
  assert.ok(flattenText(mainBtn).includes('今日已达标'), '主按钮文案应仍是「今日已达标」');
  // 停止按钮：灰色外观但可点
  const stopBtn = findNode(tree, (n) => n.type === 'button'
    && typeof n.props?.className === 'string'
    && n.props.className.includes('wr-btn-run')
    && flattenText(n).includes('停止打卡'));
  assert.ok(stopBtn, '应渲染「停止打卡」按钮（wr-btn-run）');
  assert.notStrictEqual(stopBtn.props.disabled, true, '停止按钮必须可点');
  assert.ok(typeof stopBtn.props.onClick === 'function', '停止按钮应绑定 onClick');

  // 点停止 → 请求 /stop
  requested.length = 0;
  stopBtn.props.onClick();
  await settle(panelComp, {}, 4);
  assert.ok(requested.some((u) => u.endsWith('/stop')), '点停止应请求 /stop 接口');
  pendingHolds.delete('checkin');
  dash.progress = originalProgress;
  console.log('✓ 无限模式 → 按钮变「停止打卡」可点，点击请求 /stop');
}

// 12) 回归：dashboard 读失败时，界面仍必须能停止（运行状态来自 status）
{
  const dash = responses.dashboard;
  const st = responses.status;
  const originalDash = dash.progress;
  const originalSt = { ...st };
  // 模拟：打卡在跑，但读阅读数据失败了（readDashboard 要并行拉 3 个远端接口）
  dash.progress = undefined;
  st.progress = {
    done: 5, total: 0, startedAt: Date.now(), todayBefore: 1230,
    todaySec: 1230, phase: 'reporting', unlimited: true, targetMinutes: 0,
  };
  await settle(panelComp, {}, 4);
  const tree12 = renderTree(panelComp);
  // 断言用按钮节点而不是整页文本：整页会带上其他卡片的字，容易误判
  const stopBtn = findNode(tree12, (n) => n.type === 'button'
    && typeof n.props?.className === 'string'
    && n.props.className.includes('wr-btn-run')
    && flattenText(n).includes('停止打卡'));
  assert.ok(
    stopBtn,
    'dashboard 丢 progress 时仍应按 status 显示「停止打卡」，实际按钮文案: '
      + collectAllClasses(tree12).filter((c) => c.includes('wr-btn')).join(' | '),
  );
  assert.notStrictEqual(stopBtn.props.disabled, true, '停止按钮必须可点');
  dash.progress = originalDash;
  Object.assign(st, originalSt);
  await settle(panelComp, {}, 2);
  console.log('✓ dashboard 失败兜底 → 仍从 status 认出「在跑」，停止入口不消失');
}

// 13) 历史拉取失败：不能死循环重拉，必须停在「错误 + 重试」上，点重试能恢复
{
  // 把日历组件从 hook 表里摘掉 = 模拟「刚打开面板、还没有任何历史缓存」
  const calComp = [...stores.keys()].find((k) => k.name === 'CalendarCard');
  assert.ok(calComp, '没找到 CalendarCard 组件');
  stores.delete(calComp);
  mountDeep(renderTree(panelComp));

  // 只让第一次 history 请求失败
  requested.length = 0;
  onceFailures.set('history', { ok: false, reason: '网络开小差了' });
  clickButton(panelComp, {}, '‹');
  await settle(panelComp, {}, 8);

  const historyCalls = requested.filter((u) => u.endsWith('/history')).length;
  assert.strictEqual(historyCalls, 1, `失败后不该自动重拉，实际请求了 ${historyCalls} 次`);
  const failTxt = flattenText(renderTree(panelComp));
  assert.ok(failTxt.includes('网络开小差了'), '拉取失败应把原因显示出来，实际: ' + failTxt.slice(0, 160));
  assert.ok(failTxt.includes('重试'), '拉取失败应给出「重试」按钮');
  // 关键：失败时绝不能把上一周画成「未读」红——没数据 ≠ 没读书
  const failCells = collectCells(renderTree(panelComp));
  assert.strictEqual(
    failCells.filter((c) => c.cls.includes('wr-cal-red-0')).length,
    0,
    '没有历史数据时不该画出任何「未读」红格',
  );
  console.log('✓ 历史拉取失败 → 只请求 1 次（不死循环），显示原因与重试，且不伪造「未读」红');

  // 点重试 → 这次成功，上一周按真实秒数上色
  clickButton(panelComp, {}, '重试');
  await settle(panelComp, {}, 8);
  const okCells = new Map(collectCells(renderTree(panelComp)).map((c) => [c.date, c.cls]));
  for (const d of LAST_WEEK) {
    const cls = okCells.get(d);
    assert.ok(cls, `重试成功后应画出 ${d}`);
    assert.ok(cls.includes('wr-cal-ok-'), `重试成功后 ${d} 应达标上绿，class=${cls}`);
  }
  assert.ok(!flattenText(renderTree(panelComp)).includes('网络开小差了'), '重试成功后错误提示应消失');
  console.log('✓ 点重试 → 重新拉取成功，上一周恢复真实颜色，错误提示消失');
}

// 14) v1.1.9：次数≠分钟；状态行与主按钮不重复；跨天「上次运行」带日期；死 CSS 清干净
{
  const dash = responses.dashboard;
  const st = responses.status;
  const savedDash = { progress: dash.progress, lastRunAt: dash.lastRunAt };
  const savedSt = { progress: st.progress, lastRunAt: st.lastRunAt };

  // 8 次上报 = 4 分钟；total 20 次 = 10 分钟。旧代码会把「20 次」当「20 分钟」显示。
  // 今日读数压到 10 分钟（< 目标 20），否则 reached 会顶掉主按钮里的「本次补 N 分钟」。
  const savedTodaySec = dash.today.sec;
  dash.today = { ...dash.today, sec: 600 };
  dash.progress = {
    done: 8, total: 20, startedAt: Date.now(), todayBefore: 600,
    todaySec: 600, phase: 'reporting', unlimited: false, targetMinutes: 10,
  };
  await settle(panelComp, {}, 4);
  const runTxt = flattenText(renderTree(panelComp));
  assert.ok(runTxt.includes('本次补 10 分钟'), '20 次上报应换算成「本次补 10 分钟」，实际: ' + runTxt.slice(0, 240));
  assert.ok(!runTxt.includes('本次补 20 分钟'), '不能把上报次数直接当分钟数');
  assert.ok(runTxt.includes('已运行 4 分钟'), '8 次上报应显示「已运行 4 分钟」，实际: ' + runTxt.slice(0, 240));
  const dup = (runTxt.match(/已运行/g) ?? []).length;
  assert.strictEqual(dup, 1, `「已运行」只该在状态行出现一次，实际 ${dup} 次: ` + runTxt.slice(0, 240));
  console.log('✓ 次数→分钟换算 + 文案不重复 →', /已运行 \S+ 分钟/.exec(runTxt)?.[0], '/', /本次补 \S+ 分钟/.exec(runTxt)?.[0]);

  dash.today = { ...dash.today, sec: savedTodaySec };

  // 跨天的「上次运行」必须带 MM-DD，不能把前天的 23:40 显示成今天
  dash.progress = savedDash.progress;
  const oldTs = new Date(2026, 9, 30, 23, 40).getTime();
  dash.lastRunAt = oldTs;
  st.lastRunAt = oldTs;
  await settle(panelComp, {}, 4);
  const lastTxt = flattenText(renderTree(panelComp));
  assert.ok(lastTxt.includes('上次运行'), '跑过之后应显示「上次运行」');
  assert.ok(lastTxt.includes('10-30 23:40'), '跨天的上次运行应显示「10-30 23:40」，实际: ' + lastTxt.slice(0, 240));

  // 今天跑的仍只显示 HH:MM
  const nowTs = Date.now();
  dash.lastRunAt = nowTs;
  st.lastRunAt = nowTs;
  await settle(panelComp, {}, 4);
  const pad2t = (n) => String(n).padStart(2, '0');
  const nowHm = `${pad2t(new Date(nowTs).getHours())}:${pad2t(new Date(nowTs).getMinutes())}`;
  const todayTxt = flattenText(renderTree(panelComp));
  assert.ok(todayTxt.includes(nowHm), `当天应显示 HH:MM（${nowHm}），实际: ` + todayTxt.slice(0, 240));
  assert.ok(!new RegExp(`\\d{2}-\\d{2} ${nowHm}`).test(todayTxt), '当天不该再带 MM-DD 前缀');
  console.log('✓ 「上次运行」跨天带日期、当天只显示 HH:MM →', nowHm);

  const css = styleTags[0].textContent;
  for (const dead of ['.wr-bar-col', '.wr-bar-today', '.wr-book-cover', '.wr-book-title', '.wr-mono', '.wr-btn-stop']) {
    assert.ok(!css.includes(dead), `${dead} 已无任何使用处，不该还留在 CSS 里`);
  }
  console.log('✓ 死 CSS 已清理（周柱状 / 旧书列表 / .wr-mono / .wr-btn-stop）');

  dash.progress = savedDash.progress;
  dash.lastRunAt = savedDash.lastRunAt;
  st.progress = savedSt.progress;
  st.lastRunAt = savedSt.lastRunAt;
  await settle(panelComp, {}, 2);
}

// 15) v1.2.0 阅读画像 + v1.3.0 笔记：都要懒加载，点开才请求
{
  assert.ok(
    !requested.some((u) => u.endsWith('/profile')),
    '阅读画像不该在进界面时就请求（首屏已经有 dashboard 在并行拉三次）',
  );
  assert.ok(
    !requested.some((u) => u.endsWith('/notebooks')),
    '笔记不该在进界面时就请求',
  );

  // —— 画像：点「分析阅读画像」才拉 ——
  clickButton(panelComp, {}, '分析阅读画像');
  await settle(panelComp, {}, 6);
  assert.ok(requested.some((u) => u.endsWith('/profile')), '点了按钮应请求 /profile');
  const pTxt = flattenText(renderTree(panelComp));
  assert.ok(pTxt.includes('阅读画像'), '画像卡标题应出现，实际: ' + pTxt.slice(0, 200));
  /*
   * 峰值小时 = 15 是刻意的：服务端已经把 preferTime 从「6 点起」重排成「0 点起」，
   * 前端若再位移一次就会显示成 21 点。这条断言同时锁住两端不要重复位移。
   */
  assert.ok(pTxt.includes('最常在 15 点'), '峰值小时应直接显示 15 点，不许再位移 +6，实际: ' + pTxt.slice(0, 300));
  assert.ok(pTxt.includes('偏好下午与夜晚阅读'), '应显示官方给的时间偏好文案');
  assert.ok(pTxt.includes('男生小说'), '应显示偏好分类');
  assert.ok(pTxt.includes('余华'), '应显示常读作者');
  assert.ok(pTxt.includes('阅读 10 本神作'), '应显示勋章');
  const pCls = collectAllClasses(renderTree(panelComp)).join(' ');
  assert.ok(pCls.includes('wr-hours'), '时段分布应有 .wr-hours 容器');
  assert.ok(pCls.includes('wr-rank-track'), '偏好分类应有排行条');
  // 24 根柱子，一根不能少（有些小时读数为 0，但柱子本身要在，否则 0 点那根会消失错位）
  const barCount = collectAllClasses(renderTree(panelComp)).filter((c) => c.startsWith('wr-hours-bar')).length;
  assert.strictEqual(barCount, 24, `时段分布应有 24 根柱子，实际 ${barCount}`);
  assert.ok(pCls.includes('wr-hours-bar-peak'), '峰值那根柱子要高亮');
  console.log('✓ 阅读画像 → 24 根时段柱 + 峰值高亮 + 分类排行 + 作者 + 勋章');

  // —— 笔记：点「查看我的笔记」才拉列表 ——
  clickButton(panelComp, {}, '查看我的笔记');
  await settle(panelComp, {}, 6);
  assert.ok(requested.some((u) => u.endsWith('/notebooks')), '点了按钮应请求 /notebooks');
  const nTxt = flattenText(renderTree(panelComp));
  assert.ok(nTxt.includes('笔记与划线'), '笔记卡标题应出现，实际: ' + nTxt.slice(0, 200));
  assert.ok(nTxt.includes('来自 2 本书'), '应显示来源书籍数，实际: ' + nTxt.slice(0, 300));
  assert.ok(nTxt.includes('活着') && nTxt.includes('囚徒健身'), '应列出两本书');

  // 展不开的时候不该提前拉任何一本书的划线
  assert.ok(
    !requested.some((u) => u.endsWith('/bookmarks')),
    '列表刚出来时不该预取任何书的划线原文',
  );

  // —— 点某本书才拉那本的划线 ——
  clickButton(panelComp, {}, '活着');
  await settle(panelComp, {}, 6);
  assert.ok(requested.some((u) => u.endsWith('/bookmarks')), '点开某本书应请求 /bookmarks');
  const mTxt = flattenText(renderTree(panelComp));
  assert.ok(
    mTxt.includes('我知道黄昏正在转瞬即逝'),
    '应显示划线原文，实际: ' + mTxt.slice(0, 400),
  );
  assert.ok(mTxt.includes('五'), '应显示划线所属章节');
  console.log('✓ 笔记与划线 → 两级懒加载 + 划线原文与章节');

  // —— 「有笔记数但没有划线」要说清是想法，不能显示成空 ——
  const savedBookmarks = responses.bookmarks;
  responses.bookmarks = { ok: true, bookId: '750578', title: '囚徒健身', author: '保罗·威德', total: 0, marks: [] };
  clickButton(panelComp, {}, '囚徒健身');
  await settle(panelComp, {}, 6);
  const tTxt = flattenText(renderTree(panelComp));
  assert.ok(
    tTxt.includes('想法'),
    '划线为空时应说明「那些条数是想法，不是划线」，实际: ' + tTxt.slice(0, 400),
  );
  responses.bookmarks = savedBookmarks;
  console.log('✓ 有笔记无划线 → 提示是「想法」而非空列表');

  // 新卡片用的类必须在样式表里，且必须走主题令牌
  const css2 = styleTags[0].textContent;
  for (const cls of ['.wr-hours', '.wr-rank', '.wr-note-row', '.wr-mark']) {
    assert.ok(css2.includes(cls), `样式缺少 ${cls}`);
  }
  console.log('✓ 新卡片样式齐全');
}

console.log('\n请求过的接口:', [...new Set(requested.map((u) => u.split('/').pop()))].join(', '));
console.log('全部通过 ✅');

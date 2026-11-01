/**
 * 离线模拟浏览器半边：伪造 window.__ModuleLoader__ / React / document / fetch，
 * 执行 client.js 的 factory，调用 apply(ctx)，再用真实数据渲染各组件。
 *
 * 关键：模拟器给每个组件实例分配独立的 hook 槽位并跨多次渲染保留，
 * 这样异步 setData 之后的「有数据」渲染也能被验证到。
 */
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const src = await readFile('D:/DSH工作区/dsh-weread-checkin/client.js', 'utf8');

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

// ---------- 假后端 ----------
const responses = {
  status: {
    ok: true, configured: true, hasCookie: true, hasBase: true, baseFromBuiltin: true,
    canVerify: true, running: false, lastRunAt: 0, lastDay: '2026-10-31', lastDone: 20, lastErrors: [],
    minutes: 10, goalMinutes: 20, autoTime: '08:30', today: '2026-10-31', lastDayDone: true, lastFail: '',
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
  // v0.3.0 日历历史（2026-01-01 起）
  history: {
    ok: true, months: 11, goalMinutes: 20, checkedDays: 17, totalSec: 91452,
    series: (() => {
      const out = [];
      const start = new Date(2026, 0, 1);
      for (let i = 0; i < 305; i += 1) {
        const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        out.push({ date: ymd, sec: i % 5 === 0 ? 1800 : (i % 3 === 0 ? 420 : 0) });
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
  dashboard: {
    ok: true, configured: true, autoTime: '08:30', minutes: 10, goalMinutes: 20, lastDayDone: true, lastRunAt: Date.now(), lastFail: '',
    progress: { done: 0, total: 0, startedAt: 0, todayBefore: 0, todaySec: null, phase: 'idle' },
    today: { date: '2026-10-31', sec: 1230, min: 20.5, reached: true, threshold: 300 },
    week: {
      start: '2026-10-26', end: '2026-11-01', totalSec: 15376, checkedDays: 3, compare: -0.2746,
      series: Array.from({ length: 7 }, (_, i) => ({ date: `2026-10-${26 + i}`, sec: [2100, 3400, 900, 0, 4400, 3800, 0][i] })),
      topBooks: [
        { title: '绍宋', author: '', sec: 14641, cover: '' },
        { title: '三体全集（全三册）', author: '刘慈欣', sec: 490, cover: 'https://example.com/c.jpg' },
      ],
    },
    month: {
      year: 2026, month: 10, firstWeekday: 4, daysInMonth: 31, checkedDays: 5, totalSec: 40108,
      series: Array.from({ length: 31 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, sec: i % 3 === 0 ? 900 : 0 })),
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
async function fakeFetch(url) {
  requested.push(url);
  const method = String(url).split('/').pop();
  if (pendingHolds.has(method)) {
    // 永不 resolve，让 busy 一直保持 true
    await new Promise(() => {});
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
assert.ok(txt.includes('绍宋'), '本周最多应显示书名');
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

// 7) 日历：默认周视图，点「月」才请求 history，并渲染 2026-01 起的历史
{
  assert.ok(!requested.some((u) => u.endsWith('/history')), '进界面不该预取 history（应按点击取数）');
  clickButton(panelComp, {}, '月');
  await settle(panelComp, {}, 6);
  assert.ok(requested.some((u) => u.endsWith('/history')), '切到月视图后应请求 history');
  // 当前是 11 月 1 日，本月只有 1 格；退回上个月（10 月）才能看到齐备的绿/红
  clickButton(panelComp, {}, '‹');
  await settle(panelComp, {}, 3);
  const tree = renderTree(panelComp);
  const txt2 = flattenText(tree);
  assert.ok(txt2.includes('年') && txt2.includes('月'), '月视图应显示年月标题');
  const cells = collectAllClasses(tree).filter((c) => c.includes('wr-cal-cell'));
  assert.ok(cells.some((c) => c.includes('wr-cal-ok-')), '达标日应上绿色');
  assert.ok(cells.some((c) => c.includes('wr-cal-red-')), '未达标日应上红色');
  console.log('✓ 日历月视图 → 请求 history，绿/红达标色齐备，格子数', cells.length);
}

// 8) 书架：默认展开并预取，展示封面网格（默认裁到两排）
{
  assert.ok(requested.some((u) => u.endsWith('/shelf')), '书架默认展开，进界面就该请求 shelf');
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
  console.log('✓ 书架默认展开 → 封面网格 + 两排裁切', hasAllBtn ? '+ 全部展开' : '(假数据 <8 本)');
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
  assert.ok(css.includes('.wr-btn-stop'), '缺少「停止」按钮样式');
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
  dash.progress = {
    done: 12, total: 0, startedAt: Date.now(), todayBefore: 1230,
    todaySec: 1230, phase: 'reporting', unlimited: true, targetMinutes: 0,
  };
  // Panel 里存的是上次 refresh() 的快照，改完假后端要再点一次按钮把数据拉回来。
  // 用「继续打卡 → 一直打卡」这条路正好也会触发 fire('checkin') → refresh()。
  // 同时把 checkin 挂起，让 busy 保持 true，这才符合「正在跑」的真实状态。
  pendingHolds.add('checkin');
  clickButton(panelComp, {}, '继续打卡');
  await settle(panelComp, {}, 2);
  const treeAsk = renderTree(panelComp);
  const btnGo = findNode(treeAsk, (n) => n.type === 'button'
    && flattenText(n).includes('一直打卡') && typeof n.props?.onClick === 'function');
  assert.ok(btnGo, '应能找到「一直打卡」按钮');
  btnGo.props.onClick();
  await tick();
  await tick();

  const tree = renderTree(panelComp);
  const txt = flattenText(tree);
  assert.ok(txt.includes('停止打卡'), '无限模式进行中，按钮应是「停止打卡」，实际: ' + txt.slice(0, 120));
  assert.ok(txt.includes('持续打卡中'), '应提示正在持续打卡');
  const stopBtn = findNode(tree, (n) => n.type === 'button'
    && typeof n.props?.className === 'string'
    && n.props.className.includes('wr-btn-stop'));
  assert.ok(stopBtn, '应渲染 wr-btn-stop 停止按钮');
  assert.strictEqual(stopBtn.props.disabled, false, '停止按钮必须可点');
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

console.log('\n请求过的接口:', [...new Set(requested.map((u) => u.split('/').pop()))].join(', '));
console.log('全部通过 ✅');

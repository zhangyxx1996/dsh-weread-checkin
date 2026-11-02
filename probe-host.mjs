/**
 * 在没有 Host 的情况下直接调用 index.js 的 apply()，验证各接口的真实返回。
 *
 * 用假的 ctx 提供 tools/commands/webServer，这样能跑通注册路径，
 * 也顺带确认 inject 声明的服务确实用得上。
 *
 * 用法：node probe-host.mjs
 */
import { readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mod = await import('./index.js');

/**
 * 状态文件必须用临时文件，**不能指向真实的 ~/.dsh/weread-state.json**。
 *
 * 理由：下面会依次调用 setupAuto / setupMinutes / setupGoal 做校验，
 * 每次成功都会 save() 落盘。如果指向真实文件，跑一次回归就会把用户
 * 真实的「自动打卡时间（如 04:00）」「打卡时长 60」「每日目标 60」
 * 全部改成脚本里的测试值（结尾只恢复成 10，不是原值），自动打卡直接失效。
 */
const stateFile = join(tmpdir(), `weread-probe-host-${process.pid}.json`);

// 假的 ctx：把注册的东西收集起来
const registered = {};
const ctx = {
  tools: { register: (def) => { registered.tool = def; return () => {}; } },
  commands: { register: (def) => { registered.command = def; return () => {}; } },
  webServer: {
    register: (def) => {
      registered.route = def;
      return () => {};
    },
  },
  effect: (fn) => {
    const dispose = fn();
    return () => dispose?.();
  },
};

mod.apply(ctx, { stateFile });
await new Promise((r) => setTimeout(r, 300));

console.log('inject =', mod.inject);
console.log('tool registered =', Boolean(registered.tool), registered.tool?.name);
console.log('command registered =', Boolean(registered.command), registered.command?.name);
console.log('route registered =', Boolean(registered.route), registered.route?.path);

// 直接用 route handler 跑接口，绕过 HTTP
function invoke(method, body = {}) {
  return new Promise((resolve, reject) => {
    const req = {
      method: 'POST',
      url: `/weread/api/${method}`,
      async *[Symbol.asyncIterator]() {
        if (body) yield Buffer.from(JSON.stringify(body), 'utf8');
      },
    };
    const res = {
      statusCode: 0,
      headers: null,
      body: '',
      writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
      end(text) { this.body = text ?? ''; resolve({ code: this.statusCode, json: safe(text) }); },
    };
    try {
      registered.route.handler(req, res).catch(reject);
    } catch (e) { reject(e); }
  });
}
function safe(t) { try { return JSON.parse(t); } catch { return t; } }

const st = await invoke('status');
console.log('\n=== status ===');
console.log(JSON.stringify(st.json, null, 2));

const dash = await invoke('dashboard');
console.log('\n=== dashboard ===');
const dj = dash.json;
if (dj.ok) {
  console.log('today:', JSON.stringify(dj.today));
  console.log('week.series:', dj.week.series.length, '根柱子；checkedDays=', dj.week.checkedDays);
  console.log('week.topBooks:', dj.week.topBooks.map((b) => b.title).join(' / '));
  console.log('month:', dj.month.year, dj.month.month, 'firstWeekday=', dj.month.firstWeekday, 'days=', dj.month.daysInMonth, 'series=', dj.month.series.length);
  console.log('overall:', JSON.stringify(dj.overall));
  console.log('configured:', dj.configured, 'autoTime:', JSON.stringify(dj.autoTime), 'minutes:', dj.minutes);
} else {
  console.log(JSON.stringify(dj, null, 2));
}

console.log('\n=== setupAuto 校验 ===');
console.log('非法 25:00 →', JSON.stringify((await invoke('setupAuto', { autoTime: '25:00' })).json));
console.log('非法 abc   →', JSON.stringify((await invoke('setupAuto', { autoTime: 'abc' })).json));
console.log('合法 08:30 →', JSON.stringify((await invoke('setupAuto', { autoTime: '08:30' })).json));
console.log('读回 status.autoTime →', (await invoke('status')).json.autoTime);
console.log('关闭 →', JSON.stringify((await invoke('setupAuto', { autoTime: '' })).json));
console.log('读回 status.autoTime →', JSON.stringify((await invoke('status')).json.autoTime));

console.log('\n=== setupMinutes 校验（v0.2.0 新增） ===');
console.log('非法 0     →', JSON.stringify((await invoke('setupMinutes', { minutes: 0 })).json));
console.log('非法 -5    →', JSON.stringify((await invoke('setupMinutes', { minutes: -5 })).json));
console.log('非法 200   →', JSON.stringify((await invoke('setupMinutes', { minutes: 200 })).json));
console.log('合法 15    →', JSON.stringify((await invoke('setupMinutes', { minutes: 15 })).json));
console.log('读回 status.minutes →', (await invoke('status')).json.minutes);
console.log('读回 dashboard.minutes →', (await invoke('dashboard')).json.minutes);
console.log('小数 7.3   →', JSON.stringify((await invoke('setupMinutes', { minutes: 7.3 })).json));
console.log('恢复 10    →', JSON.stringify((await invoke('setupMinutes', { minutes: 10 })).json));

console.log('\n=== badge 三色判定（v0.2.0 新增） ===');
const bd = (await invoke('badge')).json;
console.log(JSON.stringify(bd));
console.log('level 是三者之一:', ['green', 'yellow', 'red'].includes(bd.level));

console.log('\n=== setupGoal 校验（v0.3.0 新增） ===');
console.log('非法 0     →', JSON.stringify((await invoke('setupGoal', { goalMinutes: 0 })).json));
console.log('非法 9999  →', JSON.stringify((await invoke('setupGoal', { goalMinutes: 9999 })).json));
console.log('合法 20    →', JSON.stringify((await invoke('setupGoal', { goalMinutes: 20 })).json));
console.log('读回 status.goalMinutes →', (await invoke('status')).json.goalMinutes);
console.log('读回 dashboard.goalMinutes →', (await invoke('dashboard')).json.goalMinutes);
const bd2 = (await invoke('badge')).json;
console.log('目标改成 20 后 badge.level →', bd2.level, '| reason:', bd2.reason);
console.log('恢复 10    →', JSON.stringify((await invoke('setupGoal', { goalMinutes: 10 })).json));

console.log('\n=== history 历史日级序列（v0.3.0 新增） ===');
const hs = (await invoke('history')).json;
if (hs.ok) {
  console.log('天数:', hs.series.length, '月数:', hs.months);
  console.log('首日:', JSON.stringify(hs.series[0]), '末日:', JSON.stringify(hs.series.at(-1)));
  console.log('达标天数:', hs.checkedDays, '合计:', (hs.totalSec / 3600).toFixed(1), 'h', 'goalMinutes:', hs.goalMinutes);
  let gap = 0;
  for (let i = 1; i < hs.series.length; i += 1) {
    const prev = new Date(hs.series[i - 1].date);
    const cur = new Date(hs.series[i].date);
    if (Math.round((cur - prev) / 86400000) !== 1) gap += 1;
  }
  console.log('日期连续缺口（应为 0）:', gap);
  console.log('是否有 2026-01-01:', hs.series[0].date === '2026-01-01');
} else {
  console.log(JSON.stringify(hs));
}

console.log('\n=== shelf 书架（v0.3.0 新增） ===');
const sh = (await invoke('shelf')).json;
if (sh.ok) {
  console.log(`总数 ${sh.total}（电子书 ${sh.bookCount} + 有声书 ${sh.albumCount} + 文章收藏 ${sh.hasMp ? 1 : 0}）`);
  console.log(`覆盖率 ${sh.coveredCount}/${sh.bookCount}，今年合计 ${(sh.yearTotalSec / 3600).toFixed(1)}h`);
  for (const b of [...sh.books].sort((a, b) => (b.yearSec ?? -1) - (a.yearSec ?? -1)).slice(0, 5)) {
    console.log(`  ${b.title} | ${b.author} | 今年 ${b.yearSec === null ? '无记录' : (b.yearSec / 3600).toFixed(1) + 'h'} | 读完 ${b.finished}`);
  }
} else {
  console.log(JSON.stringify(sh));
}

console.log('\n=== profile 阅读画像（v1.2.0 新增） ===');
const pf = (await invoke('profile')).json;
if (pf.ok) {
  /*
   * 24 桶断言：服务端必须已把 preferTime 从「6 点起」重排成「0 点起」。
   * 如果哪天有人把位移挪回前端，这里 hours[0] 就会变回 6 点的数。
   */
  console.log('hours 桶数（应为 24）:', pf.hours.length);
  console.log('hours 前 3 项（0/1/2 点）:', pf.hours.slice(0, 3), '后 3 项（21/22/23 点）:', pf.hours.slice(-3));
  console.log('合计:', (pf.hourTotalSec / 3600).toFixed(1), 'h | 峰值小时:', pf.peakHour, '点');
  console.log('timeWord:', pf.timeWord, '| categoryWord:', pf.categoryWord);
  console.log('分类:', pf.categories.map((c) => `${c.title}(${(c.sec / 3600).toFixed(1)}h/${c.count}本)`).join(' / '));
  console.log('作者数:', pf.authorCount, '| 前 3:', pf.authors.slice(0, 3).map((a) => `${a.name} ${a.readTime}`).join(' / '));
  console.log('勋章:', pf.medals.length, '枚 | 第 1 枚:', JSON.stringify(pf.medals[0]));
} else {
  console.log(JSON.stringify(pf));
}

console.log('\n=== notebooks 笔记列表（v1.3.0 新增） ===');
const nb = (await invoke('notebooks')).json;
if (nb.ok) {
  console.log(`${nb.totalBookCount} 本有笔记，官方 totalNoteCount=${nb.totalNoteCount}，自行累加=${nb.noteTotal}，truncated=${nb.truncated}`);
  // 两个口径必须一致，否则说明 noteCount 的合并算法漏了某一类
  console.log('两个口径一致:', nb.totalNoteCount === nb.noteTotal);
  for (const b of nb.books.slice(0, 5)) {
    console.log(`  ${b.title} | ${b.author} | ${b.noteCount} 条 (raw=${JSON.stringify(b.raw)}) | 最近 ${new Date(b.lastAt).toISOString().slice(0, 10)}`);
  }
  console.log('按最近时间降序:', nb.books.every((b, i) => i === 0 || nb.books[i - 1].lastAt >= b.lastAt));

  console.log('\n=== bookmarks 单本划线（v1.3.0 新增） ===');
  /*
   * 不能用 books[0]：笔记本列表按「最近笔记时间」排序，排第一的那本
   * 很可能整本都是「想法」（raw=[0,N,0]），bookmarklist 会返回 0 条，
   * 于是「划线功能是否真的能取到内容」这件事根本没被验证。
   * 所以挑 raw[0] > 0（有 bookmarkCount）的那本来测。
   */
  const withMarks = nb.books.find((b) => (b.raw?.[0] ?? 0) > 0) ?? nb.books.find((b) => b.noteCount > 0);
  console.log('选中的书:', withMarks?.title, 'raw =', JSON.stringify(withMarks?.raw));
  if (withMarks) {
    const bm = (await invoke('bookmarks', { bookId: withMarks.bookId })).json;
    if (bm.ok) {
      console.log(`《${bm.title}》划线 ${bm.total} 条，markCount=${bm.marks.length}`);
      console.log('total 与 marks.length 一致:', bm.total === bm.marks.length);
      for (const m of bm.marks.slice(0, 3)) {
        console.log(`  [${m.chapter || '无章节'}] ${m.text.slice(0, 40)}…`);
      }
      console.log('每条都带章节:', bm.marks.every((m) => typeof m.chapter === 'string' && m.chapter.length > 0));
      console.log('按时间降序:', bm.marks.every((m, i) => i === 0 || bm.marks[i - 1].at >= m.at));
    } else {
      console.log(JSON.stringify(bm));
    }
  }
} else {
  console.log(JSON.stringify(nb));
}

console.log('\n=== bookmarks 参数校验（v1.3.0 新增） ===');
console.log('缺 bookId →', JSON.stringify((await invoke('bookmarks', {})).json));
console.log('空 bookId →', JSON.stringify((await invoke('bookmarks', { bookId: '   ' })).json));
console.log('不存在的书 →', JSON.stringify((await invoke('bookmarks', { bookId: '999999999999' })).json).slice(0, 200));

console.log('\n=== status 的 progress 字段（v0.3.0 新增） ===');
console.log(JSON.stringify((await invoke('status')).json.progress));

// 清掉本次用过的临时状态文件，别在 %TEMP% 里留垃圾
await rm(stateFile, { force: true }).catch(() => {});

process.exit(0);

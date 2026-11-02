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

console.log('\n=== status 的 progress 字段（v0.3.0 新增） ===');
console.log(JSON.stringify((await invoke('status')).json.progress));

// 清掉本次用过的临时状态文件，别在 %TEMP% 里留垃圾
await rm(stateFile, { force: true }).catch(() => {});

process.exit(0);

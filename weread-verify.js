/**
 * 微信读书官方 API 网关：只读查询，用于**验证**打卡是否真的计入时长。
 *
 * 为什么需要它：/web/book/read 返回的 {"succ":1} 只是请求被接受的信号，
 * 并不等于时长已累加。真正的证据是官方 /readdata/detail 里「今日」那个
 * 时间桶的秒数是否增长。这个能力官方只开放给 API Key（wrk- 前缀）。
 *
 * 网关约定（实测）：
 *   POST https://i.weread.qq.com/api/agent/gateway
 *   Authorization: Bearer wrk-xxx
 *   body: { api_name, ...业务参数, skill_version }
 */

const GATEWAY = 'https://i.weread.qq.com/api/agent/gateway';
/** 实测服务端要求的最小版本；过低会回 upgrade_info。 */
const SKILL_VERSION = '1.0.3';

/** 读取 API Key：环境变量优先（用户已在系统里配好）。 */
export function readApiKey(env = process.env) {
  const v = env.WEREAD_API_KEY;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/**
 * 读取 API Key，环境变量不可用时回退到凭据文件里保存的 apiKey。
 *
 * 必要性：Windows 上用户把 Key 写在「用户环境变量」时，已经在运行的
 * Host 进程拿不到它（进程环境在启动时固定），所以设置页也能存一份。
 */
export async function resolveApiKey(readStored) {
  const fromEnv = readApiKey();
  if (fromEnv) return fromEnv;
  try {
    const stored = await readStored();
    const v = stored?.apiKey;
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
  } catch {
    return null;
  }
}

async function callGateway(apiKey, body, signal) {
  const res = await fetch(GATEWAY, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ...body, skill_version: SKILL_VERSION }),
    signal,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // 非 JSON 响应
  }
  return { status: res.status, json, text };
}

/**
 * 本地日期 → "YYYY-MM-DD"。
 * 不能用 toISOString().slice(0,10)：那是 UTC，东八区本地 0 点会退成前一天。
 */
export function ymdLocal(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 当天 0 点的 Unix 时间戳（秒）—— readTimes 的桶 key。 */
export function todayKey(now = new Date()) {
  const d = new Date(now.getTime());
  d.setHours(0, 0, 0, 0);
  return String(Math.floor(d.getTime() / 1000));
}

/**
 * 把 readTimes 分桶转成按日期排列的数组（桶 key 是当天 0 点秒级时间戳）。
 * 服务端只在有记录的日子给桶，这里补齐整段区间，方便前端直接画日历。
 */
export function toDailySeries(readTimes, { fromDate, toDate } = {}) {
  const map = readTimes ?? {};
  const start = fromDate ? new Date(fromDate) : null;
  const end = toDate ? new Date(toDate) : null;
  if (!start || !end) {
    return Object.entries(map)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([k, sec]) => ({ date: new Date(Number(k) * 1000), sec }));
  }
  const out = [];
  const cur = new Date(start.getTime());
  cur.setHours(0, 0, 0, 0);
  const last = new Date(end.getTime());
  last.setHours(0, 0, 0, 0);
  while (cur <= last) {
    const key = String(Math.floor(cur.getTime() / 1000));
    out.push({ date: new Date(cur.getTime()), sec: map[key] ?? 0 });
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

/** 服务端口径：当日有效阅读满 5 分钟记为一个打卡天。 */
export const CHECKIN_THRESHOLD_SEC = 300;

/** 历史数据最早可查日期（产品要求：从 2026-01-01 起）。 */
export const HISTORY_FLOOR = { year: 2026, month: 1, day: 1 };

/** ymdLocal 的反向：'YYYY-MM-DD' → 本地 0 点的 Date。 */
export function parseYmd(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ''));
  if (!m) return null;
  const [, y, mo, d] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d));
}

/**
 * 逐月拉取，拼出 [2026-01-01, 今天] 的完整日级序列。
 *
 * 为什么必须逐月：annually 模式不返回 dailyReadTimes（实测 2026 年返回
 * readTimes 12 个月桶 + dailyReadTimes 缺失），拿不到日级明细；
 * 而 monthly 的 readTimes 是按天分桶的，只有逐月拉才能拼出日历。
 * 每月一次调用，11 个月约 2.4 秒，且只在用户切换月历/周历时才拉。
 *
 * @param {string} apiKey
 * @param {{from?: {year:number,month:number,day:number}, to?: Date, signal?: AbortSignal}} opts
 * @returns {Promise<{ok:boolean, series?: Array<{date:string, sec:number}>, months?: number, reason?: string}>}
 */
export async function readHistory(apiKey, { from = HISTORY_FLOOR, to = new Date(), signal } = {}) {
  if (!apiKey) return { ok: false, reason: '未配置 WEREAD_API_KEY' };
  const start = new Date(from.year, from.month - 1, from.day);
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  if (start > end) return { ok: true, series: [], months: 0 };

  const jobs = [];
  const cur = new Date(start.getFullYear(), start.getMonth(), 1);
  const lastMonth = new Date(end.getFullYear(), end.getMonth(), 1);
  while (cur <= lastMonth) {
    const base = Math.floor(cur.getTime() / 1000);
    jobs.push(callGateway(apiKey, { api_name: '/readdata/detail', mode: 'monthly', baseTime: base }, signal));
    cur.setMonth(cur.getMonth() + 1);
  }

  const responses = await Promise.all(jobs);
  const merged = new Map();
  let succeeded = 0;
  for (const r of responses) {
    const j = r.json;
    if (j && (j.errcode === undefined || j.errcode === 0)) {
      succeeded += 1;
      for (const [k, v] of Object.entries(j.readTimes ?? {})) merged.set(k, v);
    }
  }
  if (succeeded === 0) {
    return { ok: false, reason: responses[0]?.json?.errmsg || `HTTP ${responses[0]?.status ?? '?'}` };
  }

  const series = [];
  const walk = new Date(start.getTime());
  walk.setHours(0, 0, 0, 0);
  while (walk <= end) {
    const key = String(Math.floor(walk.getTime() / 1000));
    series.push({ date: ymdLocal(walk), sec: merged.get(key) ?? 0 });
    walk.setDate(walk.getDate() + 1);
  }
  return { ok: true, series, months: jobs.length };
}

/**
 * 书架 + 每本书的阅读时长。
 *
 * 难点：/shelf/sync 不带阅读时长，/book/getprogress 的 recordReadingTime
 * 实测全是 0（27 本全 0）。唯一可靠的来源是 /readdata/detail 的 readLongest，
 * 但它只给 top10 且过滤掉 5 分钟以下的条目。
 * 所以策略是：以书架为主体列出全部 27 本，能匹配到 readLongest 的填时长，
 * 匹配不到的显示「暂无记录」，并如实标注覆盖率。
 *
 * @param {string} apiKey
 * @param {{signal?: AbortSignal}} [opts]
 */
export async function readShelf(apiKey, { signal } = {}) {
  if (!apiKey) return { ok: false, reason: '未配置 WEREAD_API_KEY' };
  const now = new Date();

  // 书架 + 今年逐月 readLongest（并集近似每本书的年度阅读时长）
  const shelfJob = callGateway(apiKey, { api_name: '/shelf/sync' }, signal);
  const year = now.getFullYear();
  const monthJobs = [];
  for (let m = 0; m <= now.getMonth(); m += 1) {
    const base = Math.floor(new Date(year, m, 1).getTime() / 1000);
    monthJobs.push(callGateway(apiKey, { api_name: '/readdata/detail', mode: 'monthly', baseTime: base }, signal));
  }
  // 全历史排行，用于补上早年的书
  const overallJob = callGateway(apiKey, { api_name: '/readdata/detail', mode: 'overall' }, signal);

  const [shelfRes, overallRes, ...monthRes] = await Promise.all([shelfJob, overallJob, ...monthJobs]);

  const shelfJson = shelfRes.json;
  if (!shelfJson || (shelfJson.errcode !== undefined && shelfJson.errcode !== 0)) {
    return { ok: false, reason: shelfJson?.errmsg || `HTTP ${shelfRes.status}` };
  }

  // 书名 → 时长（今年逐月并集）
  const yearMap = new Map();
  let yearTotal = 0;
  for (const r of monthRes) {
    const j = r.json;
    if (!j || (j.errcode !== undefined && j.errcode !== 0)) continue;
    for (const x of j.readLongest ?? []) {
      const title = x.book?.title ?? x.albumInfo?.name ?? '';
      if (!title) continue;
      yearTotal += x.readTime ?? 0;
      const cur = yearMap.get(title) ?? { sec: 0, cover: x.book?.cover ?? x.albumInfo?.cover ?? null, author: x.book?.author ?? x.albumInfo?.authorName ?? '' };
      cur.sec += x.readTime ?? 0;
      if (!cur.cover) cur.cover = x.book?.cover ?? x.albumInfo?.cover ?? null;
      yearMap.set(title, cur);
    }
  }
  // 全历史排行
  const allMap = new Map();
  const o = overallRes.json;
  if (o && (o.errcode === undefined || o.errcode === 0)) {
    for (const x of o.readLongest ?? []) {
      const title = x.book?.title ?? x.albumInfo?.name ?? '';
      if (!title) continue;
      allMap.set(title, {
        sec: x.readTime ?? 0,
        cover: x.book?.cover ?? x.albumInfo?.cover ?? null,
        author: x.book?.author ?? x.albumInfo?.authorName ?? '',
      });
    }
  }

  const books = (shelfJson.books ?? []).map((b) => {
    const y = yearMap.get(b.title);
    const a = allMap.get(b.title);
    return {
      bookId: b.bookId,
      title: b.title,
      author: b.author ?? y?.author ?? a?.author ?? '',
      cover: b.cover ?? y?.cover ?? a?.cover ?? null,
      category: b.category ?? '',
      finished: b.finishReading === 1,
      // 今年阅读时长（readLongest 并集）；null 表示排行没覆盖到
      yearSec: y ? y.sec : null,
      // 全历史阅读时长（overall top10 覆盖）
      totalSec: a ? a.sec : null,
      lastReadAt: b.readUpdateTime ?? null,
      readerLink: b.readerLink ?? b.deepLink ?? null,
    };
  });

  const albums = (shelfJson.albums ?? []).map((al) => ({
    albumId: al.albumInfo?.albumId ?? '',
    title: al.albumInfo?.name ?? '未知专辑',
    author: al.albumInfo?.authorName ?? '',
    cover: al.albumInfo?.cover ?? null,
    category: '有声书',
    finished: al.albumInfo?.finish === 1,
    yearSec: yearMap.get(al.albumInfo?.name ?? '')?.sec ?? null,
    totalSec: allMap.get(al.albumInfo?.name ?? '')?.sec ?? null,
    lastReadAt: al.albumInfoExtra?.lectureReadUpdateTime ?? null,
    readerLink: null,
  }));

  return {
    ok: true,
    // 书架总数口径（技能文档强制）：books + albums + (mp 非空 ? 1 : 0)
    total: books.length + albums.length + (shelfJson.mp ? 1 : 0),
    bookCount: books.length,
    albumCount: albums.length,
    hasMp: Boolean(shelfJson.mp),
    books,
    albums,
    // 今年 books 侧的时长合计 + 覆盖率，界面用来如实说明「部分书无记录」
    yearTotalSec: yearTotal,
    coveredCount: books.filter((b) => b.yearSec !== null).length,
  };
}

/**
 * 取一份完整的阅读数据视图，供界面直接渲染。
 * 并行拉 weekly / monthly / overall，任何一项失败都不影响其它项。
 * goalSec 由调用方传入（用户设定的「每日目标」），达标判定一律用它，
 * 不用服务端那个写死的 5 分钟口径，否则界面会和服务端规则打架。
 */
export async function readDashboard(apiKey, signal, goalSec = CHECKIN_THRESHOLD_SEC) {
  if (!apiKey) return { ok: false, reason: '未配置 WEREAD_API_KEY' };

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const weekStart = new Date(now.getTime());
  // 周一为一周起点
  const dow = (weekStart.getDay() + 6) % 7;
  weekStart.setDate(weekStart.getDate() - dow);
  // 固定铺满周一到周日：未来几天填 0，避免柱子数量随星期几跳动
  const weekEnd = new Date(weekStart.getTime());
  weekEnd.setDate(weekEnd.getDate() + 6);

  const [weekly, monthly, overall] = await Promise.all([
    callGateway(apiKey, { api_name: '/readdata/detail', mode: 'weekly' }, signal),
    callGateway(apiKey, { api_name: '/readdata/detail', mode: 'monthly' }, signal),
    callGateway(apiKey, { api_name: '/readdata/detail', mode: 'overall' }, signal),
  ]);

  const okOf = (r) => r.json && (r.json.errcode === undefined || r.json.errcode === 0);
  if (!okOf(weekly) && !okOf(monthly)) {
    return { ok: false, reason: weekly.json?.errmsg || `HTTP ${weekly.status}` };
  }

  const today = todayKey();
  const w = okOf(weekly) ? weekly.json : {};
  const m = okOf(monthly) ? monthly.json : {};
  const o = okOf(overall) ? overall.json : {};

  const weekSeries = toDailySeries(w.readTimes, { fromDate: weekStart, toDate: weekEnd });
  const monthSeries = toDailySeries(m.readTimes, { fromDate: monthStart, toDate: now });

  const todaySec = (w.readTimes ?? {})[today] ?? (m.readTimes ?? {})[today] ?? 0;

  const goal = Number(goalSec) > 0 ? Number(goalSec) : CHECKIN_THRESHOLD_SEC;

  // 本月达标天数（按用户设定的每日目标判定）
  const monthCheckedDays = monthSeries.filter((d) => d.sec >= goal).length;

  return {
    ok: true,
    today: {
      date: ymdLocal(now),
      sec: todaySec,
      min: todaySec === null ? null : Math.round((todaySec / 60) * 10) / 10,
      reached: (todaySec ?? 0) >= goal,
      threshold: goal,
    },
    week: {
      series: weekSeries.map((d) => ({ date: ymdLocal(d.date), sec: d.sec })),
      readDays: w.readDays ?? null,
      totalSec: w.totalReadTime ?? null,
      checkedDays: weekSeries.filter((d) => d.sec >= goal).length,
      compare: typeof w.compare === 'number' ? w.compare : null,
      topBooks: (w.readLongest ?? []).slice(0, 3).map((x) => ({
        title: x.book?.title ?? x.albumInfo?.name ?? '未知',
        author: x.book?.author ?? '',
        sec: x.readTime ?? 0,
        cover: x.book?.cover ?? x.albumInfo?.cover ?? null,
      })),
    },
    month: {
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      // 周一开头：getDay() 的 0=周日 要映射成最后一格（偏移 6），其余减 1。
      firstWeekday: (new Date(now.getFullYear(), now.getMonth(), 1).getDay() + 6) % 7,
      daysInMonth: new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate(),
      series: monthSeries.map((d) => ({ date: ymdLocal(d.date), sec: d.sec })),
      checkedDays: monthCheckedDays,
      readDays: m.readDays ?? null,
      totalSec: m.totalReadTime ?? null,
    },
    overall: {
      totalSec: o.totalReadTime ?? null,
      readDays: o.readDays ?? null,
      stat: (o.readStat ?? []).map((s) => ({ label: s.stat, value: s.counts })),
    },
  };
}

/**
 * 取一份阅读统计快照。
 * @returns {{ok:true, todaySec:number|null, readDays:number|null, totalReadTime:number|null}|{ok:false, reason:string}}
 */
export async function readSnapshot(apiKey, signal) {
  if (!apiKey) return { ok: false, reason: '未配置 WEREAD_API_KEY，无法验证' };
  const r = await callGateway(apiKey, { api_name: '/readdata/detail', mode: 'weekly' }, signal);
  const j = r.json;
  if (!j || (j.errcode !== undefined && j.errcode !== 0)) {
    return { ok: false, reason: j?.errmsg || `HTTP ${r.status}` };
  }
  const bucket = j.readTimes ?? {};
  const key = todayKey();
  return {
    ok: true,
    // 服务端在没有阅读记录的日子不给桶，语义上就是 0 秒。
    // 这里必须归一成数字：否则跨零点后的第一次打卡会因 before=null 而
    // 算不出增量（dToday=null），被误判成「未验证」。
    todaySec: bucket[key] === undefined ? 0 : bucket[key],
    readDays: j.readDays ?? null,
    totalReadTime: j.totalReadTime ?? null,
    upgradeHint: j.upgrade_info?.latest_version ?? null,
  };
}

/**
 * 打卡前后对比：证明时长是否真的增长。
 *
 * @param {string} apiKey
 * @param {() => Promise<unknown>} action 执行打卡
 * @param {AbortSignal} [signal]
 */
export async function verifyAround(apiKey, action, signal) {
  const before = await readSnapshot(apiKey, signal);
  if (!before.ok) {
    // 没有验证手段时仍执行打卡，但如实标注未验证
    const result = await action();
    return { result, verified: false, reason: before.reason };
  }
  const result = await action();
  const after = await readSnapshot(apiKey, signal);
  if (!after.ok) return { result, before, verified: false, reason: after.reason };

  const dToday = before.todaySec !== null && after.todaySec !== null
    ? after.todaySec - before.todaySec
    : null;
  const dTotal = before.totalReadTime !== null && after.totalReadTime !== null
    ? after.totalReadTime - before.totalReadTime
    : null;

  return {
    result,
    before,
    after,
    dToday,
    dTotal,
    verified: dToday !== null,
    // 只有正增长才算真正计入
    credited: (dToday ?? 0) > 0,
  };
}

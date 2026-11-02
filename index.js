/**
 * 微信读书打卡插件 —— Host 端。
 *
 * 三处调用方共用同一份实现（服务方法即唯一入口）：
 *   1. Agent 工具 `weread_checkin`（对话触发）
 *   2. Client 面板按钮（host.call RPC 触发）
 *   3. 内置定时检查（每天到点自动跑）
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { runReading, refreshSkey, probeAuth, DEFAULT_BASE } from './weread-api.js';
import { resolveApiKey, readSnapshot, readDashboard, readHistory, readShelf, readProfile, readNotebooks, readBookmarks, ymdLocal } from './weread-verify.js';

/** 每天检查一次是否到了自动打卡时间。 */
const AUTO_TICK_MS = 60 * 1000;
/** 上报间隔：源码固定 30 秒。 */
const REPORT_INTERVAL_MS = 30 * 1000;
/** 每次上报约 30 秒，换算成次数。 */
const MINUTES_TO_TIMES = (m) => Math.max(1, Math.round((m * 60) / 30));
/**
 * 侧边栏徽标转绿的门槛：当日阅读满 10 分钟。
 * 注意与打卡门槛（5 分钟）不同——5 分钟已算打卡成功，10 分钟才是「绿」的标准。
 */
const GREEN_SEC = 600;
/** 徽标缓存时长：侧边栏每 2 分钟轮询一次，这里再挡一层，避免反复打官方接口。 */
const BADGE_TTL_MS = 60 * 1000;

/**
 * 注意：曾尝试用 bookId「合成」data 模板（拼 appId/ps/pc 占位值），
 * 实测服务端返回空对象 {}，即 b/c/ps/pc 必须是同一次真实阅读产生的配对，
 * 无法凭空构造。因此这里不再合成，缺模板就明确要求用户抓包。
 */

/** 解析 Cookie 字符串成键值对。 */
function parseCookie(raw) {
  const jar = {};
  if (typeof raw !== 'string') return jar;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    jar[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return jar;
}

/**
 * 从 cURL 命令里提取 Cookie 与固定 data 模板。
 * 这是唯一需要用户手工提供输入的地方：F12 → Copy as cURL (bash)。
 */
export function parseCurl(curl) {
  if (typeof curl !== 'string' || curl.trim() === '') return null;
  const cookies = {};
  const cookieMatch = /-H\s+'?[Cc]ookie:\s*([^']+)'?/.exec(curl) ?? /-b\s+'([^']+)'/.exec(curl);
  if (cookieMatch) Object.assign(cookies, parseCookie(cookieMatch[1]));
  if (!cookies.wr_skey) return null;

  // data 模板：优先 --data-raw，其次 -d/--data
  let base = null;
  const dataMatch = /--data-raw\s+'([^']+)'/.exec(curl)
    ?? /--data-raw\s+"([^"]+)"/.exec(curl)
    ?? /\s-d\s+'([^']+)'/.exec(curl)
    ?? /--data\s+'([^']+)'/.exec(curl);
  if (dataMatch) {
    try {
      const parsed = JSON.parse(dataMatch[1]);
      if (parsed && typeof parsed === 'object') base = parsed;
    } catch {
      base = null;
    }
  }
  return { cookies, base };
}

export const name = 'dsh-weread-checkin';

/**
 * 插件版本号：从 package.json 读，单一来源。
 *
 * 必要性：界面要展示版本号，如果 client.js 里再硬编码一份，改版本时容易
 * 只改一处、两边对不上。这里读 package.json 后经 status 下发给前端。
 */
async function readVersion() {
  try {
    const url = new URL('./package.json', import.meta.url);
    const raw = await readFile(url, 'utf8');
    const pkg = JSON.parse(raw);
    return typeof pkg.version === 'string' ? pkg.version : '';
  } catch {
    return '';
  }
}

export function apply(ctx, config = {}) {
  /** 版本号只读一次即可（装机后不会变）。 */
  let pluginVersion = '';
  readVersion().then((v) => { pluginVersion = v; });

  /**
   * 数据目录候选：先 profile 目录，再 DSH_HOME 根。
   *
   * 必要性：同一个凭据文件，不同启动方式下落在不同位置——DSH_PROFILE_DIR
   * 指向 profiles/desktop 时，早期版本把文件写在了 ~/.dsh 根下。读取时
   * 两个位置都看，写入统一用第一个，避免「明明配过却显示未配置」。
   */
  const dataDir = process.env.DSH_PROFILE_DIR || join(homedir(), '.dsh');
  const legacyDir = process.env.DSH_HOME || join(homedir(), '.dsh');
  const candidates = [...new Set([dataDir, legacyDir])];

  /** 依次在候选目录里找文件，返回第一个存在的路径。 */
  async function findExisting(basename) {
    for (const dir of candidates) {
      const p = join(dir, basename);
      try {
        await readFile(p, 'utf8');
        return p;
      } catch {
        // 继续看下一个候选
      }
    }
    return join(dataDir, basename);
  }

  // 状态文件默认落在 profile 目录下，避免污染会话工作区
  const file = config.stateFile || join(dataDir, 'weread-state.json');
  let state = {
    lastRunAt: 0, lastDone: 0, lastErrors: [], lastDay: '', running: false, skey: '',
    // 界面里设置的自动打卡时间（HH:MM，空串表示关闭）；优先于配置文件的 autoTime
    autoTime: '',
    // 界面里选的单次打卡时长（分钟）；0 表示未设置，回退到 config.minutes
    minutes: 0,
    // 每日目标（分钟）：当日阅读时长达到它才算打卡成功；0 表示未设置，回退 config.goalMinutes
    goalMinutes: 0,
    // 最近一次失败原因（用于侧边栏红点）；成功后清空
    lastFail: '',
    // 定时器自己的尝试记账：到点后补跑，但不无限重试
    autoDay: '',
    autoAttempts: 0,
  };
  let tickTimer = null;
  /** 徽标缓存：官方接口有限流，轮询时不能每次都真打。 */
  let badgeCache = { at: 0, value: null };
  /** 打卡运行中的进度快照，供界面每 30 秒轮询。running 时才有意义。 */
  let progress = { done: 0, total: 0, startedAt: 0, todayBefore: 0, todaySec: null, phase: 'idle', unlimited: false, targetMinutes: 0 };
  /**
   * 当前这轮打卡的中止控制器。「继续打卡」是可以随时叫停的，所以必须能中断
   * runReading 内部的 30 秒 sleep（中止后它会抛出「已取消」，被 catch 收住）。
   */
  let runAbort = null;

  async function load() {
    try {
      Object.assign(state, JSON.parse(await readFile(file, 'utf8')));
    } catch {
      // 首次运行没有状态文件
    }
  }
  async function save() {
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(state), 'utf8');
    } catch {
      // 状态持久化失败不影响打卡本身
    }
  }

  /**
   * 凭据文件路径。Cookie 属于敏感信息，不写进插件配置，单独存文件。
   * 主入口是插件设置页粘贴（setup），文件只是它的落盘形式。
   *
   * 读取时会在候选目录里找（兼容早期写在别处的文件），写入固定用第一个。
   */
  const credPath = config.credentialsFile || join(dataDir, 'weread-credentials.json');

  /** 定位实际存在的那份凭据文件（可能被早期版本写在另一个目录）。 */
  async function credFileInUse() {
    if (config.credentialsFile) return config.credentialsFile;
    return findExisting('weread-credentials.json');
  }

  /** 读取已保存的凭据。 */
  async function loadCredentials() {
    let stored = {};
    try {
      stored = JSON.parse(await readFile(await credFileInUse(), 'utf8'));
    } catch {
      stored = {};
    }
    // 配置里直接给的优先级最高（便于自动化测试）
    const fromCurl = config.curl ? parseCurl(config.curl) : null;
    const cookie = config.cookie
      || (fromCurl ? Object.entries(fromCurl.cookies).map(([k, v]) => `${k}=${v}`).join('; ') : '')
      || stored.cookie || '';
    const base = config.base || fromCurl?.base || stored.base || null;
    return { cookie, base, apiKey: stored.apiKey ?? null };
  }

  /** 保存插件设置页粘贴进来的凭据。 */
  async function setup({ cookie, base, apiKey } = {}) {
    const nextCookie = typeof cookie === 'string' ? cookie.trim() : '';
    const current = await loadCredentials();

    let nextBase;
    if (base && typeof base === 'object') nextBase = base;
    else nextBase = current.base ?? null;

    // API Key：允许单独更新；空串表示清除
    const nextApiKey = typeof apiKey === 'string'
      ? (apiKey.trim() === '' ? null : apiKey.trim())
      : (current.apiKey ?? null);

    // Cookie 为空表示只补模板/Key，此时沿用已存的 Cookie
    const jar = parseCookie(nextCookie || current.cookie || '');
    if (nextCookie && !jar.wr_skey) {
      return { ok: false, error: 'Cookie 里没有找到 wr_skey，请确认粘贴的是微信读书的 Cookie' };
    }
    if (typeof apiKey === 'string' && apiKey.trim() !== '' && !/^wrk-/.test(apiKey.trim())) {
      return { ok: false, error: 'API Key 应以 wrk- 开头' };
    }
    if (!jar.wr_skey && !nextBase) {
      return { ok: false, error: '请至少粘贴 Cookie（缺少 wr_skey）' };
    }
    try {
      // 已有旧文件时写回原位置，否则落在默认目录——避免凭据分裂成两份
      const target = await credFileInUse();
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, JSON.stringify({
        cookie: nextCookie || current.cookie || '',
        base: nextBase,
        apiKey: nextApiKey,
      }, null, 2), 'utf8');
    } catch (err) {
      return { ok: false, error: `写入失败：${err.message}` };
    }
    // 新 Cookie 到手，丢弃旧的续期密钥
    if (nextCookie) state.skey = '';
    await save();
    const ready = Boolean(jar.wr_skey);
    return {
      ok: true,
      skeyPreview: jar.wr_skey ? `${jar.wr_skey.slice(0, 2)}***` : '',
      hasApiKey: Boolean(nextApiKey),
      message: ready
        ? (nextApiKey
          ? '已保存，可以打卡，且能用官方接口核对时长是否真的计入'
          : '已保存，可以打卡了（未配置 API Key，打卡后无法核对时长是否计入）')
        : '已保存，但还缺 Cookie',
    };
  }

  /**
   * 拼出本次运行所需的 cookie jar 与 data 模板。
   * 模板缺省时回退到内置的一份（实测可用），所以用户只需提供 Cookie。
   */
  async function credentials() {
    const { cookie, base } = await loadCredentials();
    const jar = parseCookie(cookie);
    if (state.skey) jar.wr_skey = state.skey; // 续期得到的新密钥优先
    return { jar, base: base && typeof base === 'object' ? base : DEFAULT_BASE };
  }

  /** 官方 API Key：环境变量优先，其次凭据文件（应对 Host 启动早于 Key 设置）。 */
  const apiKeyNow = () => resolveApiKey(loadCredentials);

  /** 自动打卡时间：界面设置优先，其次配置文件。空串表示不自动。 */
  const autoTimeNow = () => state.autoTime || config.autoTime || '';

  /** 单次打卡时长（分钟）：界面设置优先，其次配置文件，最后 10 分钟兜底。 */
  const minutesNow = () => {
    const v = Number(state.minutes) || Number(config.minutes) || 10;
    return v > 0 ? v : 10;
  };

  /**
   * 每日目标（分钟）。当日阅读时长达到它才算「打卡成功」。
   * 与单次上报量（minutesNow）分开：目标是判定线，单次量是每次补多少。
   */
  const goalNow = () => {
    const v = Number(state.goalMinutes) || Number(config.goalMinutes) || 10;
    return v > 0 ? v : 10;
  };

  /** 保存每日目标。 */
  async function setupGoal({ goalMinutes } = {}) {
    const n = Number(goalMinutes);
    if (!Number.isFinite(n) || n <= 0) return { ok: false, error: '每日目标应为大于 0 的分钟数' };
    if (n > 600) return { ok: false, error: '每日目标最多 600 分钟' };
    const rounded = Math.round(n * 2) / 2;
    state.goalMinutes = rounded;
    badgeCache = { at: 0, value: null };
    await save();
    return { ok: true, goalMinutes: rounded, message: `每日目标已设为 ${rounded} 分钟` };
  }

  /** 保存界面里设置的自动打卡时间。传空串即关闭。 */
  async function setupAuto({ autoTime } = {}) {
    const raw = typeof autoTime === 'string' ? autoTime.trim() : '';
    if (raw !== '' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(raw)) {
      return { ok: false, error: '时间格式应为 HH:MM（例如 08:30）' };
    }
    state.autoTime = raw;
    // 不清 lastDay：当天已经打过卡就继续算打过（避免改个时间又重复上报一整轮）。
    // 但如果改之前的时间点还没到今天的新时间点，下一次 tick 自然会补上。
    await save();
    return {
      ok: true,
      autoTime: raw,
      message: raw ? `已设为每天 ${raw} 自动打卡` : '已关闭自动打卡',
    };
  }

  /** 保存界面里选的单次打卡时长（分钟）。 */
  async function setupMinutes({ minutes } = {}) {
    const n = Number(minutes);
    if (!Number.isFinite(n) || n <= 0) {
      return { ok: false, error: '时长应为大于 0 的分钟数' };
    }
    // 上限 120 分钟：再长只是空耗请求，且更容易触发风控
    if (n > 120) return { ok: false, error: '单次时长最多 120 分钟' };
    // 取整到 0.5 分钟（上报粒度是 30 秒）
    const rounded = Math.round(n * 2) / 2;
    state.minutes = rounded;
    await save();
    return { ok: true, minutes: rounded, message: `单次打卡时长已设为 ${rounded} 分钟` };
  }

  /**
   * 唯一操作实现：UI 按钮、Agent 工具、定时器都走这里。
   *
   * `minutes` 缺省时按「补差额」策略计算：
   *   本次上报量 = min(单次打卡时长, 每日目标 - 今日已读)
   * 即今天真实读了 3 分钟、目标 10 分钟、单次 10 分钟 → 只补 7 分钟，
   * 当日总量凑满目标就停，不超额上报（超额对账号没好处，也更容易触发风控）。
   * 已经达标时直接返回 ok 且不回传任何请求。
   *
   * `unlimited: true` 是「继续打卡」模式：不做差额计算，一直上报到用户点停止。
   * 此时 `minutes` 若给了就把「单次打卡时长」当作本次上限，否则真的不设上限。
   */
  async function checkin({ minutes, force, unlimited } = {}) {
    const { jar, base } = await credentials();
    if (!jar.wr_skey) {
      return { ok: false, reason: '未配置 Cookie（缺少 wr_skey）。请到「插件 → 微信读书打卡」设置页粘贴 Cookie', done: 0 };
    }
    if (!base || typeof base !== 'object') {
      return { ok: false, reason: '缺少上报模板，且内置模板也没加载成功', done: 0 };
    }
    if (state.running) return { ok: false, reason: '已有打卡任务在运行', done: 0 };

    state.running = true;
    const apiKey = await apiKeyNow();
    const goalMin = goalNow();
    const goalSec = Math.round(goalMin * 60);
    try {
      // 打卡前取官方统计基线：既用于算差额，也用于事后证明时长是否真的计入
      const before = await readSnapshot(apiKey).catch(() => null);
      const todayBefore = before?.ok ? before.todaySec : 0;

      // 算这次要上报多少
      let targetMinutes;
      let isUnlimited = false;
      if (unlimited) {
        // 继续打卡：不套差额策略。给了 minutes 就以此为本轮上限，否则一直跑
        isUnlimited = !(Number.isFinite(minutes) && minutes > 0);
        targetMinutes = isUnlimited
          ? Number.POSITIVE_INFINITY
          : Math.max(0.5, minutes);
      } else if (Number.isFinite(minutes) && minutes > 0) {
        targetMinutes = minutes; // 调用方显式指定，不套差额策略
      } else if (force) {
        targetMinutes = minutesNow(); // 显式忽略差额，照常补一整轮
      } else {
        const remainSec = goalSec - (todayBefore ?? 0);
        if (before?.ok && remainSec <= 0) {
          state.running = false;
          await save();
          return {
            ok: true,
            alreadyDone: true,
            done: 0,
            minutes: 0,
            errors: [],
            verified: true,
            dToday: 0,
            todaySec: todayBefore,
            goalMinutes: goalMin,
            reason: `今日已读 ${Math.floor((todayBefore ?? 0) / 60)} 分钟，已达目标 ${goalMin} 分钟，无需再补`,
          };
        }
        // 差额向上取整到 0.5 分钟粒度，且不超过单次时长
        const remainMin = before?.ok ? Math.ceil((remainSec / 60) * 2) / 2 : minutesNow();
        targetMinutes = Math.max(0.5, Math.min(minutesNow(), remainMin));
      }

      const times = isUnlimited ? Number.POSITIVE_INFINITY : MINUTES_TO_TIMES(targetMinutes);
      runAbort = new AbortController();
      progress = {
        done: 0,
        total: isUnlimited ? 0 : times,
        startedAt: Date.now(),
        todayBefore: todayBefore ?? 0,
        todaySec: todayBefore ?? null,
        phase: 'reporting',
        // 界面要知道这是「继续打卡」模式：进度分母是未知的，按钮要变成「停止」
        unlimited: isUnlimited,
        targetMinutes: isUnlimited ? 0 : targetMinutes,
      };
      // runReading 用 index <= times 循环，Infinity 天然等价于「不设上限」
      const result = await runReading({
        base,
        cookies: jar,
        times,
        intervalMs: REPORT_INTERVAL_MS,
        signal: runAbort.signal,
        onSkey: (skey) => {
          state.skey = skey;
          save();
        },
        onProgress: (done, total) => {
          progress.done = done;
          progress.total = total;
        },
      });

      // 统计有延迟，稍等再取一次
      progress.phase = 'verifying';
      let after = null;
      if (before?.ok) {
        for (let i = 0; i < 4 && !after?.ok; i++) {
          if (i > 0) await new Promise((r) => setTimeout(r, 5000));
          after = await readSnapshot(apiKey).catch(() => null);
        }
      }

      const dToday = (before?.ok && after?.ok
        && before.todaySec !== null && after.todaySec !== null)
        ? after.todaySec - before.todaySec
        : null;

      // 用户中途点了「停止」：这不是失败，走正常收尾，只是标记一下
      const stopped = Boolean(runAbort?.signal?.aborted);

      state.lastRunAt = Date.now();
      state.lastDone = result.done;
      state.lastErrors = result.errors;
      state.lastDay = ymdLocal(new Date());
      state.running = false;
      // 只有请求层面确实错了才留红点；「上报被接受但时长没涨」不算硬失败。
      // 用户主动停止也不算失败，否则侧边栏会误亮红点。
      state.lastFail = (!stopped && result.errors.length) ? result.errors.join('；') : '';
      progress = {
        ...progress,
        phase: 'idle',
        todaySec: after?.ok ? after.todaySec : progress.todaySec,
      };
      runAbort = null;
      await save();
      // 刚跑完，徽标必须重新问一次官方，不能吃旧缓存
      badgeCache = { at: 0, value: null };
      const todayAfter = after?.ok ? after.todaySec : null;
      return {
        // 有验证数据时以「时长真的增长」为准，否则退回请求结果
        ok: dToday !== null ? dToday > 0 : (result.errors.length === 0 && result.done > 0),
        done: result.done,
        minutes: result.minutes,
        errors: result.errors,
        skeyRefreshes: result.skeyRefreshes,
        verified: dToday !== null,
        dToday,
        stopped,
        unlimited: isUnlimited,
        todaySec: todayAfter,
        goalMinutes: goalMin,
        goalReached: todayAfter !== null ? (todayAfter ?? 0) >= goalSec : null,
        readDays: after?.ok ? after.readDays : null,
        reason: stopped
          ? `已停止，本次上报 ${result.done} 次（约 ${result.minutes} 分钟）`
          : (dToday === null
            ? (apiKey ? '未取到官方统计，无法验证' : '未配置 WEREAD_API_KEY，未验证时长是否计入')
            : undefined),
      };
    } catch (err) {
      state.running = false;
      runAbort = null;
      state.lastErrors = [err.message];
      state.lastFail = err.message;
      progress = { ...progress, phase: 'idle' };
      badgeCache = { at: 0, value: null };
      await save();
      return { ok: false, reason: err.message, done: 0 };
    }
  }

  /**
   * 停止正在进行的打卡。只对「继续打卡」这类长跑有意义，普通打卡一跑完就结束了。
   * 中止信号会让 runReading 里 30 秒的 sleep 立刻抛错，所以能秒停，不用等当前这一轮。
   */
  function stop() {
    if (!state.running || !runAbort) {
      return { ok: false, reason: '当前没有正在进行的打卡' };
    }
    runAbort.abort();
    return { ok: true, message: '正在停止…' };
  }

  /** 只刷新密钥，用于排查登录态。 */
  async function renew() {
    const { jar } = await credentials();
    if (!jar.wr_skey) return { ok: false, reason: '未配置 Cookie' };
    const skey = await refreshSkey(jar);
    if (skey) {
      state.skey = skey;
      await save();
      return { ok: true, skey };
    }
    return { ok: false, reason: '刷新失败，登录态可能已失效，需重新抓取 Cookie' };
  }

  /** 面板状态。不含任何凭据明文。 */
  async function status() {
    const { jar, base } = await credentials();
    const stored = await loadCredentials();
    const today = ymdLocal(new Date());
    return {
      // 有 Cookie 就能打卡（模板有内置兜底）
      configured: Boolean(jar.wr_skey),
      hasCookie: Boolean(jar.wr_skey),
      hasBase: Boolean(base),
      // 区分「用的是自己粘的模板」还是「内置模板」
      baseFromBuiltin: !stored.base,
      // 有 API Key 才能验证时长是否真的计入
      canVerify: Boolean(await apiKeyNow()),
      running: state.running,
      lastRunAt: state.lastRunAt,
      lastDay: state.lastDay,
      lastDone: state.lastDone,
      lastErrors: state.lastErrors,
      minutes: minutesNow(),
      goalMinutes: goalNow(),
      autoTime: autoTimeNow(),
      // 注意字段名：不能叫 today —— 前端会把 status 的返回值合并进 dashboard 数据
      // （client.js 的 `{ ...data, ...runtime }`），而 dashboard 的 today 是
      // { sec, goalSec, ... } 对象。同名会让日期字符串把对象整个覆盖掉，
      // TodayCard 读 t.sec 得到 undefined → 今日时长变 0 → 已达标按钮退回普通按钮并转圈。
      todayYmd: today,
      lastDayDone: state.lastDay === today && state.lastDone > 0,
      lastFail: state.lastFail || '',
      // 版本号（前端底部展示，来自 package.json，避免两处硬编码打架）
      version: pluginVersion,
      // 打卡进行中的实时进度（界面每 30 秒轮询一次）
      progress: { ...progress },
    };
  }

  /** 只读：查今天官方统计的阅读时长，用于确认打卡效果。 */
  async function today() {
    const apiKey = await apiKeyNow();
    const snap = await readSnapshot(apiKey).catch(() => null);
    if (!snap?.ok) {
      return { ok: false, reason: snap?.reason ?? '未配置 WEREAD_API_KEY，无法查询官方统计' };
    }
    return {
      ok: true,
      todaySec: snap.todaySec,
      todayMin: snap.todaySec === null ? null : Math.round((snap.todaySec / 60) * 10) / 10,
      readDays: snap.readDays,
      totalReadTime: snap.totalReadTime,
      // 服务端规则：当日有效阅读满 5 分钟即记为打卡天
      reachedToday: (snap.todaySec ?? 0) >= 300,
    };
  }

  /** 只读：界面用的完整阅读面板数据（今日 / 本周 / 本月日历 / 累计）。 */
  async function dashboard() {
    const apiKey = await apiKeyNow();
    // 插件自身的运行状态：无论读数据成不成功都必须带上。
    // 否则打卡正在跑时只要 readDashboard 失败（它要并行拉 3 个接口，网络抖动就会失败），
    // 前端收到的就是不含 progress/running 的错误对象，界面会误判成「没在跑」，
    // 于是显示「继续打卡」而不是「停止打卡」，用户根本找不到停止入口。
    const { jar, base } = await credentials();
    const runtime = {
      configured: Boolean(jar.wr_skey),
      hasCookie: Boolean(jar.wr_skey),
      hasBase: Boolean(base),
      running: state.running,
      lastRunAt: state.lastRunAt,
      lastDayDone: state.lastDay === ymdLocal(new Date()) && state.lastDone > 0,
      minutes: minutesNow(),
      goalMinutes: goalNow(),
      autoTime: autoTimeNow(),
      lastFail: state.lastFail || '',
      version: pluginVersion,
      progress: { ...progress },
    };
    if (!apiKey) {
      return {
        ok: false,
        reason: '未配置 WEREAD_API_KEY，无法读取阅读数据',
        needApiKey: true,
        ...runtime,
      };
    }
    const data = await readDashboard(apiKey, undefined, Math.round(goalNow() * 60))
      .catch((e) => ({ ok: false, reason: String(e?.message ?? e) }));
    if (!data.ok) return { ...data, ...runtime };
    return { ...data, ...runtime };
  }

  /**
   * 历史日级序列（2026-01-01 至今），供月历/周历切换使用。
   * 逐月拉取，约 2 秒；前端只在用户打开日历卡时才请求。
   */
  async function history() {
    const apiKey = await apiKeyNow();
    if (!apiKey) return { ok: false, reason: '未配置 WEREAD_API_KEY，无法读取历史', needApiKey: true };
    const data = await readHistory(apiKey).catch((e) => ({ ok: false, reason: String(e?.message ?? e) }));
    if (!data.ok) return data;
    const goalSec = Math.round(goalNow() * 60);
    return {
      ok: true,
      series: data.series,
      months: data.months,
      goalMinutes: goalNow(),
      // 达标判定用「用户设定的每日目标」，不是服务端的 5 分钟
      checkedDays: data.series.filter((d) => d.sec >= goalSec).length,
      totalSec: data.series.reduce((a, b) => a + b.sec, 0),
    };
  }

  /**
   * 阅读画像（时段分布 / 偏好分类 / 常读作者 / 勋章）。
   * 四个字段同源，一次接口就够；前端点开卡片时才请求。
   */
  async function profile() {
    const apiKey = await apiKeyNow();
    if (!apiKey) return { ok: false, reason: '未配置 WEREAD_API_KEY，无法读取阅读画像', needApiKey: true };
    const data = await readProfile(apiKey).catch((e) => ({ ok: false, reason: String(e?.message ?? e) }));
    return data;
  }

  /** 笔记本列表（每本书有多少条笔记），前端点开笔记卡时才请求。 */
  async function notebooks() {
    const apiKey = await apiKeyNow();
    if (!apiKey) return { ok: false, reason: '未配置 WEREAD_API_KEY，无法读取笔记', needApiKey: true };
    const data = await readNotebooks(apiKey).catch((e) => ({ ok: false, reason: String(e?.message ?? e) }));
    return data;
  }

  /** 某一本书的划线原文（用户点开书名时才请求，别一次拉全书架）。 */
  async function bookmarks(input) {
    const apiKey = await apiKeyNow();
    if (!apiKey) return { ok: false, reason: '未配置 WEREAD_API_KEY，无法读取划线', needApiKey: true };
    const bookId = String(input?.bookId ?? '').trim();
    if (!bookId) return { ok: false, reason: '缺少 bookId' };
    const data = await readBookmarks(apiKey, bookId).catch((e) => ({ ok: false, reason: String(e?.message ?? e) }));
    return data;
  }

  /** 书架 + 每本书的阅读时长（用户点开书架卡时才请求）。 */
  async function shelf() {
    const apiKey = await apiKeyNow();
    if (!apiKey) return { ok: false, reason: '未配置 WEREAD_API_KEY，无法读取书架', needApiKey: true };
    const data = await readShelf(apiKey).catch((e) => ({ ok: false, reason: String(e?.message ?? e) }));
    if (!data.ok) return data;
    return { ...data, goalMinutes: goalNow() };
  }

  /**
   * 侧边栏三色徽标（轻量、带缓存）。
   *
   * 绿 = 今日阅读已达用户设定的每日目标
   * 黄 = 今天还没达标
   * 红 = 未配置 / 凭据失效 / 最近一次运行报错
   *
   * 刻意不复用 dashboard()：那边要并行拉 weekly+monthly+overall 三个接口，
   * 而徽标每 2 分钟就要问一次，用最省的一次调用即可。
   */
  async function badge() {
    const now = Date.now();
    if (badgeCache.value && now - badgeCache.at < BADGE_TTL_MS) {
      return badgeCache.value;
    }
    const goalMin = goalNow();
    const goalSec = Math.round(goalMin * 60);
    const { jar } = await credentials();
    let payload;
    if (!jar.wr_skey) {
      payload = { ok: true, level: 'red', reason: '未配置 Cookie' };
    } else {
      // 先单独探登录态：官方统计那条通道和 Cookie 无关，只看它会被「假绿」骗过去
      // probeAuth 要走微信读书的外部接口，网络抖动会抛错。这里必须兜住：
      // 抛错 = 暂时探测不到，不是凭据失效，绝不能让整个 badge 失败导致侧边栏闪红。
      const auth = await probeAuth(jar).catch(() => ({
        ok: false, reason: '暂时无法连接微信读书', hard: false,
      }));
      const apiKey = await apiKeyNow();
      const snap = auth.ok && apiKey ? await readSnapshot(apiKey).catch(() => null) : null;
      if (!auth.ok && auth.hard) {
        payload = { ok: true, level: 'red', reason: auth.reason, todaySec: null };
      } else if (!snap?.ok) {
        // 拿不到官方统计：凭据是好的就是黄，凭据有问题就是红
        payload = {
          ok: true,
          level: 'yellow',
          reason: auth.ok
            ? (apiKey ? '暂时读不到官方统计' : '未配置 API Key')
            : auth.reason,
          todaySec: null,
        };
      } else {
        const sec = snap.todaySec ?? 0;
        // 转绿门槛 = 用户设定的每日目标（不再是写死的 10 分钟）
        const level = sec >= goalSec ? 'green' : 'yellow';
        payload = {
          ok: true,
          level,
          reason: level === 'green' ? '' : `今日 ${Math.floor(sec / 60)} 分钟，未达目标 ${goalMin} 分钟`,
          todaySec: sec,
          goalMinutes: goalMin,
          readDays: snap.readDays,
        };
      }
    }
    badgeCache = { at: now, value: payload };
    return payload;
  }

  /**
   * badge 的安全包装：任何未预料的异常都不该让侧边栏亮红。
   * 真出错时回报「暂时读不到」，并把错误写进 lastFail 供面板显示排查。
   */
  async function badgeSafe() {
    try {
      return await badge();
    } catch (err) {
      const reason = err && err.message ? err.message : String(err);
      return {
        ok: false,
        level: 'yellow',
        reason: `暂时读不到状态：${reason}`,
        todaySec: null,
        goalMinutes: goalNow(),
      };
    }
  }

  // 注册工具：Agent 通过对话触发
  if (ctx.tools) {
    ctx.effect(() => ctx.tools.register({
      name: 'weread_checkin',
      description:
        '在微信读书上报阅读时长完成每日打卡。微信读书没有独立的打卡接口，服务端以「当日有效阅读 ≥5 分钟」记为打卡天，'
        + '因此本工具通过按 30 秒一次上报阅读时长来实现打卡（同时累积读书小队积分）。'
        + '只需要用户粘贴过一次 Cookie；上报模板有内置兜底，无需抓包。'
        + '若尚未配置 Cookie，提示用户去「插件 → 微信读书打卡」设置页粘贴，不要反复重试本工具。'
        + '未传 minutes 时使用插件配置的默认时长。',
      parameters: {
        type: 'object',
        properties: {
          minutes: {
            type: 'number',
            description: '要上报的阅读分钟数（每次上报约 30 秒）。不传则用插件配置的默认值。',
          },
          unlimited: {
            type: 'boolean',
            description: '继续打卡模式：不按「补差额」计算，持续上报到用户让你停止为止。用户说「继续打卡」「一直打卡」时用这个。',
          },
        },
      },
      // 规范值结构化返回，render 只负责投影成模型可见文本
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'done'],
          properties: {
            ok: { type: 'boolean', description: '是否成功完成打卡（有官方统计时以时长真的增长为准）' },
            done: { type: 'number', description: '成功上报的次数' },
            minutes: { type: 'number', description: '本次累计上报的阅读分钟数' },
            skeyRefreshes: { type: 'number', description: '期间刷新登录密钥的次数' },
            verified: { type: 'boolean', description: '是否用官方接口验证了时长增长' },
            dToday: { type: 'number', description: '今日阅读时长的增量（秒）' },
            todaySec: { type: 'number', description: '今日累计阅读时长（秒）' },
            readDays: { type: 'number', description: '本周有效阅读天数' },
            goalMinutes: { type: 'number', description: '用户设定的每日目标（分钟）' },
            goalReached: { type: 'boolean', description: '今日是否已达每日目标' },
            alreadyDone: { type: 'boolean', description: '今日已达标、本次未上报' },
            stopped: { type: 'boolean', description: '是否被用户中途停止' },
            unlimited: { type: 'boolean', description: '是否为不限时长的继续打卡' },
            reason: { type: 'string', description: '失败原因或未验证的说明' },
            errors: { type: 'array', items: { type: 'string' }, description: '运行中的错误列表' },
          },
        },
        render: (_args, value) => {
          if (!value) return [{ type: 'text', text: '打卡未完成：未知原因' }];
          if (value.alreadyDone) {
            return [{ type: 'text', text: `今日已达标（目标 ${value.goalMinutes} 分钟），无需再补。` }];
          }
          const goal = value.goalMinutes !== undefined ? `（每日目标 ${value.goalMinutes} 分钟${value.goalReached ? '，已达成' : ''}）` : '';
          if (value.stopped) {
            return [{ type: 'text', text: `已按你的要求停止打卡：本次上报 ${value.done} 次（约 ${value.minutes} 分钟）${goal}。` }];
          }
          if (value.verified) {
            const head = value.dToday > 0
              ? `微信读书打卡成功：今日阅读时长 +${value.dToday} 秒（累计 ${value.todaySec} 秒）`
              : `打卡未见效：本次 ${value.done} 次上报被接受，但今日阅读时长没有增加（${value.dToday ?? 0} 秒）`;
            const days = value.readDays !== null && value.readDays !== undefined
              ? `，本周有效阅读 ${value.readDays} 天` : '';
            return [{ type: 'text', text: `${head}${days}${goal}。（已用官方接口核对）` }];
          }
          return [{
            type: 'text',
            text: value.ok
              ? `已上报 ${value.done} 次（约 ${value.minutes} 分钟）${goal}，但${value.reason || '未能验证时长是否真的计入'}`
              : `打卡未完成：${value.reason || (value.errors || []).join('；') || '未知原因'}`,
          }];
        },
      },
      execute: async (args) => {
        const res = await checkin({ minutes: args?.minutes, unlimited: args?.unlimited });
        return {
          ok: Boolean(res.ok),
          done: res.done ?? 0,
          minutes: res.minutes,
          skeyRefreshes: res.skeyRefreshes,
          verified: Boolean(res.verified),
          dToday: res.dToday,
          todaySec: res.todaySec,
          readDays: res.readDays,
          goalMinutes: res.goalMinutes,
          goalReached: res.goalReached,
          alreadyDone: Boolean(res.alreadyDone),
          stopped: Boolean(res.stopped),
          unlimited: Boolean(res.unlimited),
          reason: res.reason,
          errors: res.errors,
        };
      },
    }), 'weread tool');
  }

  // 斜杠命令：在输入框直接 /weread 手动触发，不产生模型消息
  if (ctx.commands) {
    ctx.effect(() => ctx.commands.register({
      name: 'weread',
      description: '立即执行一次微信读书阅读打卡',
      input: { hint: '[分钟数]' },
      handler: async ({ rawInput }) => {
        const m = Number.parseFloat((rawInput ?? '').trim());
        const res = await checkin({ minutes: Number.isFinite(m) ? m : undefined });
        return {
          kind: res.ok ? 'success' : 'error',
          text: res.ok
            ? `微信读书打卡完成：${res.done} 次上报，约 ${res.minutes} 分钟。`
            : `打卡未完成：${res.reason ?? res.errors?.join('；') ?? '未知原因'}`,
        };
      },
    }), 'weread command');
  }

  // 定时自动打卡：每分钟检查一次。
  //
  // 原实现只认 `hhmm === wanted` 这一分钟，只要那一刻 DSH 没在运行（或进程刚好
  // 卡住跳过了这一分钟）就整天漏打卡。现在改成「过点即补」：
  //   到点或已过点、当天还没成功跑过、今天还没试过（或上次失败且未超次数）→ 补跑。
  // 这样半夜没开机、到点才唤醒，都能在当天补上。
  tickTimer = setInterval(() => {
    const wanted = autoTimeNow();
    if (!wanted) return;
    const now = new Date();
    const today = ymdLocal(now);
    // 当天已经成功跑过就不再跑
    if (state.lastDay === today && state.lastDone > 0) return;

    const [wh, wm] = wanted.split(':').map(Number);
    const target = new Date(now.getTime());
    target.setHours(wh, wm, 0, 0);
    // 还没到点，什么都不做
    if (now < target) return;

    // 换了一天，重置尝试计数
    if (state.autoDay !== today) {
      state.autoDay = today;
      state.autoAttempts = 0;
    }
    // 一天最多补 3 次，避免接口异常时无脑重试
    if (state.autoAttempts >= 3) return;
    state.autoAttempts += 1;
    save().catch(() => {});

    // 成功后 checkin 会写 state.lastDay/lastDone，下一轮 tick 自然被顶部守卫拦住
    checkin({}).catch(() => {});
  }, AUTO_TICK_MS);
  tickTimer.unref?.(); // 不要阻止进程退出

  // Client 面板的数据接口：按钮与工具、命令走完全相同的实现。
  // 路由与 dsh-better-sidebar 的 /sidebar/api 同一模式（kind: 'prefix' + POST）。
  const api = {
    checkin, stop, renew, status, setup, setupAuto, setupMinutes, setupGoal,
    today, dashboard, badge: badgeSafe, history, shelf,
    profile, notebooks, bookmarks,
  };
  if (ctx.webServer) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/weread/api',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
          return;
        }
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
        const method = pathname.startsWith('/weread/api/')
          ? pathname.slice('/weread/api/'.length)
          : undefined;
        try {
          if (method === undefined || !Object.hasOwn(api, method) || typeof api[method] !== 'function') {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'unknown method' }));
            return;
          }
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
          const result = await api[method](body);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result ?? {}));
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
        }
      },
    }), 'weread api route');
  }

  ctx.effect(() => () => {
    if (tickTimer) clearInterval(tickTimer);
    // 卸载时把长跑中的打卡也掐掉，否则无限模式会一直挂着
    if (runAbort) runAbort.abort();
  }, 'weread cleanup');

  load();
}

export const inject = ['tools', 'commands', 'webServer'];

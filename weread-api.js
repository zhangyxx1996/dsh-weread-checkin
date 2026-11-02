/**
 * 微信读书阅读时长上报：签名算法与 HTTP 调用。
 *
 * 接口细节逐字对照 findmover/wxread 的 main.py / config.py 核实：
 *   - 加密盐 KEY、encode_data、cal_hash、三个接口 URL、续期与 synckey 修复流程。
 *
 * 与 Python 的唯一实质差异是位移宽度：Python 的 `<<` 是任意精度整数，
 * 而 JS 的 `<<` 会把左操作数截成 32 位有符号整数。源码里被移位的量
 * （ord(ch) << k，k 最大 29）确实会溢出 32 位，所以每一步都必须先
 * `>>> 0` 归一到无符号 32 位，再用 `& 0x7fffffff` 取低 31 位，
 * 否则算出的 `s` 与 Python 不一致，服务端会拒绝。
 */

import { createHash, randomInt } from 'node:crypto';

/**
 * 内置上报模板（来自 findmover/wxread 的 config.py，经过实测可用）。
 *
 * 为什么可以内置：`b`/`c`/`ps`/`pc` 这些字段服务端并不逐个校验，只要
 * 组合是「曾经真实产生过」的一组就能通过；实测用这份模板上报后，
 * 官方统计的当日时长确实从 1197 秒涨到 1230 秒（上报 2 次共 63 秒）。
 * 因此用户不必再抓包，只在模板失效时才需要自己粘一份。
 */
export const DEFAULT_BASE = {
  appId: 'wb182564874603h266381671',
  b: 'ce032b305a9bc1ce0b0dd2a',
  c: '7f632b502707f6ffaa6bf2e',
  ci: 27,
  co: 389,
  sm: '19聚会《三体》网友的聚会地点是一处僻静',
  pr: 74,
  ps: '4ee326507a65a465g015fae',
  pc: 'aab32e207a65a466g010615',
};

const KEY = '3c5c8717f3daf09iop3423zafeqoi';
const READ_URL = 'https://weread.qq.com/web/book/read';
const RENEW_URL = 'https://weread.qq.com/web/login/renewal';
const FIX_SYNCKEY_URL = 'https://weread.qq.com/web/book/chapterInfos';

/** 源码常量：鉴权失效错误码，命中则刷新 wr_skey。 */
const AUTH_ERROR_CODES = new Set([-2012, -2013]);
/** 源码常量：连续多少次拿不到 synckey 就放弃。 */
const SYNCKEY_REPAIR_LIMIT = 3;
const SYNCKEY_REPAIR_DELAY_MS = 5000;
const REQUEST_TIMEOUT_MS = 30000;
const RENEW_TIMEOUT_MS = 20000;

/**
 * 会话续期接口的请求体。
 *
 * **必须带 `ql:true`**。2026-11-02 实测（同一份有效 Cookie，逐项只改一个变量）：
 *
 *   payload                          body                                   判定
 *   {rq, ql:true}  + 有效 Cookie     {"succ":1} + 下发 wr_vid/wr_skey/wr_rt   ✅ 活着
 *   {rq, ql:false} + 有效 Cookie     {"errCode":-2013,"errMsg":"鉴权失败"}     ❌ 假失效
 *   {rq}           + 有效 Cookie     同上（ql 缺省等同 false）                 ❌ 假失效
 *   {rq, ql:true}  + wr_rt 被改坏    -2013 鉴权失败                          真的失效
 *   {rq, ql:true}  + 缺 wr_vid/wr_rt -2013 params error (node)               缺长期凭据
 *   {rq, ql:true}  + wr_skey 被改坏  {"succ":1}                              仍然活着
 *
 * 关键坑：`ql:false` 对**有效** Cookie 也回 -2013「鉴权失败」，并且 Set-Cookie 用
 * `Expires=Thu, 01 Jan 1970` 把 wr_vid/wr_skey/wr_rt/wr_pf 四个全部清空。
 * 拿 ql:false 当探测判据，会把一切正常用户都判成「Cookie 已失效」——
 * v1.1.6 侧边栏长期红点就是这一行写错导致的。
 */
const RENEW_BODY = { rq: '%2Fweb%2Fbook%2Fread', ql: true };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';

/** 32 位无符号左移：JS 的 `<<` 会溢出，这里复刻 Python 任意精度后再截断的语义。 */
function shiftLeft32(value, bits) {
  return (value * 2 ** bits) >>> 0;
}

/**
 * 复刻 Python 的 urllib.parse.quote(str(v), safe='')。
 * JS 的 encodeURIComponent 不转义 !'()*，需按 Python 行为补齐。
 */
export function quoteStrict(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/** 按 key 排序拼成 k=v&k=v（源码 encode_data）。 */
export function encodeData(data) {
  return Object.keys(data)
    .sort()
    .map((k) => `${k}=${quoteStrict(data[k])}`)
    .join('&');
}

/** 复刻 cal_hash：两个累加器交替异或，最后以 16 进制输出。 */
export function calHash(input) {
  let a = 0x15051505;
  let b = 0x15051505;
  const len = input.length;
  let i = len - 1;
  while (i > 0) {
    a = 0x7fffffff & (a ^ shiftLeft32(input.charCodeAt(i), (len - i) % 30));
    b = 0x7fffffff & (b ^ shiftLeft32(input.charCodeAt(i - 1), i % 30));
    i -= 2;
  }
  return (a + b).toString(16).toLowerCase();
}

/** 构造一次上报的完整 data：更新时间戳、重算两个签名。 */
export function buildReadData(base, lastTimeSec, nowSec = Math.floor(Date.now() / 1000)) {
  const d = { ...base };
  delete d.s; // 源码：先移除旧的 s 再算
  d.ct = nowSec;
  d.rt = Math.max(1, nowSec - lastTimeSec);
  d.ts = nowSec * 1000 + randomInt(0, 1000);
  d.rn = randomInt(0, 1000);
  d.sg = createHash('sha256').update(`${d.ts}${d.rn}${KEY}`).digest('hex');
  d.s = calHash(encodeData(d));
  return d;
}

/** 把 cookie 对象序列化成请求头用的字符串。 */
function cookieHeader(cookies) {
  return Object.entries(cookies)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

async function postJson(url, body, cookies, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json;charset=UTF-8',
        accept: 'application/json, text/plain, */*',
        origin: 'https://weread.qq.com',
        referer: 'https://weread.qq.com/web/reader/',
        'user-agent': UA,
        cookie: cookieHeader(cookies),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/** 从 Set-Cookie 里取出 wr_skey（源码只取前 8 位）。 */
function extractSkey(res) {
  const raw = typeof res.headers?.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const line of raw) {
    const m = /wr_skey=([^;]+)/.exec(line);
    if (m) return m[1].slice(0, 8);
  }
  return null;
}

async function renewSkeyRaw(cookies) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RENEW_TIMEOUT_MS);
  try {
    const res = await fetch(RENEW_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json;charset=UTF-8',
        accept: 'application/json, text/plain, */*',
        origin: 'https://weread.qq.com',
        referer: 'https://weread.qq.com/web/reader/',
        'user-agent': UA,
        cookie: cookieHeader(cookies),
      },
      body: JSON.stringify(RENEW_BODY),
      signal: controller.signal,
    });
    return extractSkey(res);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 刷新 wr_skey：依次尝试几种 payload，取响应 Set-Cookie 里的前 8 位。
 *
 * 顺序有讲究：`ql:true` 放第一位。旧版把 `ql:false` 放最前，而实测 ql:false 对有效
 * Cookie 也回 -2013 并把 Cookie 全清空 —— 虽然它的 Set-Cookie 里 wr_skey 是空值、
 * 不会骗过 extractSkey（正则要求值至少 1 个字符），但等于白发一次请求。
 *
 * @returns {string|null} 新密钥；null 表示登录态可能已失效。
 */
export async function refreshSkey(cookies) {
  const variants = [
    RENEW_BODY,
    { rq: '%2Fweb%2Fbook%2Fread' },
  ];
  for (const variant of variants) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RENEW_TIMEOUT_MS);
    try {
      const res = await fetch(RENEW_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json;charset=UTF-8',
          accept: 'application/json, text/plain, */*',
          origin: 'https://weread.qq.com',
          referer: 'https://weread.qq.com/web/reader/',
          'user-agent': UA,
          cookie: cookieHeader(cookies),
        },
        body: JSON.stringify(variant),
        signal: controller.signal,
      });
      const skey = extractSkey(res);
      if (skey) return skey;
    } catch {
      // 换下一种 payload 重试
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * 登录态探测专用接口：会话续期。
 *
 * 为什么不用书架/阅读接口：2026-11 实测，`/web/shelf/sync`、`/web/book/readinfo`、
 * `/web/book/underlines` 对「有效 Cookie」和「把 wr_skey 改坏的 Cookie」返回**完全相同**
 * 的 `errCode:-2012 登录超时`，只有完全不带 Cookie 时才变成 -2010。也就是说这些接口
 * 根本区分不出登录态好坏，拿它当判据会让徽标长期误报红点（用户明明能正常打卡）。
 *
 * `/web/login/renewal` 有区分力，但**只认带 `ql:true` 的请求体**（详见 RENEW_BODY 上的实测矩阵）。
 * 顺带说明：wr_skey 本身不承担主要认证作用，改坏了照样能续期 —— 真正管用的是
 * wr_vid / wr_rt 这些长期凭据。所以判断失效不能只看 wr_skey 的值。
 */
const AUTH_PROBE_URL = RENEW_URL;

/**
 * 用 Cookie 探一次登录态，判断这个 Cookie 还能不能上报。
 *
 * 为什么需要单独探：徽标读的是官方 API Key 那条通道（/readdata/detail），
 * 它和 Cookie 完全独立 —— Cookie 过期了它照样返回漂亮的阅读统计，
 * 于是侧边栏会一直显示黄/绿，直到用户真去打卡才发现早就失效了。
 * 这里用会话续期接口把「登录态」单独测出来。
 *
 * @returns {Promise<{ok:boolean, reason:string, hard:boolean}>} hard=true 表示凭据失效（该显示红点）
 */
export async function probeAuth(cookies) {
  if (!cookies?.wr_skey) return { ok: false, reason: '未配置 Cookie', hard: true };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RENEW_TIMEOUT_MS);
  try {
    const res = await fetch(AUTH_PROBE_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json;charset=UTF-8',
        accept: 'application/json, text/plain, */*',
        origin: 'https://weread.qq.com',
        referer: 'https://weread.qq.com/web/reader/',
        'user-agent': UA,
        cookie: cookieHeader(cookies),
      },
      body: JSON.stringify(RENEW_BODY),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    // 续期成功会直接下发新 wr_skey，这是最硬的「还活着」证据
    const skey = extractSkey(res);
    const code = json?.errcode ?? json?.errCode;
    if (code === -2010 || code === -2013 || res.status === 401) {
      // -2013 有两种 errMsg，含义不同，别把「缺长期凭据」笼统说成「已失效」：
      //   "鉴权失败"            → wr_rt 真失效了，确实要重贴 Cookie
      //   "params error (node)" → 缺 wr_vid / wr_rt，粘少了，也是重贴
      const detail = String(json?.errMsg ?? '');
      const reason = /params error/i.test(detail)
        ? 'Cookie 不完整（缺少 wr_vid / wr_rt），请重新复制整段 Cookie'
        : 'Cookie 已失效，需要重新粘贴';
      return { ok: false, reason, hard: true };
    }
    if (skey || json?.succ === 1) return { ok: true, reason: '', hard: false };
    if (res.status !== 200 || json === null) {
      return { ok: false, reason: `登录态探测失败（HTTP ${res.status}）`, hard: false };
    }
    // 走到这里说明接口回了、但没有续期凭证：判为失效
    return { ok: false, reason: 'Cookie 已失效，需要重新粘贴', hard: true };
  } catch (err) {
    return { ok: false, reason: `登录态探测失败：${err?.message ?? err}`, hard: false };
  } finally {
    clearTimeout(timer);
  }
}

/** 修复缺失的 synckey（源码 fix_no_synckey）。 */
async function fixSynckey(cookies) {
  await postJson(FIX_SYNCKEY_URL, { bookIds: ['3300060341'] }, cookies, REQUEST_TIMEOUT_MS);
}

/**
 * 执行一轮阅读上报。
 *
 * @param {object} options
 * @param {Record<string,unknown>} options.base 抓包得到的固定 data 模板
 * @param {Record<string,string>} options.cookies 至少含 wr_skey
 * @param {number} options.times 上报次数（每次约 30 秒）
 * @param {number} options.intervalMs 每次间隔，默认 30000
 * @param {(skey:string)=>void} [options.onSkey] 密钥刷新回调，便于持久化
 * @param {(done:number,total:number)=>void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 */
export async function runReading({
  base,
  cookies,
  times,
  intervalMs = 30000,
  onSkey,
  onProgress,
  signal,
}) {
  const jar = { ...cookies };
  let lastTime = Math.floor(Date.now() / 1000) - 30; // 源码：首次 rt 约为 30
  let done = 0;
  let repairs = 0;
  let skeyRefreshes = 0;
  const errors = [];

  const sleep = (ms) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('已取消'));
      const t = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(new Error('已取消'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });

  for (let index = 1; index <= times; index++) {
    if (signal?.aborted) break;
    const data = buildReadData(base, lastTime);
    const nowSec = data.ct;

    let res;
    try {
      res = await postJson(READ_URL, data, jar, REQUEST_TIMEOUT_MS);
    } catch (err) {
      errors.push(`第 ${index} 次请求失败：${err.message}`);
      break;
    }

    const body = res.json;
    if (body && 'succ' in body) {
      if (body.synckey !== undefined && body.synckey !== null) {
        repairs = 0;
        lastTime = nowSec;
        done = index;
        onProgress?.(done, times);
        if (index < times) {
          try {
            await sleep(intervalMs);
          } catch {
            break;
          }
        }
      } else {
        repairs++;
        if (repairs > SYNCKEY_REPAIR_LIMIT) {
          errors.push(`连续 ${SYNCKEY_REPAIR_LIMIT} 次未恢复 synckey，已中止`);
          break;
        }
        await fixSynckey(jar);
        await sleep(SYNCKEY_REPAIR_DELAY_MS).catch(() => {});
        index--; // 本次不计入，重试
      }
    } else {
      const code = body?.errCode;
      const msg = body?.errMsg ?? `HTTP ${res.status}`;
      if (AUTH_ERROR_CODES.has(code) || res.status === 401) {
        const skey = await refreshSkey(jar);
        if (skey) {
          jar.wr_skey = skey;
          skeyRefreshes++;
          onSkey?.(skey);
          index--; // 续期成功后重试本次
          continue;
        }
        errors.push(`Cookie 已失效（errCode=${code ?? '无'}），需要重新抓取`);
        break;
      }
      errors.push(`第 ${index} 次被拒绝：errCode=${code ?? '无'} ${msg}`);
      break;
    }
  }

  return {
    done,
    requested: times,
    minutes: Math.round((done * 30) / 60 * 10) / 10,
    skeyRefreshes,
    errors,
    skey: jar.wr_skey,
  };
}

export { READ_URL, RENEW_URL, FIX_SYNCKEY_URL, KEY };
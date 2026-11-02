import fs from 'node:fs';

/**
 * 回归：续期探测的请求体必须带 ql:true。
 *
 * 背景（2026-11-02）：v1.1.6 把登录态探测接口从 GET /web/shelf/sync 换成
 * POST /web/login/renewal，但请求体抄了 refreshSkey 的第一种变体 {rq, ql:false}。
 * 实测同一份有效 Cookie：
 *   {rq, ql:true}  → {"succ":1} + 下发新 wr_skey
 *   {rq, ql:false} → {"errCode":-2013,"errMsg":"鉴权失败"}，且 Set-Cookie 全清空
 * 结果所有正常用户都被判成「Cookie 已失效」，侧边栏长期红点。
 *
 * 这个 bug 不看代码根本发现不了（接口照样 200），所以必须用静态回归钉住：
 * 任何人把 ql 改回 false、或新增一条不带 ql 的探测路径，这里都要报错。
 */

const raw = fs.readFileSync('weread-api.js', 'utf8');
let bad = 0;
const ck = (name, ok) => { console.log((ok ? '✓ ' : '✗ ') + name); if (!ok) bad += 1; };

// 注释里的实测矩阵会大量提到 ql:false（那是文档，不是代码），先按行剥掉注释再检查。
// 注意不能用块注释正则：源码里有 `accept: 'application/json, text/plain, */*'`，
// 其中的 `*/` 会被当成注释结尾，把后面的函数体整段吃掉。
const code = raw
  .split('\n')
  .filter((line) => {
    const t = line.trimStart();
    return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'));
  })
  .join('\n');

// 1. RENEW_BODY 常量存在且带 ql:true
const bodyDecl = /const RENEW_BODY\s*=\s*\{([^}]*)\};/.exec(code)?.[1] ?? '';
ck('存在 RENEW_BODY 常量', bodyDecl.length > 0);
ck('RENEW_BODY 带 rq 参数', /rq\s*:\s*['"]%2Fweb%2Fbook%2Fread['"]/.test(bodyDecl));
ck('RENEW_BODY 的 ql 为 true', /ql\s*:\s*true/.test(bodyDecl));
ck('RENEW_BODY 不含 ql:false', !/ql\s*:\s*false/.test(bodyDecl));

// 2. probeAuth / renewSkeyRaw 必须直接用 RENEW_BODY
for (const [name, re] of [
  ['probeAuth', /export async function probeAuth[\s\S]*?\n\}/],
  ['renewSkeyRaw', /async function renewSkeyRaw[\s\S]*?\n\}/],
]) {
  const fn = re.exec(code)?.[0] ?? '';
  ck(`${name} 存在`, fn.length > 0);
  ck(`${name} 使用 RENEW_BODY`, /JSON\.stringify\(\s*RENEW_BODY\s*\)/.test(fn));
}

// 3. refreshSkey 的变体列表首项必须是 RENEW_BODY（ql:true 优先）
const refreshFn = /export async function refreshSkey[\s\S]*?\n\}/.exec(code)?.[0] ?? '';
ck('refreshSkey 存在', refreshFn.length > 0);
const variantBlock = /const variants\s*=\s*\[([\s\S]*?)\];/.exec(refreshFn)?.[1] ?? '';
ck('refreshSkey 有 variants 列表', variantBlock.length > 0);
ck('variants 首项是 RENEW_BODY', /^\s*RENEW_BODY\s*,/.test(variantBlock.trimStart()));
ck('refreshSkey 遍历 variants 构造请求体', /JSON\.stringify\(\s*variant\s*\)/.test(refreshFn));

// 4. 失效原因要能区分「真失效」与「粘少了」
ck('probeAuth 区分 params error（缺长期凭据）', /params error/i.test(code));
ck('缺凭据提示提到 wr_vid / wr_rt', /缺少 wr_vid\s*\/\s*wr_rt/.test(raw));

// 5. 代码里不允许再出现 ql:false（注释里的实测矩阵不算）
const qlFalseCount = (code.match(/ql\s*:\s*false/g) ?? []).length;
ck('代码中无 ql:false', qlFalseCount === 0);
if (qlFalseCount > 0) console.log(`    （发现 ${qlFalseCount} 处 ql:false）`);

// 6. 注释必须保留实测矩阵，方便后来人理解为什么是 ql:true
ck('注释保留了 ql 判定矩阵', /ql:true[\s\S]{0,200}succ/.test(raw));

console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
process.exit(bad === 0 ? 0 : 1);

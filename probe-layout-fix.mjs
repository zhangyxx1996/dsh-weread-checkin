import fs from 'node:fs';

const s = fs.readFileSync('client.js', 'utf8');
let bad = 0;
const ck = (name, ok) => { console.log((ok ? '✓ ' : '✗ ') + name); if (!ok) bad += 1; };

// 1. 滚动容器不得带 max-width（这是滚动条位置被固定的根因）
const pageCss = /\.wr-page\s*\{([^}]*)\}/.exec(s)?.[1] ?? '';
ck('.wr-page 无 max-width', !/max-width/.test(pageCss));
ck('.wr-page 有 overflow-y:auto', /overflow-y:\s*auto/.test(pageCss));
ck('.wr-page 有 height:100%', /height:\s*100%/.test(pageCss));
ck('.wr-page 有 width:100%', /width:\s*100%/.test(pageCss));

// 2. 内容容器才限宽
const innerCss = /\.wr-inner\s*\{([^}]*)\}/.exec(s)?.[1] ?? '';
ck('.wr-inner 有 max-width', /max-width/.test(innerCss));
ck('.wr-inner 有 margin:0 auto', /margin:\s*0 auto/.test(innerCss));

// 3. 自适应网格
const cardsCss = /\.wr-cards\s*\{([^}]*)\}/.exec(s)?.[1] ?? '';
ck('.wr-cards 用 auto-fit', /auto-fit/.test(cardsCss));
ck('.wr-cards 用 minmax', /minmax\(/.test(cardsCss));
ck('.wr-cards 用 min( 防溢出', /min\(/.test(cardsCss));

// 4. 渲染树真的套了 inner + cards
ck('Panel 使用 wr-inner', s.includes("className: 'wr-inner'"));
ck('Panel 使用 wr-cards', s.includes("className: 'wr-cards'"));
ck('设置页使用 wr-inner-sm', s.includes("className: 'wr-inner wr-inner-sm'"));
ck('日历跨整行 wr-cell-wide', s.includes('wr-cell-wide'));

// 5. 括号平衡（粗检：对 h( 调用计深度）
let depth = 0, neg = 0;
const src = s;
for (let i = 0; i < src.length; i += 1) {
  const c = src[i];
  if (c === '(' ) depth += 1;
  else if (c === ')') { depth -= 1; if (depth < 0) neg += 1; }
}
console.log('括号净深度（含字符串内括号，仅供参考）=', depth, '负深度次数=', neg);

console.log(bad === 0 ? '全部通过 ✅' : `${bad} 项失败 ❌`);
process.exit(bad === 0 ? 0 : 1);

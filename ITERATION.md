# 自我迭代日志

每天中午 12:00 由定时任务触发一次自我迭代，方向：**功能 BUG 优先，其次 UI 审美**。

规则：

- 每轮先读本文件，**不要重复已经做过的改动**。
- 每轮只挑 **1–3 个真问题**（有证据、能复现、影响使用），不做无关重构。
- 改完必须有 **probe 断言锁定**，四个回归脚本（`probe-client-run.mjs` / `probe-host.mjs` /
  `probe-layout-fix.mjs` / `probe-auth-renewal.mjs`）全部 exit=0 才算通过。
- 发版走 `release.ps1`，版本号 patch +1。
- 每轮在下面追加一节。

---

## v1.1.9 — 2026-11-02

本轮主题：**今日卡片的信息重复与数组语义错用**。三处都在 `client.js`。

### 1. 上报「次数」被当成「分钟」显示（功能 BUG）

`progress.done` / `progress.total` 是**上报次数**（每次 30 秒），旧代码直接拼成
`已运行 ${Math.min(done, total)}/${total} 分钟`。20 次会在界面上显示成「20 分钟」，
而实际只有 10 分钟——数字和单位对不上，用户会以为插件多报了一半时长。

改成 `const totalMin = total * 30 / 60;`，并在注释里写明「次数 ≠ 分钟」。

### 2. 同一屏把「已运行 N 分钟」说了三遍（UI）

v1.1.3 把文案从「打卡中 N 次」改成「已运行 N 分钟」时只改了按钮，状态行跟着重复了。
运行时状态行、主按钮、停止按钮三处显示同一句话，信息密度为零。

现在按职责拆开：

| 位置 | 内容 | 变化频率 |
|---|---|---|
| 状态行 | `已运行 4 分钟` | 每 30 秒 |
| 主按钮 | `本次补 10 分钟` / `不设上限，随时可以停` | 静态（本次目标） |
| 停止按钮 | `停止打卡` | 不变 |

### 3. 「上次运行」挂在错误的字段上（功能 BUG）

原来显示条件是 `data.lastDayDone`，它的含义是「**今天**跑成功过」。于是零点一过、
当天还没打卡时，整块「上次运行」消失——可用户恰恰在这个时候最想知道上次是什么时候跑的。

改成只看 `data.lastRunAt` 有没有值。新增 `fmtRunClock(ts)`：当天显示 `HH:MM`，
跨天显示 `MM-DD HH:MM`，避免把昨天的 23:40 误读成今天。

### 4. 顺手清掉死 CSS（UI 卫生）

v1.1.5 删掉「读得最多」区块后，整套周柱状图样式（`.wr-bars` / `.wr-bar-*`）
和旧书列表样式（`.wr-book*`）留在 CSS 里没人用了，约 33 行。`.wr-mono`、
`.wr-btn-stop` 同样是只定义不使用。全部删除，并加断言禁止它们回来。

### 回归断言（`probe-client-run.mjs` 第 14 节新增）

- `total=20` 时必须出现「本次补 10 分钟」、不得出现「本次补 20 分钟」
- `done=8` 时必须出现「已运行 4 分钟」
- 整页文本里「已运行」只能出现 **1 次**（状态行），按钮不得重复
- 跨天 `lastRunAt` 显示 `10-30 23:40`；当天只显示 `HH:MM`、不带日期前缀
- `.wr-bar-col` / `.wr-bar-today` / `.wr-book-cover` / `.wr-book-title` /
  `.wr-mono` / `.wr-btn-stop` 均不得出现在 CSS 里

### 顺带修的文档

README「界面」章节还写着 v1.1.3 之前的「打卡中 6/20」，与实际不符，已同步。

---

## v1.2.0 — 2026-11-02（追加需求：加新功能）

本轮主题：**从「只打卡」扩成「打卡 + 阅读沉淀」**。用户提出「搜索一下网上类似功能的插件
添加一些新功能」，于是先做了竞品与官方能力盘点，再落地。

### 调研结论（决定了做什么、以及不做什么）

竞品里 star 最高的几款（weread2notion-pro 3.4k、weread-exporter 2.4k、
obsidian-weread-plugin）主打的全是**笔记/划线的导出与统计沉淀**，「自动打卡」反而不是卖点。
官方 weread-skills 里已经有 `/user/notebooks`、`/book/bookmarklist`、`/review/list/mine`
这些笔记接口，但本插件此前只用了 `/readdata/detail` 和 `/shelf/sync` 两个——数据都在，
只是一直没取。

明确**不做**：自动阅读/挂机（要模拟阅读上报，风险与合规成本都高）、整本书导出
（和打卡插件定位无关）、体验卡兑换（没有官方接口）。

### 1. 阅读画像卡（新功能）

一张卡把 `/readdata/detail?mode=overall` 里此前完全没用过的字段捞出来：

- **24 小时时段分布**：柱状图，峰值那根高亮，配官方给的 `preferTimeWord` 文案
- **偏好分类排行**：按累计时长降序，带 `N 本`
- **常读作者**：chips，超过 4 位折叠（`authorCount` 单独显示）
- **勋章**：chips，`title` 悬停显示 `rankText`，超过 4 枚可展开

**踩到并绕开的坑**：`preferTime` 是 24 个数，但**下标 0 是早上 6 点**，不是 0 点。
重排必须在服务端做一次（`byHour[(i + 6) % 24] = raw[i]`），前端拿到的一律是自然顺序。
probe 里把峰值固定在 15 点——谁要是在前端再位移一次，断言会立刻报出 21 点。

### 2. 笔记与划线卡（新功能）

两级懒加载：点「查看我的笔记」才拉 `/user/notebooks`（游标分页，`hasMore` 用最后一条
`sort` 续页），点某本书才拉那本书的 `/book/bookmarklist`。划线动辄几百字，全量预取会把
一次面板渲染变成几十个请求。

**踩到并绕开的坑（两个）**：

1. `noteCount` 和 `bookmarkCount` **不是「想法 / 划线」的二分**。实测「活着」
   `noteCount=7 bookmarkCount=0`，而 `/book/bookmarklist` 照样返回 7 条划线原文。
   所以不能按字段名当语义用，界面只显示三者之和，具体几条划线以展开后为准。
2. `bookmarklist` 的 `updated` **只含划线，不含想法**。「囚徒健身」在笔记本里 7 条，
   这里返回 0 条——那 7 条是 thoughts。所以「有笔记但拉不到划线」是正常现象，
   卡片要如实说「这本书的笔记是想法，不是划线原文」，而不是显示成空列表让人以为丢数据。

### 3. 取数策略（UI 与性能）

两张新卡都**进界面不请求**，和已有的书架缓存策略一致。首屏已经有 `dashboard` 在并行拉
三次（weekly / monthly / overall），再叠两个全量卡片会让打开面板变慢。
probe 里显式断言：进界面时 `requested` 里不得出现 `/profile`、`/notebooks`、`/bookmarks`。

### 回归断言

`probe-client-run.mjs` 第 15 节：

- 进界面不请求 `/profile` / `/notebooks`；点了按钮才请求
- 画像：24 根柱子一根不少、峰值柱有 `wr-hours-bar-peak`、`最常在 15 点`（锁住不许二次位移）
- 笔记：列表出来时**不预取任何书的划线**；点某本书才请求 `/bookmarks`
- 划线为空时文案必须含「想法」，不能是空列表
- 新卡片用到的 `.wr-hours` / `.wr-rank` / `.wr-note-row` / `.wr-mark` 必须在样式表里

`probe-host.mjs` 新增三段（打真实接口）：

- `profile`：hours 必须 24 桶、合计小时数与峰值、分类/作者/勋章齐全
- `notebooks`：**官方 `totalNoteCount` 与自行累加的 `noteTotal` 必须相等**（两个口径互校）
- `bookmarks`：自动挑一本 `raw[0] > 0`（真有划线）的书来测——不能取 `books[0]`，
  排第一的那本很可能整本都是想法，会返回 0 条，等于没验证

### 说明：为什么画像与笔记合成一个版本

原计划分成 v1.2.0（画像）和 v1.3.0（笔记）两步，因为担心的风险不同。实际写完后两者
都是「只读 + 懒加载卡片」，共用同一套调用与渲染模式，拆开发版只会产生两次无意义的重跑，
故合并为 v1.2.0。

---

## v1.2.1 — 2026-11-02（第 3 轮）

本轮主题：**异步请求的在途竞态**。三处都在 `client.js`，全是「连点 / 换书」造成的错数据与重复请求。

### 1. 画像卡、笔记卡的「刷新」没有在途锁（功能 BUG）

`load` 里用 `if (loading) return;` 挡连点——**挡不住**。`loading` 是 state，要等重渲染才更新；
同一个渲染周期里连点两下，两次闭包里的 `loading` 都还是 `false`，于是两次请求都发出去。
`/profile` 是一次 overall 统计，`/notebooks` 是游标分页最多 5 页，连点等于成倍放大开销；
更糟的是后到的旧响应会盖掉先到的新数据。

改用 `const busyRef = React.useRef(false)`：ref 是同步可见的，置位立刻生效。
`useCallback` 的依赖数组也回到 `[]`（原来依赖 `loading`，每轮都重建回调，等于没有 memo）。

### 2. 笔记卡换书竞态 → 展开区显示「另一本书」的划线（功能 BUG，最严重）

点开《看不见的城市》还没返回，又点了《活着》：前者响应后到时 `setMarks(res)` 照样执行，
把 A 书的划线写进 B 书的展开区——**用户看到的是张冠李戴的错数据**；A 的
`finally` 还会 `setMarkLoading(false)`，提前结束 B 的「正在读取…」。

加 `const wantRef = React.useRef('')`：点开时先写 `wantRef.current = bookId`，
`.then/.catch/.finally` 三处都先判 `if (wantRef.current !== bookId) return;`，后到的旧响应直接丢弃。

### 3. 设置页「刷新密钥」无在途态（功能 BUG）

连点会并发多个 `/renew`，每个都会改一次 `wr_skey`，后到的可能覆盖先到的凭据。
补 `renewing` state + `renewingRef` 双保险：state 负责 UI（按钮变「刷新中…」并 `disabled`），
ref 负责拦截同一 tick 内的连点（`disabled` 也要等重渲染才生效）。

### 4. probe 模拟器自身的缺陷（测试基建）

写第 1 条的断言时发现 `makeReact` 里的 `useRef(v) { current.cursor++; return { current: v }; }`
**每次渲染都新建对象**，ref 在模拟器里永远是初值。也就是说：任何用 ref 做的锁、序号、
防抖，在 probe 里都测不出来，测出来的是模拟器的 bug。

修法是给 store 加独立 `refs` 槽位，按 hook 序号缓存：

```js
useRef(v) {
  const s = current;
  const i = s.cursor++;
  if (!Object.prototype.hasOwnProperty.call(s.refs, i)) s.refs[i] = { current: v };
  return s.refs[i];
}
```

并新增一条**自检断言**：组件里 `r.current = 'changed'`，第二次渲染必须读到 `'changed'`。
这条断言本身绿了，上面三条 ref 锁的断言才可信。这是个容易反复踩的坑，写进这里备查。

### 回归断言（`probe-client-run.mjs` 新增第 16–18 节）

- 画像卡：`pendingHolds.add('profile')` 挂住请求后连点两次「刷新」→ `/profile` 计数必须为 **1**
- 笔记卡同理 → `/notebooks` 计数必须为 **1**
- 换书竞态：`delays.set('bookmarks', [120, 0])`，先点《看不见的城市》再点《活着》，
  等 200ms 后展开区必须是《活着》的原文，且**不得出现**《看不见的城市》的句子
- 竞态后功能不退化：再点同一本必须正常收起
- 刷新密钥：在途时按钮 `disabled === true` 且文案为「刷新中…」；连点只发 1 次 `/renew`
- 模拟器自检：`useRef` 必须跨渲染保留

一个顺带修的坑：`clickButton` 原来按文字全局找按钮，而画像卡和笔记卡**都有叫「刷新」的按钮**，
点错卡片会让断言假通过。新增 `clickInSection(comp, props, 卡片标题, 按钮文字)` 限定在
`.wr-section` 内查找；`clickButton` 也支持 `{ exact: true }`（「刷新」是「刷新中…」的子串）。
汇总行的「请求过的接口」改为读全量 `allRequested`，否则会被各小节的 `requested.length = 0` 清空。

四个探针全部 exit=0；`probe-host.mjs` 用真实 Key 跑通（画像 116.2h / 峰值 23 点 / 73 位作者 /
10 枚勋章；笔记本 7 本 23 条两口径一致；划线带章节与时间倒序）。

---

## 待办（下一轮候选）

按优先级排，下轮从上面挑，不要重复已做的：

1. **日历月视图合计用 `fmtDuration`**，几十小时会显示成「41.2 小时」这种带小数的形式，
   而周视图同样位置显示的是「N 天达标 · 合计 X 小时 Y 分钟」——两种视图的合计口径不统一。
2. **书架「时长覆盖 N/M 本」**：M 取的是书架总数，但时长只可能来自「读得最多」榜，
   分母其实是无法达到的，文案容易让人误以为覆盖率低是自己没读完。
3. 面板在打卡进行中每 30 秒轮询 `status`，但**不轮询 `dashboard`**（`RUN_POLL_MS` 只调
   `refreshRuntime`）。今日时长靠 `todaySec + done * 30` 估算，实际落库值要等到收尾才刷新。
4. `probe-client-run.mjs` 的假数据里 `status.today` 是日期字符串、`dashboard.today` 是对象，
   两者同名不同型——这正是 v1.1.8 那个「今日时长归零」bug 的现场，值得在 probe 里
   单独加一条断言固定住（目前是被动覆盖到，没有显式断言）。
5. **笔记卡还没有「想法」内容**。`/review/list/mine` 是唯一能读到想法/点评正文的接口，
   但本机账号 `totalCount=0`，真机无法自测；要做得先能造出测试数据，或只做只读展示并
   在空态上说清楚。
6. **阅读画像卡可以再挖 `preferTimeWord` 之外的字段**：`readLongest` 的前 10 名、
   `preferPublisher`、`registTime`（注册天数）都能直接展示，目前只用了分类/作者/勋章/时段。
7. **热门划线**（`/book/bestbookmarks`，每本书固定 20 条 + 多少人划过）已经实测可用，
   可以接进笔记卡作为「这本书大家都在划什么」，是个明显有内容吸引力的维度。


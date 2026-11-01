/**
 * 微信读书打卡插件 —— 浏览器半边。
 *
 * 界面分两块：
 *   主面板（左侧栏图标进入）—— 今日进度、目标与档位、周/月日历、书架、累计
 *   设置页（插件页）—— Cookie / 请求体模板 / API Key 分区配置
 *
 * 数据获取时机（v0.3.0 起的约定）：
 *   · 空闲时：进入界面拉一次 dashboard，之后不再轮询
 *   · 打卡进行中：每 30 秒刷新一次，进度条与按钮文案跟着走
 *   · 日历历史 / 书架：点到那个模块时才请求，之后本地缓存
 *
 * 视觉参考 iOS：分组卡片、大圆角、分段控件、柔和阴影。
 * 样式只用 --dsw-alias-* 主题令牌，不引入任何 Harness Client 包。
 */

window.__ModuleLoader__.load({
  id: 'dsh-weread-checkin',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PANEL_ID = 'dsh-weread-checkin';
    /**
     * 版本号兜底值：正常情况下用 Host 经 status 下发的 `version`（读自
     * package.json），这里只在接口没返回时兜底，避免界面出现空白。
     */
    const PLUGIN_VERSION = '1.1.0';
    /** 可选的「打卡时长」（分钟）：一次点击最多补这么多。 */
    const MINUTE_OPTIONS = [5, 10, 15, 20, 30, 45, 60];
    /** 可选的「每日目标」（分钟）：进度条与日历达标都按它判定。 */
    const GOAL_OPTIONS = [5, 10, 15, 20, 30, 45, 60];
    /** 徽标轮询间隔。 */
    const BADGE_POLL_MS = 2 * 60 * 1000;
    /** 打卡进行中的数据刷新间隔。 */
    const RUN_POLL_MS = 30 * 1000;
    /** 历史数据最早从这天开始（服务端 2026 年之前的逐日桶拿不到）。 */
    const HISTORY_FLOOR_YMD = '2026-01-01';

    /**
     * 注入样式表。打包插件拿不到 dynamic Client half 才有的 `styles` builtin，
     * 所以照 dsh-free-search / dsh-cost-meter / dsh-better-sidebar 的做法自己建
     * <style> 标签。tag id 供 DevTools 辨认来源。
     */
    function injectCss(css) {
      const TAG_ID = PANEL_ID + '/client.css';
      if (typeof document === 'undefined' || document.head == null) return () => {};
      const selector = 'style[data-plugin-css=' + JSON.stringify(TAG_ID) + ']';
      const existing = document.querySelector(selector);
      if (existing !== null) {
        existing.textContent = css;
        return () => {};
      }
      const tag = document.createElement('style');
      tag.dataset.plugin = PANEL_ID;
      tag.dataset.pluginCss = TAG_ID;
      tag.textContent = css;
      document.head.appendChild(tag);
      return () => {
        tag.parentNode?.removeChild(tag);
      };
    }

    const CSS = `
/* ===== 页面骨架：iOS 分组列表观感 ===== */
/*
 * 滚动：DSH 的 main 面板外层（.centerCol）是 display:flex + overflow:hidden，
 * 子元素高度 auto 时会被直接裁掉而不是产生滚动条。所以这里必须自己撑满高度
 * 并把滚动交给本节点：height:100% + min-height:0 + overflow-y:auto。
 *
 * 注意 scroll 容器本身**不能**加 max-width：一旦容器被收窄，滚动条就会贴在那个
 * 收窄后的盒子右缘（看起来像"固定在页面中间"），而不是像浏览器那样贴面板右缘。
 * 宽度约束放到内层 .wr-inner 上，滚动条才会跟着面板宽度走。
 */
.wr-page {
  box-sizing: border-box;
  width: 100%; height: 100%; min-height: 0; flex: 1 1 auto;
  overflow-y: auto; overflow-x: hidden;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  color: var(--dsw-alias-label-primary);
  font-size: 13px; line-height: 1.55;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI",
    "PingFang SC", "Microsoft YaHei", sans-serif;
  -webkit-font-smoothing: antialiased;
  scrollbar-width: thin;
  scrollbar-color: var(--dsw-alias-border-l2) transparent;
}
.wr-page::-webkit-scrollbar { width: 10px; height: 10px; }
.wr-page::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-border-l2); border-radius: 999px;
  border: 2px solid transparent; background-clip: content-box;
}
.wr-page::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-border-l3); background-clip: content-box; }
.wr-page::-webkit-scrollbar-track { background: transparent; }

/* 内容容器：限制的是**内容**宽度，不是滚动条位置 */
.wr-inner {
  box-sizing: border-box; width: 100%; min-width: 0;
  max-width: 1180px; margin: 0 auto; padding: 18px 20px 40px;
}
.wr-inner-sm { max-width: 820px; }

/*
 * 设置页（plugins.bundle.config 槽位）专用：交出滚动权。
 *
 * 宿主把这个插件挂在一个 section 里，外面是插件的详情页，真正的滚动容器
 * 是祖先 .V7pFBG_page（height:100% + overflow:auto）。这里如果沿用 .wr-page
 * 的 height:100% + overflow-y:auto，高度会解析成"内容有多高就多高"，于是
 * 自己形成一个永远滚不动的内层盒子，同时把外层的滚动也算成了"已显示"，
 * 结果上下都滚不了。所以设置页让内容自然撑开，滚动交给宿主。
 */
.wr-page-flat {
  height: auto; min-height: 0; flex: 0 0 auto;
  overflow: visible;
  scrollbar-width: auto;
}
.wr-page-flat::-webkit-scrollbar { width: auto; height: auto; }

/* 卡片自适应网格：窗口变宽自动多列，变窄自动回落单列 */
.wr-cards {
  display: grid; min-width: 0; align-items: start;
  grid-template-columns: repeat(auto-fit, minmax(min(340px, 100%), 1fr));
  gap: 14px;
}
.wr-cell { min-width: 0; }
.wr-cell-wide { grid-column: 1 / -1; }
.wr-cards > .wr-cell > .wr-section { margin-bottom: 0; }

.wr-section { margin-bottom: 22px; min-width: 0; }
.wr-section-title {
  font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary);
  padding: 0 4px 8px; letter-spacing: .2px;
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
}
.wr-section-title > span { flex: 1; min-width: 0; }
.wr-group {
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 16px; overflow: hidden;
  box-shadow: 0 1px 2px rgba(0,0,0,.04), 0 6px 20px -12px rgba(0,0,0,.18);
}
.wr-group-pad { padding: 16px; }
.wr-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; padding: 13px 16px;
}
.wr-row + .wr-row { border-top: 1px solid var(--dsw-alias-border-l1); }
.wr-row-label { font-size: 13.5px; }
.wr-row-value { font-size: 13px; color: var(--dsw-alias-label-secondary); }
/* 面板底部的版本行 */
.wr-version {
  margin-top: 18px; text-align: center;
  font-size: 10.5px; letter-spacing: .2px;
  color: var(--dsw-alias-label-secondary); opacity: .75;
}

.wr-muted { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.wr-ok { color: var(--dsw-alias-state-success-primary); }
.wr-warn { color: var(--dsw-alias-state-warn-primary); }
.wr-err { color: var(--dsw-alias-state-error-primary); }
.wr-mono { font-variant-numeric: tabular-nums; }

/* ===== 今日主卡 ===== */
.wr-hero-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.wr-hero-label {
  font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary);
  letter-spacing: .3px; text-transform: uppercase;
}
.wr-hero-value {
  display: flex; align-items: baseline; gap: 5px; margin-top: 2px;
  font-size: 44px; font-weight: 700; letter-spacing: -1.6px; line-height: 1.05;
  font-variant-numeric: tabular-nums;
}
.wr-hero-goal { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-secondary); letter-spacing: 0; }
.wr-hero-unit { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-secondary); letter-spacing: 0; }
.wr-hero-state { margin-top: 8px; font-size: 12.5px; font-weight: 500; }
.wr-hero-meta { margin-top: 5px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }

/* 细进度条 */
.wr-track {
  height: 8px; border-radius: 999px; margin-top: 14px;
  background: var(--dsw-alias-bg-layer-2); overflow: hidden;
}
.wr-track-fill {
  height: 100%; border-radius: 999px;
  background: var(--dsw-alias-brand-primary);
  transition: width .45s cubic-bezier(.4,0,.2,1);
}
.wr-track-fill-on { background: var(--dsw-alias-state-success-primary); }
.wr-track-legend {
  display: flex; justify-content: space-between;
  margin-top: 6px; font-size: 11px; color: var(--dsw-alias-label-secondary);
}

/* ===== 分段控件（iOS Segmented Control） ===== */
.wr-seg {
  display: flex; gap: 2px; padding: 2px; border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2);
}
.wr-seg-item {
  flex: 1; padding: 6px 0; border: none; border-radius: 8px; cursor: pointer;
  background: transparent; color: var(--dsw-alias-label-secondary);
  font-size: 12.5px; font-weight: 500; font-family: inherit;
  font-variant-numeric: tabular-nums; transition: background .18s, color .18s;
}
.wr-seg-item:hover:not(.wr-seg-on):not(:disabled) { color: var(--dsw-alias-label-primary); }
.wr-seg-item:disabled { cursor: default; opacity: .55; }
.wr-seg-on {
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font-weight: 600; box-shadow: 0 1px 3px rgba(0,0,0,.14);
}
.wr-seg-sm .wr-seg-item { padding: 4px 10px; font-size: 11.5px; flex: none; }

/* ===== 按钮 ===== */
.wr-btn {
  width: 100%; padding: 12px 16px; border-radius: 12px; cursor: pointer;
  font-size: 14px; font-weight: 600; font-family: inherit;
  border: none; background: var(--dsw-alias-brand-primary); color: #fff;
  transition: opacity .16s, transform .08s, background .16s;
  display: flex; align-items: center; justify-content: center; gap: 8px;
  font-variant-numeric: tabular-nums;
}
.wr-btn:hover:not(:disabled) { opacity: .9; }
.wr-btn:active:not(:disabled) { transform: scale(.985); }
.wr-btn:disabled { opacity: .45; cursor: default; }
/* 打卡进行中：固定灰色、不可点 */
.wr-btn-loading,
.wr-btn-loading:disabled {
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  opacity: 1; cursor: not-allowed;
  border: 1px solid var(--dsw-alias-border-l1);
}
.wr-btn-done:disabled { background: var(--dsw-alias-state-success-primary); color: #fff; opacity: 1; cursor: default; }
.wr-btn-ghost {
  padding: 6px 13px; border-radius: 999px; cursor: pointer;
  font-size: 12.5px; font-weight: 500; font-family: inherit;
  border: 1px solid var(--dsw-alias-border-l2); background: transparent;
  color: var(--dsw-alias-label-primary); transition: background .16s;
}
.wr-btn-ghost:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.wr-btn-ghost:disabled { opacity: .45; cursor: default; }
.wr-btn-sm { padding: 5px 11px; font-size: 12px; }
/* 无限模式下的「停止」：不动用危险红，只是一眼能看出可以点 */
.wr-btn-stop {
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l2);
  cursor: pointer;
}
.wr-btn-stop:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-3); }
.wr-stop-icon {
  width: 9px; height: 9px; flex: none; margin-right: 2px;
  border-radius: 2px; background: currentColor;
}

/* 「继续打卡」的时长询问面板 */
.wr-ask {
  margin-top: 12px; padding: 12px 13px;
  border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
}
.wr-ask-title { font-size: 12.5px; font-weight: 600; margin-bottom: 9px; }
.wr-ask-row { display: flex; align-items: center; gap: 8px; }
.wr-ask-row .wr-input { flex: 1; min-width: 0; }
.wr-ask-unit { font-size: 12.5px; color: var(--dsw-alias-label-secondary); flex: none; }
.wr-ask-actions { display: flex; gap: 8px; margin-top: 9px; }
.wr-ask .wr-hint { margin: 7px 0 0; }

/* 打卡中的转圈 */
.wr-spin {
  width: 12px; height: 12px; border-radius: 50%; flex: none;
  border: 2px solid var(--dsw-alias-border-l2);
  border-top-color: var(--dsw-alias-label-secondary);
  animation: wr-spin .9s linear infinite;
}
@keyframes wr-spin { to { transform: rotate(360deg); } }

/* ===== 提示条 ===== */
.wr-notice {
  border-radius: 12px; padding: 11px 14px; font-size: 12.5px; font-weight: 500;
  display: flex; gap: 8px; align-items: flex-start; line-height: 1.45;
}
.wr-notice-ok { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); color: var(--dsw-alias-state-success-primary); }
.wr-notice-err { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); color: var(--dsw-alias-state-error-primary); }
.wr-notice-warn { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent); color: var(--dsw-alias-state-warn-primary); }

/* ===== 周柱状 ===== */
.wr-bars { display: flex; align-items: flex-end; gap: 7px; height: 92px; }
.wr-bar-col {
  flex: 1; display: flex; flex-direction: column; align-items: center;
  gap: 7px; height: 100%; justify-content: flex-end;
}
.wr-bar {
  width: 100%; max-width: 30px; min-height: 4px; border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2);
  transition: height .4s cubic-bezier(.4,0,.2,1);
}
.wr-bar-on { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 60%, transparent); }
.wr-bar-today { background: var(--dsw-alias-state-success-primary); }
.wr-bar-label { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.wr-bar-label-on { color: var(--dsw-alias-label-primary); font-weight: 700; }

/* ===== 日历：达标绿 / 未达标红 ===== */
.wr-cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; }
/*
 * 日历跨整行时会随面板变宽而拉长，格子是 aspect-ratio:1/1 的方块，
 * 于是会变成巨大的方格。这里给格子设上限宽度并把整列居中，
 * 宽屏下保持正常的日历观感而不是撑满一行。
 */
.wr-cal-inner { width: 100%; max-width: 520px; margin: 0 auto; }
.wr-cal-dow {
  text-align: center; font-size: 10.5px; font-weight: 600;
  color: var(--dsw-alias-label-secondary); padding-bottom: 2px;
}
.wr-cal-cell {
  aspect-ratio: 1 / 1; border-radius: 9px; display: flex;
  flex-direction: column; align-items: center; justify-content: center;
  font-size: 11px; font-variant-numeric: tabular-nums;
  border: 1.5px solid transparent; position: relative;
  transition: transform .12s; gap: 1px;
}
.wr-cal-cell:hover:not(.wr-cal-empty) { transform: scale(1.07); }
.wr-cal-empty { visibility: hidden; }
.wr-cal-day { line-height: 1.1; }
.wr-cal-min { font-size: 8.5px; opacity: .75; line-height: 1; }

/* 未达标 / 未读：红系 */
.wr-cal-red-0 { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 6%, transparent); color: var(--dsw-alias-label-secondary); }
.wr-cal-red-1 { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent); color: var(--dsw-alias-label-primary); }
.wr-cal-red-2 { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent); color: var(--dsw-alias-label-primary); }
/* 达标：绿系 */
.wr-cal-ok-1 { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 26%, transparent); color: var(--dsw-alias-label-primary); }
.wr-cal-ok-2 { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 48%, transparent); color: var(--dsw-alias-label-primary); }
.wr-cal-ok-3 { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 70%, transparent); color: #fff; }
.wr-cal-ok-4 { background: var(--dsw-alias-state-success-primary); color: #fff; }
.wr-cal-today { border-color: var(--dsw-alias-label-primary); font-weight: 700; }
.wr-cal-future { opacity: .28; }
.wr-legend {
  display: flex; align-items: center; gap: 5px; justify-content: flex-end;
  margin-top: 12px; font-size: 10.5px; color: var(--dsw-alias-label-secondary);
}
.wr-legend-sq { width: 11px; height: 11px; border-radius: 4px; }
.wr-cal-nav { display: flex; align-items: center; gap: 6px; }
.wr-cal-nav-btn {
  border: 1px solid var(--dsw-alias-border-l2); background: transparent;
  color: var(--dsw-alias-label-primary); width: 24px; height: 24px;
  border-radius: 8px; cursor: pointer; font-family: inherit; font-size: 13px;
  line-height: 1; display: flex; align-items: center; justify-content: center;
}
.wr-cal-nav-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.wr-cal-nav-btn:disabled { opacity: .35; cursor: default; }
.wr-cal-nav-label { font-size: 12.5px; font-weight: 600; min-width: 92px; text-align: center; font-variant-numeric: tabular-nums; }

/* ===== 统计 ===== */
.wr-stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--dsw-alias-border-l1); }
.wr-stat-cell { background: var(--dsw-alias-bg-layer-1); padding: 14px 16px; }
.wr-stat-label { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.wr-stat-value {
  font-size: 22px; font-weight: 700; margin-top: 3px;
  letter-spacing: -.6px; font-variant-numeric: tabular-nums;
}
.wr-stat-unit { font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-secondary); margin-left: 2px; letter-spacing: 0; }
.wr-chips { display: flex; flex-wrap: wrap; gap: 7px; }
.wr-chip {
  display: inline-flex; align-items: baseline; gap: 5px;
  padding: 5px 11px; border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2); font-size: 11.5px;
}
.wr-chip-k { color: var(--dsw-alias-label-secondary); }
.wr-chip-v { font-weight: 650; font-variant-numeric: tabular-nums; }

/* ===== 书列表 ===== */
.wr-book { display: flex; gap: 11px; align-items: center; padding: 9px 0; }
.wr-book + .wr-book { border-top: 1px solid var(--dsw-alias-border-l1); }
.wr-book-cover {
  width: 32px; height: 43px; border-radius: 5px; object-fit: cover;
  background: var(--dsw-alias-bg-layer-2); flex: none;
  box-shadow: 0 1px 3px rgba(0,0,0,.16);
}
.wr-book-main { flex: 1; min-width: 0; }
.wr-book-title {
  font-size: 13px; font-weight: 500;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.wr-book-sub { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.wr-book-time {
  font-size: 12.5px; color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums; flex: none; text-align: right;
}
.wr-book-time b { color: var(--dsw-alias-label-primary); font-weight: 650; }

/* ===== 书架封面网格 ===== */
.wr-cover-grid {
  display: grid; min-width: 0;
  grid-template-columns: repeat(auto-fill, minmax(64px, 1fr));
  gap: 12px 10px;
}
/* 默认只露两排：配合封面固定高度，用 max-height 精确裁切 */
.wr-cover-grid-clip { overflow: hidden; }
.wr-cover-tile { min-width: 0; text-align: center; }
.wr-cover {
  display: block; width: 100%; border-radius: 6px; object-fit: cover;
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: 0 1px 4px rgba(0, 0, 0, .18);
}
.wr-cover-none {
  display: flex; align-items: center; justify-content: center;
  color: var(--dsw-alias-label-secondary);
}
.wr-cover-time {
  margin-top: 5px; font-size: 10.5px; line-height: 1.3;
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* ===== 表单 ===== */
.wr-field { padding: 14px 16px; }
.wr-field + .wr-field { border-top: 1px solid var(--dsw-alias-border-l1); }
.wr-label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 7px; }
.wr-label-tip { font-weight: 400; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.wr-input, .wr-area {
  width: 100%; box-sizing: border-box; padding: 9px 11px; border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
  font-size: 12.5px; font-family: inherit; transition: border-color .16s;
}
.wr-area {
  min-height: 78px; resize: vertical;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 11.5px;
}
.wr-input:focus, .wr-area:focus {
  outline: none; border-color: var(--dsw-alias-brand-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent);
}
.wr-hint { font-size: 11.5px; color: var(--dsw-alias-label-secondary); margin-top: 7px; line-height: 1.5; }
.wr-ol { margin: 8px 0 0 17px; padding: 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.wr-ol li { margin-bottom: 5px; }

/* ===== 状态点 ===== */
.wr-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); flex: none; }
.wr-dot-on { background: var(--dsw-alias-state-success-primary); }
.wr-dot-off { background: var(--dsw-alias-state-error-primary); }
.wr-chip-status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); }

/* ===== 侧边栏图标徽标 ===== */
.wr-nav { position: relative; display: inline-flex; align-items: center; justify-content: center; }
.wr-nav-dot {
  position: absolute; top: -1px; right: -2px;
  width: 7px; height: 7px; border-radius: 50%;
  border: 1.5px solid var(--dsw-alias-bg-layer-1);
  box-sizing: content-box; transition: background .3s;
}
.wr-nav-dot-green { background: var(--dsw-alias-state-success-primary); }
.wr-nav-dot-yellow { background: var(--dsw-alias-state-warn-primary); }
.wr-nav-dot-red { background: var(--dsw-alias-state-error-primary); }
.wr-nav-dot-idle { background: transparent; border-color: transparent; }

.wr-empty { text-align: center; padding: 30px 14px; color: var(--dsw-alias-label-secondary); font-size: 12.5px; }
`;

    /**
     * 分钟数（固定单位，不换算成小时）。调用方自己拼「分钟」。
     * 注意：不要在这里做 >=60 分钟的换算，否则会把小时数当成分钟数显示。
     */
    function fmtMin(sec) {
      if (sec === null || sec === undefined) return '—';
      const m = Math.round((sec / 60) * 10) / 10;
      return `${m}`;
    }
    /** 拆成「数值 + 单位」，供大数字排版用（分钟过 60 自动进位成小时）。 */
    function fmtSplit(sec) {
      if (sec === null || sec === undefined) return { value: '—', unit: '' };
      if (sec < 60) return { value: `${Math.round(sec)}`, unit: '秒' };
      const m = Math.round((sec / 60) * 10) / 10;
      if (m < 60) return { value: `${m}`, unit: '分钟' };
      const hrs = sec / 3600;
      return { value: `${hrs >= 10 ? Math.round(hrs) : hrs.toFixed(1)}`, unit: '小时' };
    }
    /** 带单位的时长，按量级自动选 秒 / 分钟 / 小时。 */
    function fmtDuration(sec) {
      if (sec === null || sec === undefined) return '—';
      const { value, unit } = fmtSplit(sec);
      return `${value} ${unit}`;
    }
    function fmtHour(sec) {
      if (sec === null || sec === undefined) return '—';
      const hrs = sec / 3600;
      return hrs >= 10 ? `${Math.round(hrs)}` : `${hrs.toFixed(1)}`;
    }
    function fmtClock(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      const p = (n) => String(n).padStart(2, '0');
      return `${p(d.getHours())}:${p(d.getMinutes())}`;
    }
    function dowLabel(i) {
      return ['日', '一', '二', '三', '四', '五', '六'][i] ?? '';
    }

    /** 本地日期 → "YYYY-MM-DD"；不能用 toISOString（那是 UTC，东八区会偏一天）。 */
    function ymdLocal(d) {
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }
    /** 从 "YYYY-MM-DD" 取本地星期几（按本地解析，避免 UTC 偏移）。 */
    function dowOfYmd(ymd) {
      const parts = ymd.split('-').map(Number);
      return new Date(parts[0], parts[1] - 1, parts[2]).getDay();
    }
    /** "YYYY-MM-DD" 加天数，返回新的 ymd。 */
    function addDaysYmd(ymd, delta) {
      const parts = ymd.split('-').map(Number);
      const d = new Date(parts[0], parts[1] - 1, parts[2] + delta);
      return ymdLocal(d);
    }
    /** 某天所在周的**周一**（本地）对应的 ymd。 */
    function weekStartYmd(ymd) {
      const parts = ymd.split('-').map(Number);
      const d = new Date(parts[0], parts[1] - 1, parts[2]);
      // getDay(): 0=周日 … 6=周六。要回到本周一：周日要退 6 天，其余退 (getDay()-1) 天。
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      return ymdLocal(d);
    }
    function daysInMonth(year, month) {
      return new Date(year, month, 0).getDate();
    }

    /** 与 Host 通信：本插件注册的 /weread/api/<method>。 */
    function call(method, args) {
      return fetch(`/weread/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(args ?? {}),
      }).then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok || !data) throw new Error((data && data.error) || `HTTP ${res.status}`);
        return data;
      });
    }

    /** 从粘贴文本解析 cookie / 模板：支持整段 cURL 或单独 Cookie。 */
    function parseInput(text) {
      const raw = (text ?? '').trim();
      if (!raw) return null;
      const out = {};
      const cookieMatch = /-H\s+['"]?[Cc]ookie:\s*([^'"]+)['"]?/.exec(raw)
        ?? /-b\s+['"]([^'"]+)['"]/.exec(raw);
      if (cookieMatch) out.cookie = cookieMatch[1].trim();
      const dataMatch = /--data-raw\s+['"]([\s\S]+?)['"]/.exec(raw)
        ?? /\s-d\s+['"]([\s\S]+?)['"]/.exec(raw)
        ?? /--data\s+['"]([\s\S]+?)['"]/.exec(raw);
      const jsonText = dataMatch ? dataMatch[1].trim() : (raw.startsWith('{') ? raw : null);
      if (jsonText) {
        try {
          const parsed = JSON.parse(jsonText);
          if (parsed && typeof parsed === 'object') {
            if (typeof parsed.cookie === 'string') out.cookie = parsed.cookie;
            if (parsed.base && typeof parsed.base === 'object') out.base = parsed.base;
            if (parsed.appId && !out.base) out.base = parsed;
            if (parsed.data && typeof parsed.data === 'object' && parsed.data.appId && !out.base) {
              out.base = parsed.data;
            }
          }
        } catch { /* 交给服务端判定 */ }
      }
      if (!out.cookie && !out.base && /wr_skey\s*=/.test(raw)) out.cookie = raw;
      return (out.cookie || out.base) ? out : null;
    }

    /** 书页图标。 */
    function BookGlyph({ size }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size || 16, height: size || 16, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': true,
      },
        h('path', { d: 'M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H5.5A1.5 1.5 0 0 1 4 16.5z' }),
        h('path', { d: 'M20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h4.5a1.5 1.5 0 0 0 1.5-1.5z' }));
    }

    /**
     * 左侧栏图标 + 三色状态点。
     *
     * 徽标语义：
     *   绿 = 今日阅读已达用户设定的每日目标
     *   黄 = 今天还没达标
     *   红 = 凭据失效 / 未配置 / 最近一次运行报错
     * 首次拿到数据前不画点，避免闪一下又变色。
     */
    function SidebarIcon({ size }) {
      const [level, setLevel] = React.useState('idle');
      const [goal, setGoal] = React.useState(10);
      React.useEffect(() => {
        let alive = true;
        const tick = () => {
          call('badge')
            .then((res) => {
              if (!alive) return;
              setLevel(res?.level || 'yellow');
              if (Number.isFinite(res?.goalMinutes)) setGoal(res.goalMinutes);
            })
            .catch(() => { if (alive) setLevel('red'); });
        };
        tick();
        const timer = setInterval(tick, BADGE_POLL_MS);
        return () => { alive = false; clearInterval(timer); };
      }, []);
      const title = level === 'green' ? `今日已达成目标 ${goal} 分钟`
        : level === 'yellow' ? `今日尚未达成目标 ${goal} 分钟`
          : level === 'red' ? '连接异常或凭据失效' : '正在读取状态';
      return h('span', { className: 'wr-nav', title },
        h(BookGlyph, { size }),
        h('span', { className: `wr-nav-dot wr-nav-dot-${level}` }));
    }

    /** 细进度条：进度 = 今日已读 / 每日目标，达成后变绿。 */
    function Track({ sec, goalSec, done }) {
      const pct = Math.max(0, Math.min(1, goalSec > 0 ? (sec || 0) / goalSec : 0)) * 100;
      return h('div', null,
        h('div', { className: 'wr-track' },
          h('div', {
            className: 'wr-track-fill' + (done ? ' wr-track-fill-on' : ''),
            style: { width: `${pct}%` },
          })),
        h('div', { className: 'wr-track-legend' },
          h('span', null, `已完成 ${Math.round(pct)}%`),
          h('span', null, `目标 ${Math.round(goalSec / 60)} 分钟`)));
    }

    /** 分段控件。 */
    function Seg({ value, options, disabled, onPick, small, format }) {
      const list = options.includes(value) ? options : [...options, value].sort((a, b) => a - b);
      return h('div', { className: 'wr-seg' + (small ? ' wr-seg-sm' : '') },
        list.map((m) => h('button', {
          key: String(m),
          type: 'button',
          className: 'wr-seg-item' + (m === value ? ' wr-seg-on' : ''),
          disabled: Boolean(disabled),
          onClick: () => onPick(m),
        }, format ? format(m) : `${m}`)));
    }

    /** 今日打卡卡片：进度按「每日目标」算，打卡中按钮变灰不可点。 */
    function TodayCard({ data, busy, onRun, onContinue, onStop }) {
      const t = data.today ?? {};
      const sec = t.sec ?? 0;
      const goalMinutes = data.goalMinutes ?? 10;
      const goalSec = Math.round(goalMinutes * 60);
      const reached = sec >= goalSec;
      const configured = data.configured !== false;
      const progress = data.progress ?? {};
      const reporting = busy && progress.phase === 'reporting';
      const verifying = busy && progress.phase === 'verifying';
      // 继续打卡模式：分母未知，进度条退回「按今日目标」展示，但按钮要变成「停止」
      const unlimited = Boolean(progress.unlimited) && reporting;
      const total = Number(progress.total) || 0;
      const done = Number(progress.done) || 0;
      const liveSec = reporting && Number.isFinite(progress.todaySec)
        ? progress.todaySec + done * 30
        : sec;
      const shownSec = Math.max(sec, liveSec);
      const remainMin = Math.max(0, Math.ceil((goalSec - shownSec) / 60));

      // 「继续打卡」的时长输入面板
      const [askOpen, setAskOpen] = React.useState(false);
      const [askText, setAskText] = React.useState('');
      const askRef = React.useRef(null);
      React.useEffect(() => {
        if (askOpen && askRef.current) {
          try { askRef.current.focus(); } catch { /* 忽略聚焦失败 */ }
        }
      }, [askOpen]);
      // 打卡从「进行中」回到「结束」时收起面板，避免它一直挂着。
      // 注意不能写成 `if (!busy && askOpen) setAskOpen(false)`：那样只要面板一打开、
      // 而此刻并没在打卡（达标后正是这种状态），effect 立刻把它关掉，按钮点了没反应。
      const wasBusyRef = React.useRef(false);
      React.useEffect(() => {
        if (wasBusyRef.current && !busy) setAskOpen(false);
        wasBusyRef.current = busy;
      }, [busy]);

      let stateText;
      if (verifying) stateText = '正在用官方接口核对时长…';
      else if (unlimited) stateText = `持续打卡中 · 已 ${done} 次（约 ${Math.round((done * 30) / 60)} 分钟）`;
      else if (reporting) stateText = `${done}${total ? `/${total}` : ''} 次上报中`;
      else if (busy) stateText = '正在上报…';
      else if (reached) stateText = '✓ 已达成今日目标';
      else stateText = `还差 ${remainMin} 分钟达成目标`;
      const stateCls = (reached || verifying) ? 'wr-ok' : ((reporting || busy) ? 'wr-muted' : 'wr-warn');

      // 打卡中按钮必须是「灰色的打卡中」，不能还显示可点的文案
      let btnLabel;
      if (verifying) btnLabel = '核对中…';
      else if (unlimited) btnLabel = `停止打卡 · 已 ${done} 次`;
      else if (busy) btnLabel = (reporting && total) ? `打卡中 ${done}/${total}` : '打卡中…';
      else if (reached) btnLabel = `今日已达标 · ${Math.round(goalMinutes)} 分钟`;
      else btnLabel = `立即打卡 · 补 ${Math.max(0.5, Math.min(data.minutes ?? 10, remainMin || 0.5))} 分钟`;

      // 继续打卡：解析用户输入的时长。空 = 不设上限（一直打到手动停止）
      const submitContinue = () => {
        const raw = askText.trim();
        if (raw === '') {
          setAskOpen(false);
          onContinue(null);
          return;
        }
        const n = Number.parseFloat(raw);
        if (!Number.isFinite(n) || n <= 0) {
          // 非法输入按「不设上限」处理会让用户意外长跑，所以直接忽略并保持面板
          return;
        }
        setAskOpen(false);
        onContinue(Math.min(600, Math.max(0.5, n)));
      };

      return h('div', { className: 'wr-section' },
        h('div', { className: 'wr-section-title' }, h('span', null, '今日')),
        h('div', { className: 'wr-group wr-group-pad' },
          h('div', { className: 'wr-hero-top' },
            h('div', { style: { minWidth: 0, flex: 1 } },
              h('div', { className: 'wr-hero-label' }, '阅读时长'),
              h('div', { className: 'wr-hero-value' },
                h('span', null, fmtMin(shownSec)),
                h('span', { className: 'wr-hero-goal' }, `/ ${Math.round(goalMinutes)}`),
                h('span', { className: 'wr-hero-unit' }, '分钟')),
              h('div', { className: `wr-hero-state ${stateCls}` }, stateText)),
            data.lastDayDone
              ? h('div', { style: { textAlign: 'right', flex: 'none' } },
                h('div', { className: 'wr-hero-meta' }, '上次运行'),
                h('div', {
                  style: { fontSize: '13px', fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
                }, fmtClock(data.lastRunAt)))
              : null),

          h(Track, { sec: shownSec, goalSec, done: reached }),

          h('div', { style: { marginTop: '18px' } },
            h('button', {
              type: 'button',
              // 无限模式：按钮变成「停止」，可点（不是灰色禁用态）
              className: 'wr-btn'
                + (busy && !unlimited ? ' wr-btn-loading' : '')
                + (unlimited ? ' wr-btn-stop' : '')
                + (!busy && reached ? ' wr-btn-done' : ''),
              disabled: unlimited ? false : (busy || !configured || reached),
              onClick: unlimited ? onStop : onRun,
            },
            busy && !unlimited ? h('span', { className: 'wr-spin' }) : null,
            unlimited ? h('span', { className: 'wr-stop-icon' }) : null,
            btnLabel)),

          // 达标后：补一个「继续打卡」，可以指定时长，也可以一直打
          reached && !busy
            ? h('div', { style: { marginTop: '10px' } },
              h('button', {
                type: 'button',
                className: 'wr-btn wr-btn-ghost',
                disabled: !configured,
                onClick: () => { setAskText(''); setAskOpen(true); },
              }, '继续打卡'),
              h('div', { className: 'wr-hint' }, '今天的目标已完成，还可以继续累积时长。'))
            : null,

          askOpen
            ? h('div', { className: 'wr-ask' },
              h('div', { className: 'wr-ask-title' }, '继续打卡多久？'),
              h('div', { className: 'wr-ask-row' },
                h('input', {
                  ref: askRef,
                  type: 'number',
                  min: '0.5',
                  max: '600',
                  step: '0.5',
                  className: 'wr-input',
                  placeholder: '留空 = 一直打卡',
                  value: askText,
                  onChange: (e) => setAskText(e.target.value),
                  onKeyDown: (e) => {
                    if (e.key === 'Enter') submitContinue();
                    else if (e.key === 'Escape') setAskOpen(false);
                  },
                }),
                h('span', { className: 'wr-ask-unit' }, '分钟')),
              h('div', { className: 'wr-hint' },
                askText.trim() === ''
                  ? '不填就一直打卡，随时可以停。'
                  : `将再上报约 ${Math.max(1, Math.round((Number(askText) * 60) / 30))} 次。`),
              h('div', { className: 'wr-ask-actions' },
                h('button', { type: 'button', className: 'wr-btn wr-btn-sm', onClick: submitContinue },
                  askText.trim() === '' ? '一直打卡' : '开始'),
                h('button', {
                  type: 'button',
                  className: 'wr-btn wr-btn-ghost wr-btn-sm',
                  onClick: () => setAskOpen(false),
                }, '取消')))
            : null,

          !configured
            ? h('div', { className: 'wr-hint wr-err' }, '未配置 Cookie，请到插件设置页粘贴')
            : null,
          data.lastFail
            ? h('div', { className: 'wr-hint wr-err' }, `上次失败：${data.lastFail}`)
            : null),
      );
    }

    /** 设置卡：每日目标 + 打卡时长 + 自动打卡时间。 */
    function GoalCard({ data, busy, onGoal, onMinutes, onAuto }) {
      const goalMinutes = data.goalMinutes ?? 10;
      const minutes = data.minutes ?? 10;
      const configured = data.configured !== false;
      const [draft, setDraft] = React.useState(data.autoTime ?? '');
      const [editing, setEditing] = React.useState(false);
      React.useEffect(() => { setDraft(data.autoTime ?? ''); }, [data.autoTime]);

      return h('div', { className: 'wr-section' },
        h('div', { className: 'wr-section-title' }, h('span', null, '打卡设置')),
        h('div', { className: 'wr-group' },
          h('div', { className: 'wr-field' },
            h('label', { className: 'wr-label' },
              '每日目标 ',
              h('span', { className: 'wr-label-tip' }, '— 进度条与日历达标都按它判定')),
            h(Seg, {
              value: goalMinutes,
              options: GOAL_OPTIONS,
              disabled: busy || !configured,
              onPick: onGoal,
            })),
          h('div', { className: 'wr-field' },
            h('label', { className: 'wr-label' },
              '打卡时长 ',
              h('span', { className: 'wr-label-tip' }, '— 一次点击最多补这么多，自动打卡也用它')),
            h(Seg, {
              value: minutes,
              options: MINUTE_OPTIONS,
              disabled: busy || !configured,
              onPick: onMinutes,
            }),
            h('div', { className: 'wr-hint' },
              `每次上报约 30 秒，${minutes} 分钟即 ${Math.max(1, Math.round((minutes * 60) / 30))} 次请求，间隔 30 秒。`
              + '目标没达成时只补差额，凑满就停。')),
          h('div', { className: 'wr-field' },
            h('div', {
              style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' },
            },
            h('label', { className: 'wr-label', style: { marginBottom: 0 } },
              '自动打卡 ',
              h('span', { className: 'wr-label-tip' }, '— 每天定时')),
            editing
              ? h('div', { style: { display: 'flex', alignItems: 'center', gap: '7px' } },
                h('input', {
                  type: 'time', className: 'wr-input', style: { width: '112px', padding: '5px 8px' },
                  value: draft,
                  onChange: (e) => setDraft(e.target.value),
                }),
                h('button', {
                  type: 'button', className: 'wr-btn-ghost wr-btn-sm',
                  onClick: () => { onAuto(draft); setEditing(false); },
                }, '保存'),
                h('button', {
                  type: 'button', className: 'wr-btn-ghost wr-btn-sm',
                  onClick: () => { onAuto(''); setEditing(false); },
                }, '关闭'),
                h('button', {
                  type: 'button', className: 'wr-btn-ghost wr-btn-sm',
                  onClick: () => setEditing(false),
                }, '取消'))
              : h('button', {
                type: 'button', className: 'wr-btn-ghost wr-btn-sm',
                onClick: () => setEditing(true),
              }, data.autoTime ? `每天 ${data.autoTime}` : '未开启')),
            h('div', { className: 'wr-hint' },
              '靠 DSH 后台常驻运行，不会出现在「自动化任务」界面，也不消耗对话 token。'))),
      );
    }

    /** 日历格子：按「是否达成每日目标」上绿/红。 */
    function calCell(date, sec, goalSec, todayStr) {
      const future = date > todayStr;
      const reached = sec >= goalSec;
      let lvl = '';
      if (future) lvl = 'wr-cal-future';
      else if (reached) {
        const ratio = goalSec > 0 ? sec / goalSec : 1;
        lvl = ratio >= 2 ? 'wr-cal-ok-4' : (ratio >= 1.5 ? 'wr-cal-ok-3' : (ratio >= 1.15 ? 'wr-cal-ok-2' : 'wr-cal-ok-1'));
      } else {
        lvl = sec <= 0 ? 'wr-cal-red-0' : (sec >= goalSec * 0.5 ? 'wr-cal-red-2' : 'wr-cal-red-1');
      }
      const day = Number(date.slice(8, 10));
      const tip = `${date}（周${dowLabel(dowOfYmd(date))}）：${sec > 0 ? fmtDuration(sec) : '未阅读'}`
        + `${future ? ' · 未到' : (reached ? ' · 已达标' : ' · 未达标')}`;
      return h('div', {
        className: `wr-cal-cell ${lvl}` + (date === todayStr ? ' wr-cal-today' : ''),
        key: date,
        title: tip,
      },
      h('span', { className: 'wr-cal-day' }, day),
      sec >= 60 && !future
        ? h('span', { className: 'wr-cal-min' }, `${Math.round(sec / 60)}`)
        : null);
    }

    /**
     * 打卡日历：周 / 月 两种视图可切换，月视图可翻看历史月份。
     * 历史数据（2026-01-01 起）在第一次切到「月」时才请求，之后本地缓存。
     */
    function CalendarCard({ data }) {
      const goalMinutes = data.goalMinutes ?? 10;
      const goalSec = Math.round(goalMinutes * 60);
      const todayStr = ymdLocal(new Date());
      const [mode, setMode] = React.useState('week');
      const [history, setHistory] = React.useState(null);
      const [loading, setLoading] = React.useState(false);
      const [error, setError] = React.useState('');
      const [cursor, setCursor] = React.useState(() => {
        const d = new Date();
        return { year: d.getFullYear(), month: d.getMonth() + 1 };
      });
      const [weekAnchor, setWeekAnchor] = React.useState(() => weekStartYmd(todayStr));

      // 切到「月」时才拉历史：不同模块按点击取数
      React.useEffect(() => {
        if (mode !== 'month' || history !== null || loading) return;
        setLoading(true);
        setError('');
        call('history')
          .then((res) => {
            if (res?.ok) setHistory(res);
            else setError(res?.reason || '读取历史失败');
          })
          .catch((e) => setError(String(e?.message ?? e)))
          .finally(() => setLoading(false));
      }, [mode, history, loading]);

      const byDate = React.useMemo(() => {
        const map = new Map();
        if (history?.series) for (const d of history.series) map.set(d.date, d.sec);
        else if (data.month?.series) for (const d of data.month.series) map.set(d.date, d.sec);
        if (data.week?.series) for (const d of data.week.series) if (!map.has(d.date)) map.set(d.date, d.sec);
        return map;
      }, [history, data.month, data.week]);

      const head = h('div', { className: 'wr-section-title' },
        h('span', null, '打卡日历'),
        h('div', { className: 'wr-cal-nav' },
          h(Seg, {
            value: mode,
            options: ['week', 'month'],
            small: true,
            onPick: setMode,
            format: (m) => (m === 'week' ? '周' : '月'),
          })));

      if (mode === 'week') {
        const days = [];
        for (let i = 0; i < 7; i++) days.push(addDaysYmd(weekAnchor, i));
        const weekSec = days.reduce((a, d) => a + (byDate.get(d) ?? 0), 0);
        const weekOk = days.filter((d) => d <= todayStr && (byDate.get(d) ?? 0) >= goalSec).length;
        const isThisWeek = weekAnchor === weekStartYmd(todayStr);
        return h('div', { className: 'wr-section' },
          head,
          h('div', { className: 'wr-group wr-group-pad' },
            h('div', {
              style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' },
            },
            h('div', null,
              h('span', { style: { fontSize: '20px', fontWeight: 700, letterSpacing: '-.5px' } }, `${weekOk}`),
              h('span', { className: 'wr-muted' }, ' 天达标'),
              h('span', { className: 'wr-muted' }, ` · 合计 ${fmtDuration(weekSec)}`)),
            h('div', { className: 'wr-cal-nav' },
              h('button', {
                type: 'button', className: 'wr-cal-nav-btn',
                onClick: () => setWeekAnchor(addDaysYmd(weekAnchor, -7)),
              }, '‹'),
              h('span', { className: 'wr-cal-nav-label' },
                isThisWeek ? '本周' : `${weekAnchor.slice(5)} 起`),
              h('button', {
                type: 'button', className: 'wr-cal-nav-btn',
                disabled: isThisWeek,
                onClick: () => setWeekAnchor(addDaysYmd(weekAnchor, 7)),
              }, '›'))),
            h('div', { className: 'wr-cal-inner' },
              h('div', { className: 'wr-cal-grid' },
                days.map((d) => h('div', { key: `dow-${d}`, className: 'wr-cal-dow' }, dowLabel(dowOfYmd(d)))),
                days.map((d) => calCell(d, byDate.get(d) ?? 0, goalSec, todayStr)))),
            h('div', { className: 'wr-legend' },
              h('span', { className: 'wr-legend-sq wr-cal-ok-2' }), h('span', null, '达标'),
              h('span', { className: 'wr-legend-sq wr-cal-red-1' }), h('span', null, '未达标'),
              h('span', { className: 'wr-legend-sq wr-cal-red-0' }), h('span', null, '未读')),
            data.week?.topBooks?.length
              ? h('div', { style: { marginTop: '16px' } },
                h('div', { className: 'wr-muted', style: { marginBottom: '2px' } }, '读得最多'),
                data.week.topBooks.map((b) => h('div', { className: 'wr-book', key: b.title },
                  b.cover ? h('img', { className: 'wr-book-cover', src: b.cover, alt: '' })
                    : h('div', { className: 'wr-book-cover' }),
                  h('div', { className: 'wr-book-main' },
                    h('div', { className: 'wr-book-title' }, b.title),
                    h('div', { className: 'wr-book-sub' }, b.author || '—')),
                  h('span', { className: 'wr-book-time' }, fmtDuration(b.sec)))))
              : null),
        );
      }

      // ===== 月视图 =====
      const { year, month } = cursor;
      const dim = daysInMonth(year, month);
      // 周一开头：getDay() 的 0=周日 要映射成最后一格（偏移 6），其余减 1。
      const firstWeekday = (new Date(year, month - 1, 1).getDay() + 6) % 7;
      const cells = [];
      for (let i = 0; i < firstWeekday; i++) {
        cells.push(h('div', { className: 'wr-cal-cell wr-cal-empty', key: `pad${i}` }));
      }
      let monthSec = 0;
      let monthOk = 0;
      for (let day = 1; day <= dim; day++) {
        const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const sec = byDate.get(date) ?? 0;
        monthSec += sec;
        if (date <= todayStr && sec >= goalSec) monthOk += 1;
        cells.push(calCell(date, sec, goalSec, todayStr));
      }
      const atFloor = `${year}-${String(month).padStart(2, '0')}` <= HISTORY_FLOOR_YMD.slice(0, 7);
      const atNow = `${year}-${String(month).padStart(2, '0')}` >= todayStr.slice(0, 7);
      const shift = (delta) => {
        const d = new Date(year, month - 1 + delta, 1);
        setCursor({ year: d.getFullYear(), month: d.getMonth() + 1 });
      };
      return h('div', { className: 'wr-section' },
        head,
        h('div', { className: 'wr-group wr-group-pad' },
          h('div', {
            style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' },
          },
          h('div', null,
            h('span', { style: { fontSize: '20px', fontWeight: 700, letterSpacing: '-.5px' } }, `${monthOk}`),
            h('span', { className: 'wr-muted' }, ' 天达标'),
            h('span', { className: 'wr-muted' }, ` · ${fmtDuration(monthSec)}`)),
          h('div', { className: 'wr-cal-nav' },
            h('button', {
              type: 'button', className: 'wr-cal-nav-btn', disabled: atFloor,
              onClick: () => shift(-1),
            }, '‹'),
            h('span', { className: 'wr-cal-nav-label' }, `${year} 年 ${month} 月`),
            h('button', {
              type: 'button', className: 'wr-cal-nav-btn', disabled: atNow,
              onClick: () => shift(1),
            }, '›'))),
          loading ? h('div', { className: 'wr-empty' }, '正在读取历史…')
            : error ? h('div', { className: 'wr-empty wr-err' }, error)
              : h('div', null,
                h('div', { className: 'wr-cal-inner' },
                  h('div', { className: 'wr-cal-grid' },
                    ['一', '二', '三', '四', '五', '六', '日'].map((d) =>
                      h('div', { className: 'wr-cal-dow', key: d }, d)),
                    cells)),
                h('div', { className: 'wr-legend' },
                  h('span', { className: 'wr-legend-sq wr-cal-ok-2' }), h('span', null, '达标'),
                  h('span', { className: 'wr-legend-sq wr-cal-red-1' }), h('span', null, '未达标'),
                  h('span', { className: 'wr-legend-sq wr-cal-red-0' }), h('span', null, '未读'),
                  history ? h('span', { style: { marginLeft: '8px' } }, `共 ${history.checkedDays} 天达标`) : null))),
      );
    }

    /** 书架：默认展开并展示封面网格，其余明细点开时再请求。 */
    function ShelfCard({ configured }) {
      const [open, setOpen] = React.useState(true);
      const [data, setData] = React.useState(null);
      const [loading, setLoading] = React.useState(false);
      const [error, setError] = React.useState('');
      const [showAll, setShowAll] = React.useState(false);

      const load = React.useCallback(() => {
        setLoading(true);
        setError('');
        call('shelf')
          .then((res) => {
            if (res?.ok) setData(res);
            else setError(res?.reason || '读取书架失败');
          })
          .catch((e) => setError(String(e?.message ?? e)))
          .finally(() => setLoading(false));
      }, []);

      const toggle = () => setOpen(!open);

      // 展开时才拉一次，之后用本地缓存
      React.useEffect(() => {
        if (open && data === null && !loading && !error) load();
      }, [open, data, loading, error, load]);

      const books = data?.books ?? [];
      const sorted = [...books].sort((a, b) => (b.yearSec ?? -1) - (a.yearSec ?? -1));
      /*
       * 默认显示两排封面：封面固定高度（object-fit 裁切）让行高恒定，
       * 于是「两排」可以用 max-height 精确裁切，不依赖当前列数。
       * 展开全部时才解除裁切。
       */
      const COVER_H = 92;
      const gridCls = 'wr-cover-grid' + (showAll ? '' : ' wr-cover-grid-clip');

      return h('div', { className: 'wr-section' },
        h('div', { className: 'wr-section-title' },
          h('span', null, '我的书架'),
          h('div', { className: 'wr-cal-nav' },
            sorted.length > 8
              ? h('button', {
                type: 'button', className: 'wr-btn-ghost wr-btn-sm',
                onClick: () => setShowAll(!showAll),
              }, showAll ? '收起' : `全部 ${sorted.length} 本`)
              : null,
            h('button', {
              type: 'button', className: 'wr-btn-ghost wr-btn-sm',
              disabled: !configured,
              onClick: toggle,
            }, open ? '收起' : '展开'))),
        open
          ? h('div', { className: 'wr-group wr-group-pad' },
            loading ? h('div', { className: 'wr-empty' }, '正在读取书架…')
              : error ? h('div', { className: 'wr-empty wr-err' }, error)
                : !data ? h('div', { className: 'wr-empty' }, '暂无数据')
                  : h('div', null,
                    h('div', {
                      style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '10px' },
                    },
                    h('div', null,
                      h('span', { style: { fontSize: '20px', fontWeight: 700, letterSpacing: '-.5px' } },
                        `${data.total ?? 0}`),
                      h('span', { className: 'wr-muted' }, ' 本')),
                    h('div', { className: 'wr-muted', style: { textAlign: 'right' } },
                      `今年 ${fmtDuration(data.yearTotalSec ?? 0)}`,
                      h('div', { className: 'wr-muted', style: { fontSize: '10.5px' } },
                        `时长覆盖 ${data.coveredCount ?? 0}/${data.bookCount ?? 0} 本`))),
                    h('div', {
                      className: gridCls,
                      style: { maxHeight: showAll ? 'none' : `${COVER_H * 2 + 10}px` },
                    },
                    sorted.map((b) => h('div', {
                      className: 'wr-cover-tile', key: b.bookId, title: b.title,
                    },
                    b.cover
                      ? h('img', {
                        className: 'wr-cover', src: b.cover, alt: b.title,
                        style: { height: `${COVER_H}px` },
                      })
                      : h('div', {
                        className: 'wr-cover wr-cover-none',
                        style: { height: `${COVER_H}px` },
                      }, BookGlyph(18)),
                    h('div', { className: 'wr-cover-time' },
                      b.yearSec === null
                        ? h('span', { className: 'wr-muted' }, '—')
                        : fmtDuration(b.yearSec))))),
                    h('div', { className: 'wr-hint', style: { marginTop: '10px', marginBottom: 0 } },
                      '每本书的时长来自官方统计的「读得最多」榜，只有进榜的书才有数字。')))
          : null,
      );
    }

    /** 累计统计。 */
    function OverallCard({ overall }) {
      if (!overall) return null;
      const stats = overall.stat ?? [];
      return h('div', { className: 'wr-section' },
        h('div', { className: 'wr-section-title' }, h('span', null, '累计')),
        h('div', { className: 'wr-group' },
          h('div', { className: 'wr-stat-grid' },
            h('div', { className: 'wr-stat-cell' },
              h('div', { className: 'wr-stat-label' }, '总阅读时长'),
              h('div', { className: 'wr-stat-value' },
                fmtHour(overall.totalSec),
                h('span', { className: 'wr-stat-unit' }, '小时'))),
            h('div', { className: 'wr-stat-cell' },
              h('div', { className: 'wr-stat-label' }, '有效阅读天数'),
              h('div', { className: 'wr-stat-value' },
                overall.readDays ?? '—',
                h('span', { className: 'wr-stat-unit' }, '天')))),
          stats.length
            ? h('div', { style: { padding: '14px 16px' } },
              h('div', { className: 'wr-chips' },
                stats.map((s) => h('span', { className: 'wr-chip', key: s.label },
                  h('span', { className: 'wr-chip-k' }, s.label),
                  h('span', { className: 'wr-chip-v' }, s.value)))))
            : null),
      );
    }

    /** 提示条。 */
    function Notice({ notice }) {
      if (!notice) return null;
      const cls = notice.kind === 'ok' ? 'wr-notice-ok'
        : (notice.kind === 'err' ? 'wr-notice-err' : 'wr-notice-warn');
      return h('div', {
        className: `wr-notice ${cls}`,
        style: { marginBottom: '22px' },
      }, h('span', null, notice.text));
    }

    /** 主面板。 */
    function Panel() {
      const [data, setData] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState(null);

      const refresh = React.useCallback(() => call('dashboard')
        .then(setData)
        .catch((e) => setData({ ok: false, reason: String(e?.message ?? e) })), []);

      // 空闲时：进入界面拉一次，不轮询
      React.useEffect(() => { refresh(); }, [refresh]);

      // 打卡进行中：每 30 秒拉一次进度
      React.useEffect(() => {
        if (!busy) return undefined;
        const t = setInterval(refresh, RUN_POLL_MS);
        return () => clearInterval(t);
      }, [busy, refresh]);

      /** 统一的打卡结果提示。continue 与 run 共用。 */
      const showResult = React.useCallback((res) => {
        if (res?.stopped) {
          setNotice({ kind: 'ok', text: res.reason || `已停止，本次上报 ${res.done} 次` });
        } else if (res?.unlimited || res?.reason?.startsWith?.('已停止')) {
          setNotice({ kind: 'ok', text: res.reason || '已停止打卡' });
        } else if (res?.alreadyDone) {
          setNotice({ kind: 'ok', text: res.reason || '今日已达标，无需再补' });
        } else if (res?.verified) {
          setNotice(res.dToday > 0
            ? { kind: 'ok', text: `打卡生效：今日阅读 +${res.dToday} 秒，累计 ${fmtMin(res.todaySec)} 分钟` }
            : { kind: 'err', text: `未见效：${res.done} 次上报被接受，但今日时长没有增加` });
        } else if (res?.ok) {
          setNotice({ kind: 'warn', text: `已上报 ${res.done} 次；${res.reason || '未能验证是否计入'}` });
        } else {
          setNotice({ kind: 'err', text: res?.reason || (res?.errors || []).join('；') || '打卡未完成' });
        }
      }, []);

      /** 把请求挂到 busy 上，结束时统一刷新。 */
      const fire = React.useCallback((method, args) => {
        setBusy(true);
        setNotice(null);
        call(method, args)
          .then(showResult)
          .catch((e) => setNotice({ kind: 'err', text: String(e?.message ?? e) }))
          .finally(() => {
            setBusy(false);
            refresh();
          });
      }, [refresh, showResult]);

      const run = React.useCallback(() => {
        fire('checkin', {});
      }, [fire]);

      /** 继续打卡：minutes 为 null 表示不设上限，一直打到用户点停止。 */
      const continueRun = React.useCallback((minutes) => {
        fire('checkin', minutes && minutes > 0
          ? { unlimited: true, minutes }
          : { unlimited: true });
      }, [fire]);

      /** 停止：只打断上报循环，正常走收尾（会核对时长并刷新界面）。 */
      const stopRun = React.useCallback(() => {
        setNotice({ kind: 'warn', text: '正在停止…' });
        call('stop', {})
          .then((res) => {
            if (!res?.ok) {
              setNotice({ kind: 'warn', text: res?.reason || '当前没有正在进行的打卡' });
              setBusy(false);
              refresh();
            }
          })
          .catch((e) => setNotice({ kind: 'err', text: String(e?.message ?? e) }));
      }, [refresh]);

      /** 设置类接口的通用提交。 */
      const submit = React.useCallback((method, args) => {
        call(method, args)
          .then((res) => {
            setNotice(res?.ok
              ? { kind: 'ok', text: res.message || '已保存' }
              : { kind: 'err', text: res?.error || '保存失败' });
            refresh();
          })
          .catch((e) => setNotice({ kind: 'err', text: String(e?.message ?? e) }));
      }, [refresh]);

      const setGoal = React.useCallback((goalMinutes) => submit('setupGoal', { goalMinutes }), [submit]);
      const setMinutes = React.useCallback((minutes) => submit('setupMinutes', { minutes }), [submit]);
      const setAuto = React.useCallback((autoTime) => submit('setupAuto', { autoTime }), [submit]);

      if (!data) {
        return h('div', { className: 'wr-page' },
          h('div', { className: 'wr-inner' },
            h('div', { className: 'wr-group' }, h('div', { className: 'wr-empty' }, '加载中…'))));
      }
      if (!data.ok) {
        return h('div', { className: 'wr-page' },
          h('div', { className: 'wr-inner' },
            h('div', { className: 'wr-section' },
              h('div', { className: 'wr-section-title' }, h('span', null, '微信读书打卡')),
              h('div', { className: 'wr-group wr-group-pad' },
                h('div', { className: 'wr-empty' },
                  data.needApiKey
                    ? '需要在插件设置页填入官方 API Key（wrk- 开头）才能读取阅读数据'
                    : (data.reason || '读取阅读数据失败')),
                h('button', {
                  type: 'button', className: 'wr-btn-ghost',
                  style: { display: 'block', margin: '0 auto' },
                  onClick: refresh,
                }, '重试')))));
      }

      const configured = data.configured !== false;
      return h('div', { className: 'wr-page' },
        h('div', { className: 'wr-inner' },
          h(Notice, { notice }),
          h('div', { className: 'wr-cards' },
            h('div', { className: 'wr-cell' }, h(TodayCard, {
              data, busy, onRun: run, onContinue: continueRun, onStop: stopRun,
            })),
            h('div', { className: 'wr-cell' }, h(GoalCard, { data, busy, onGoal: setGoal, onMinutes: setMinutes, onAuto: setAuto })),
            h('div', { className: 'wr-cell wr-cell-wide' }, h(CalendarCard, { data })),
            h('div', { className: 'wr-cell' }, h(ShelfCard, { configured })),
            h('div', { className: 'wr-cell' }, h(OverallCard, { overall: data.overall })),
          ),
          h('div', { className: 'wr-version' }, `微信读书打卡 v${data.version || PLUGIN_VERSION}`)));
    }

    /** 设置页。 */
    function Settings() {
      const [cookieText, setCookieText] = React.useState('');
      const [baseText, setBaseText] = React.useState('');
      const [apiKeyText, setApiKeyText] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState(null);
      const [status, setStatus] = React.useState(null);

      const refresh = React.useCallback(() => {
        call('status').then(setStatus).catch(() => setStatus(null));
      }, []);
      React.useEffect(refresh, [refresh]);

      const save = React.useCallback(() => {
        const fromCookie = parseInput(cookieText);
        const fromBase = parseInput(baseText);
        const payload = {
          cookie: (fromCookie && fromCookie.cookie) || (fromBase && fromBase.cookie) || '',
          base: (fromBase && fromBase.base) || (fromCookie && fromCookie.base) || undefined,
        };
        if (apiKeyText.trim()) payload.apiKey = apiKeyText.trim();
        if (!payload.cookie && !payload.base && !payload.apiKey) {
          setNotice({ kind: 'err', text: '没有识别出内容。请粘贴包含 wr_skey 的 Cookie，或 /web/book/read 的完整 cURL。' });
          return;
        }
        setBusy(true);
        setNotice(null);
        call('setup', payload)
          .then((res) => {
            if (res?.ok) {
              setNotice({ kind: 'ok', text: res.message || '已保存' });
              setCookieText('');
              setBaseText('');
              setApiKeyText('');
              refresh();
            } else {
              setNotice({ kind: 'err', text: res?.error || '保存失败' });
            }
          })
          .catch((e) => setNotice({ kind: 'err', text: String(e?.message ?? e) }))
          .finally(() => setBusy(false));
      }, [cookieText, baseText, apiKeyText, refresh]);

      const hasCookie = Boolean(status?.hasCookie);
      const hasBase = Boolean(status?.hasBase);
      const canVerify = Boolean(status?.canVerify);

      return h('div', { className: 'wr-page wr-page-flat' },
        h('div', { className: 'wr-inner wr-inner-sm' },
        // 连接状态
        h('div', { className: 'wr-section' },
          h('div', { className: 'wr-section-title' }, h('span', null,
            status?.configured ? '连接状态 · 可以打卡' : '连接状态 · 尚不可打卡')),
          h('div', { className: 'wr-group' },
            h('div', { className: 'wr-row' },
              h('span', { className: 'wr-row-label' }, 'Cookie'),
              h('span', { className: 'wr-chip-status' },
                h('span', { className: 'wr-dot ' + (hasCookie ? 'wr-dot-on' : 'wr-dot-off') }),
                hasCookie ? '已配置' : '未配置')),
            h('div', { className: 'wr-row' },
              h('span', { className: 'wr-row-label' }, '上报模板'),
              h('span', { className: 'wr-chip-status' },
                h('span', { className: 'wr-dot ' + (hasBase ? 'wr-dot-on' : 'wr-dot-off') }),
                status?.baseFromBuiltin ? '内置模板' : (hasBase ? '自定义' : '缺失'))),
            h('div', { className: 'wr-row' },
              h('span', { className: 'wr-row-label' }, '官方 API Key'),
              h('span', { className: 'wr-chip-status' },
                h('span', { className: 'wr-dot ' + (canVerify ? 'wr-dot-on' : '') }),
                canVerify ? '可核对时长' : '未配置')))),
        h(Notice, { notice }),

        // 凭据
        h('div', { className: 'wr-section' },
          h('div', { className: 'wr-section-title' },
            h('span', null, '凭据'),
            h('button', {
              type: 'button', className: 'wr-btn-ghost wr-btn-sm',
              onClick: () => call('renew', {})
                .then((r) => setNotice(r.ok
                  ? { kind: 'ok', text: '密钥刷新成功' }
                  : { kind: 'err', text: r.reason || '刷新失败' }))
                .catch((e) => setNotice({ kind: 'err', text: String(e?.message ?? e) })),
            }, '刷新密钥')),
          h('div', { className: 'wr-group' },
            h('div', { className: 'wr-field' },
              h('label', { className: 'wr-label', htmlFor: 'wr-cookie' },
                'Cookie ',
                h('span', { className: 'wr-label-tip' }, '— 必需，需含 wr_skey')),
              h('textarea', {
                id: 'wr-cookie', className: 'wr-area', value: cookieText, spellCheck: false,
                placeholder: 'wr_vid=...; wr_skey=...   （也可以直接粘整段 cURL）',
                onChange: (e) => setCookieText(e.target.value),
              })),
            h('div', { className: 'wr-field' },
              h('label', { className: 'wr-label', htmlFor: 'wr-base' },
                '请求体模板 ',
                h('span', { className: 'wr-label-tip' }, '— 可选，留空即用内置模板')),
              h('textarea', {
                id: 'wr-base', className: 'wr-area', value: baseText, spellCheck: false,
                placeholder: '留空即可。如需覆盖，粘 {"appId":"wb...","b":"...","c":"...","ci":27,"co":389,...}',
                onChange: (e) => setBaseText(e.target.value),
              }),
              h('div', { className: 'wr-hint' }, '只填 Cookie 就够，不需要抓包。')),
            h('div', { className: 'wr-field' },
              h('label', { className: 'wr-label', htmlFor: 'wr-apikey' },
                '官方 API Key ',
                h('span', { className: 'wr-label-tip' }, '— 可选，用来核对时长与读取统计')),
              h('input', {
                id: 'wr-apikey', className: 'wr-input', value: apiKeyText, spellCheck: false,
                placeholder: 'wrk-xxxxx（留空则保留已存值）',
                onChange: (e) => setApiKeyText(e.target.value)})),
            h('div', { className: 'wr-field' },
              h('button', {
                type: 'button', className: 'wr-btn',
                disabled: busy || (!cookieText.trim() && !baseText.trim() && !apiKeyText.trim()),
                onClick: save,
              }, busy ? '保存中…' : '保存')))),

        // 说明
        h('div', { className: 'wr-section' },
          h('div', { className: 'wr-section-title' }, h('span', null, '怎么获取 Cookie')),
          h('div', { className: 'wr-group wr-group-pad' },
            h('ol', { className: 'wr-ol' },
              h('li', null, '浏览器打开 weread.qq.com 并确认已登录'),
              h('li', null, 'F12 → Network → 过滤 read → 点 /web/book/read 那条请求（随便翻一页书即可产生）'),
              h('li', null, '右键 → Copy → Copy as cURL (bash)'),
              h('li', null, '整段粘进上面的 Cookie 框 → 保存')),
            h('div', { className: 'wr-hint' },
              '只需要 Cookie。上报用的书籍标识与设备字段由插件内置的实测模板提供，'
              + '服务端不逐字段校验，只要组合曾真实产生过就能通过。凭据保存在本机，不写进插件配置。'),
            h('div', { className: 'wr-hint' },
              'wr_skey 约 90 分钟过期，插件会自动续期；整体登录态约 30 天，届时需重新粘贴一次。'))),

        // 版本
        h('div', { className: 'wr-section' },
          h('div', { className: 'wr-section-title' }, h('span', null, '关于')),
          h('div', { className: 'wr-group' },
            h('div', { className: 'wr-row' },
              h('span', { className: 'wr-row-label' }, '版本'),
              h('span', { className: 'wr-row-value' }, `v${status?.version || PLUGIN_VERSION}`)),
            h('div', { className: 'wr-row' },
              h('span', { className: 'wr-row-label' }, '包名'),
              h('span', { className: 'wr-row-value' }, PANEL_ID)))),
        ));
    }

    // 样式在 factory 内就地注入：模块系统在 materialization 时靠「新增的未打标
    // <style>」认领归属（claimStyles），HMR 重载时才能按 data-plugin 清理干净。
    injectCss(CSS);

    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        // 左侧栏图标 + 主面板：一起注册，图标不可用时整体撤销
        ctx.slots.inject('main', () => ctx.slots.inject('sidebar.panellist', () => {
          const stopMain = ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
          }, Panel);
          let stopIcon;
          try {
            stopIcon = ctx.slots.register({
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 40,
              label: '微信读书打卡',
            }, SidebarIcon);
          } catch (error) {
            stopIcon?.();
            stopMain();
            throw error;
          }
          return () => {
            stopIcon?.();
            stopMain();
          };
        }));

        // 插件设置页
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: 'dsh-weread-checkin',
        }, Settings));
      },
    };
  },
});

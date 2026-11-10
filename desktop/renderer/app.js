/**
 * 客户端外壳：把插件的前端模块装进一个自建的「侧栏 + 主区」布局。
 *
 * 插件原本通过 DSH 的 slot 系统注册三样东西：
 *   main                     → 主面板（打卡状态、日历、书架、画像、笔记…）
 *   sidebar.panellist        → 左侧栏的图标（带一个状态小圆点）
 *   plugins.bundle.config    → 设置页
 * 这里用一套 thirty 行的 slot 垫片把它们收下来，再自己摆位置。
 */

(function main() {
  const React = window.__cjs.require('react');
  const ReactDOM = window.__cjs.require('react-dom-client');
  const h = React.createElement;

  /* ---------------- slot 垫片 ---------------- */

  const registry = { main: {}, 'sidebar.panellist': {}, 'plugins.bundle.config': {} };
  const disposers = [];

  const slots = {
    // 插件调 slots.inject('main', fn)，表示「这个插槽现在有人了，可以注册了」
    inject(name, fn) {
      if (!registry[name]) registry[name] = {};
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
    // 注册组件；同名 key 后注册的覆盖先注册的（与 DSH 行为一致）
    register(options, Component) {
      const name = options?.name;
      if (!registry[name]) registry[name] = {};
      const key = String(options?.key ?? options?.id ?? Math.random());
      registry[name][key] = { Component, options };
      return () => { delete registry[name][key]; };
    },
  };

  function pickSlot(name) {
    const bucket = registry[name] ?? {};
    const keys = Object.keys(bucket);
    if (!keys.length) return null;
    const entry = bucket[keys[keys.length - 1]];
    return entry ? entry.Component : null;
  }

  /* ---------------- 装载插件 ---------------- */

  const factory = window.__ModuleLoader__.take('dsh-weread-checkin');
  if (typeof factory !== 'function') {
    document.getElementById('root').textContent = '插件模块未加载：client.js 没有调用 __ModuleLoader__.load';
    return;
  }

  const plugin = factory((id) => window.__cjs.require(id));
  plugin.apply({ slots });

  const Panel = pickSlot('main');
  const SidebarIcon = pickSlot('sidebar.panellist');
  const Settings = pickSlot('plugins.bundle.config');

  /* ---------------- 主题 ---------------- */

  const THEME_KEY = 'weread-theme'; // 'light' | 'dark' | 'system'

  function prefersDark() {
    return window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false;
  }

  function applyTheme(mode) {
    const dark = mode === 'dark' || (mode === 'system' && prefersDark());
    // DSH 靠这个属性切暗色，三段主题 CSS 里暗色块就是 body[data-ds-dark-theme]
    document.body.toggleAttribute('data-ds-dark-theme', dark);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  }

  /* ---------------- 外壳 ---------------- */

  function App() {
    const [view, setView] = React.useState('panel'); // 'panel' | 'settings'
    const [theme, setTheme] = React.useState(() => localStorage.getItem(THEME_KEY) || 'system');

    React.useEffect(() => {
      applyTheme(theme);
      localStorage.setItem(THEME_KEY, theme);
      if (theme !== 'system') return undefined;
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = () => applyTheme('system');
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }, [theme]);

    const icons = [
      { id: 'panel', label: '打卡', node: SidebarIcon ? h(SidebarIcon, { size: 22 }) : h('span', null, '读') },
      { id: 'settings', label: '设置', node: h(GearGlyph, { size: 20 }) },
    ];

    return h(
      'div',
      { className: 'app' },
      h(
        'aside',
        { className: 'app-rail' },
        h('div', { className: 'app-rail-brand' }, h('span', { className: 'app-rail-brand-text' }, '微')),
        icons.map((item) =>
          h(
            'button',
            {
              key: item.id,
              type: 'button',
              className: `app-rail-btn${view === item.id ? ' is-active' : ''}`,
              title: item.label,
              'aria-label': item.label,
              onClick: () => setView(item.id),
            },
            item.node,
          ),
        ),
        h('div', { className: 'app-rail-spacer' }),
        h(
          'button',
          {
            type: 'button',
            className: 'app-rail-btn app-rail-btn-sub',
            title: theme === 'dark' ? '切到浅色' : '切到深色',
            'aria-label': '切换主题',
            onClick: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
          },
          theme === 'dark' ? h(SunGlyph, { size: 18 }) : h(MoonGlyph, { size: 18 }),
        ),
      ),
      h(
        'main',
        { className: 'app-main' },
        view === 'settings'
          ? h('div', { className: 'app-scroll' }, Settings ? h(Settings, {}) : h('div', { className: 'app-fallback' }, '设置页未注册'))
          : h('div', { className: 'app-scroll' }, Panel ? h(Panel, {}) : h('div', { className: 'app-fallback' }, '主面板未注册')),
      ),
    );
  }

  /* ---------------- 图标 ---------------- */

  function GearGlyph({ size }) {
    return h(
      'svg',
      {
        viewBox: '0 0 24 24', width: size || 18, height: size || 18, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      h('circle', { cx: 12, cy: 12, r: 3.2 }),
      h('path', {
        d: 'M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.7 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.7a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15.1 4.7a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.3 9a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15z',
      }),
    );
  }

  function MoonGlyph({ size }) {
    return h(
      'svg',
      {
        viewBox: '0 0 24 24', width: size || 18, height: size || 18, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      h('path', { d: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z' }),
    );
  }

  function SunGlyph({ size }) {
    return h(
      'svg',
      {
        viewBox: '0 0 24 24', width: size || 18, height: size || 18, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      h('circle', { cx: 12, cy: 12, r: 4 }),
      h('path', { d: 'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4' }),
    );
  }

  ReactDOM.createRoot(document.getElementById('root')).render(h(App));

  window.addEventListener('beforeunload', () => {
    for (const dispose of disposers) {
      try { dispose(); } catch { /* 卸载失败不影响关闭 */ }
    }
  });
})();

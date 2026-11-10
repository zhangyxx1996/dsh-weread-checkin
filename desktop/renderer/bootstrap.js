/**
 * 极简 CommonJS 垫片 + 插件模块装载器。
 *
 * 为什么需要：插件的前端文件 client.js 是写给 DSH 的模块系统用的，开头就是
 *   window.__ModuleLoader__.load({ id: 'dsh-weread-checkin', factory(require) {...} })
 * 我们原样加载这份文件，就得把这两个全局补上，让它以为自己跑在 DSH 里。
 *
 * React 的四个 production 构建（已被 /vendor/* 包成 define(...)）也走同一套 require。
 */
(function bootstrap() {
  const modules = new Map();

  window.__cjs = {
    define(id, factory) {
      modules.set(String(id), { factory, module: { exports: {} }, loaded: false });
    },
    require(id) {
      const key = String(id);
      const record = modules.get(key);
      if (!record) throw new Error(`模块未注册：${key}`);
      if (!record.loaded) {
        record.loaded = true;
        record.factory(record.module, record.module.exports, (nested) => window.__cjs.require(nested));
      }
      return record.module.exports;
    },
    has(id) {
      return modules.has(String(id));
    },
  };

  // DSH 的加载器是先 load 再在需要时调 factory；这里照办，先把工厂存下来
  const pending = new Map();
  window.__ModuleLoader__ = {
    load({ id, factory }) {
      pending.set(id, factory);
    },
    take(id) {
      const factory = pending.get(id);
      pending.delete(id);
      return factory;
    },
    has(id) {
      return pending.has(id);
    },
  };
})();

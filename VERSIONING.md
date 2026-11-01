# 版本留存约定

这个目录是 git 仓库，**每次迭代都要留痕**。

## 为什么

插件是 `link:` 安装（`profiles/desktop/node_modules/dsh-weread-checkin` 是 Junction，
直指本目录），`remove_bundle` + `install_bundle` 只换软链、不留副本；
`.plugin-manager/logs/` 里只有 pnpm 安装日志，没有代码快照。

所以**没有 git 就没有历史**：0.1.0 → 0.3.2 全部版本的代码已经因为直接覆盖而丢失。
本仓库从 0.3.3 开始，之前的无法找回。

## 每次迭代的流程

```powershell
$git = 'C:\Users\zhang\.workbuddy\vendor\PortableGit\cmd\git.exe'

# 1. 改完代码、跑完回归测试
& $node --check client.js
& $node probe-client-run.mjs      # 离线渲染
& $node probe-host.mjs            # Host 接口
& $node probe-layout-fix.mjs      # 布局约束

# 2. 先提交并打 tag（在装机之前！）
& $git add -A
& $git commit -m "v0.3.4: 说明改了什么"
& $git tag -a v0.3.4 -m "一句话说明"

# 3. 再改 package.json 的 version、装机
#    plugin_manager remove_bundle → install_bundle
```

**顺序很重要**：先 tag 再装机。装机前要是忘了 tag，这一版的源码又只剩工作区里那一份。

## 回滚到某个版本

```powershell
& $git checkout v0.3.3 -- .     # 把该版本的文件覆盖回工作区
# 然后 remove_bundle + install_bundle 让 DSH 重新加载
```

或者先看某个版本长什么样：

```powershell
& $git worktree add $env:TEMP\wr-old v0.3.3   # 检出到临时目录，不影响当前工作区
& $git worktree remove $env:TEMP\wr-old --force
```

## 什么进版本、什么不进

| 进版本 | 不进版本（`.gitignore`） |
|---|---|
| `index.js` / `client.js` / `weread-api.js` / `weread-verify.js` | `probe-*.mjs` 一次性诊断脚本 |
| `package.json` / `cordis.patch.yml` / `locale/` / `icon.svg` | `_diag.mjs` |
| `README.md` | `node_modules/`、`*.log` |
| 三个回归测试：`probe-client-run.mjs`、`probe-host.mjs`、`probe-layout-fix.mjs` | |

诊断脚本用完即弃（`probe-scroll*.mjs`、`probe-slot*.mjs` 之类），
但**那三个回归测试要留**——它们断言 UI 结构与接口契约，是防回归的主要手段。

## 注意

- 仓库身份是仓库内局部配置（`DSH Agent <agent@dsh.local>`），没有改全局 git 配置。
- `core.autocrlf = false`，避免 Windows 换行符污染 diff。
- 没有配置 remote，纯本地留存。

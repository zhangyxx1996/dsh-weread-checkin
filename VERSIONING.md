# 版本留存约定

这个目录是 git 仓库，已发布到 **https://github.com/zhangyxx1996/dsh-weread-checkin**，
**每次迭代都要留痕**。

## 一条命令发版

```powershell
cd D:\DSH工作区\微信读书插件
.\release.ps1 -Version 1.0.2 -Note "修了什么"
```

它会自动完成：语法校验 → 跑回归测试 → 同步改两处版本号 → 提交 → 打 tag → 推送。

推送之后回到 DSH 里说「装一下新版本」，用 `plugin_manager` 重新安装即可。

## 为什么

插件是 `link:` 安装（`profiles/desktop/node_modules/dsh-weread-checkin` 是 Junction，
直指本目录 —— **包名仍是 `dsh-weread-checkin`，只有源码目录改名成了「微信读书插件」**），
`remove_bundle` + `install_bundle` 只换软链、不留副本；
`.plugin-manager/logs/` 里只有 pnpm 安装日志，没有代码快照。

所以**没有 git 就没有历史**：开发期的 0.1.0 → 0.3.2 全部版本的代码已经因为直接覆盖而丢失。

**版本编号从 1.0.0 起算**（`v1.0.0` 是正式的「第一版」，功能完整可用：
手动打卡 / 定时自动打卡 / 每日目标与打卡时长档位 / 周月日历 / 书架 / 三色状态点 / iOS 风格界面）。
开发期那串 0.x 只是内部草稿编号，不进历史，也无法找回。

> 提交历史里可能还会看到早期随手打的 `v0.3.3` 标签（建仓时的第一个 tag）。
> 它和 `v1.0.0` 指向同一份代码，只是编号前的草稿标记，**不要以它作为版本基准**。

## 手动发版（不想用脚本时）

```powershell
$git = 'C:\Users\zhang\.workbuddy\vendor\PortableGit\cmd\git.exe'
$node = 'C:\Users\zhang\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'

# 0. 先进到仓库目录（所有命令都相对于它）
cd D:\DSH工作区\微信读书插件

# 1. 改完代码、跑完回归测试
& $node --check client.js
& $node probe-client-run.mjs      # 离线渲染
& $node probe-host.mjs            # Host 接口
& $node probe-layout-fix.mjs      # 布局约束

# 2. 先提交并打 tag（在装机之前！）
& $git add -A
& $git commit -m "v1.0.2: 说明改了什么"
& $git tag -a v1.0.2 -m "一句话说明"

# 3. 改 package.json 和 client.js 的 PLUGIN_VERSION，再装机
#    plugin_manager remove_bundle → install_bundle
```

**顺序很重要**：先 tag 再装机。装机前要是忘了 tag，这一版的源码又只剩工作区里那一份。

## 回滚到某个版本

```powershell
& $git checkout v1.0.0 -- .     # 把该版本的文件覆盖回工作区
# 然后 remove_bundle + install_bundle 让 DSH 重新加载
```

或者先看某个版本长什么样：

```powershell
& $git worktree add $env:TEMP\wr-old v1.0.0   # 检出到临时目录，不影响当前工作区
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

- **源码目录名 ≠ 包名**：目录是 `D:\DSH工作区\微信读书插件`（2026-11-01 从
  `D:\DSH工作区\dsh-weread-checkin` 迁来），包名仍是 `dsh-weread-checkin`。
  `package.json` / `cordis.patch.yml` / `client.js` / `index.js` / `release.ps1`
  里的 `dsh-weread-checkin` 是**包标识、Junction 名和 GitHub 仓库名**，改目录时不能跟着改。
- 仓库身份是仓库内局部配置（`DSH Agent <agent@dsh.local>`），没有改全局 git 配置。
- `core.autocrlf = false`，避免 Windows 换行符污染 diff。
- 推送凭据用本仓库的 `url.insteadOf`（含 token），**只在本仓库生效**。
  注意它不影响 `git remote -v` 的显示：远端 URL 里本来就带 token，
  用 `git remote -v` 排查时别把 token 贴到公开地方。
- 本机 git 走 schannel 会报 `SEC_E_NO_CREDENTIALS`，所以本仓库固定了
  `http.sslBackend=openssl` + `http.sslVerify=false`（本机证书链不全导致的，不影响安全边界）。
- 回归脚本 `probe-client-run.mjs` 已改为按自身文件位置读 `client.js`，
  **换目录后不用再改路径**；其它 `probe-*.mjs` 若再出现写死的 `D:\DSH工作区\...` 路径，同样改成相对定位。

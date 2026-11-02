# 版本留存约定

这个目录是 git 仓库，已发布到 **https://github.com/zhangyxx1996/dsh-weread-checkin**，
**每次迭代都要留痕**。

## 一条命令发版

```powershell
cd <仓库目录>
.\release.ps1 -Version 1.0.2 -Note "修了什么"
```

它会自动完成：语法校验 → 跑回归测试 → 同步改两处版本号 → 提交 → 打 tag → 推送 → 同步 profile 依赖。

脚本开头会**自动定位 git / node / pnpm**（先 PATH，再翻 `~\.dsh\dsh-runtimes\*\dependencies\`），
profile 目录优先读 `DSH_PROFILE_DIR` / `DSH_PROFILE` 环境变量，
所以**换机器、换目录、换用户名都不用改脚本**。跑之前它会先打印三行实际用到的路径，
不对就直接 `throw` 退出，不会带着错的工具去提交。

> 若本机 PowerShell 执行策略禁止运行脚本，用下面这条绕过（只对本次生效）：
> `powershell -NoProfile -ExecutionPolicy Bypass -File .\release.ps1 -Version 1.0.2 -Note "..."`

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
# 0. 先进到仓库目录（所有命令都相对于它）
cd <仓库目录>

# 1. 定位工具：脚本里会自动找，手动跑就用 PATH 上的，找不到再翻 DSH runtime
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  $node = Get-ChildItem "$env:USERPROFILE\.dsh\dsh-runtimes\*\dependencies\node\bin\node.exe" |
    Select-Object -First 1 -ExpandProperty FullName
}
$git = (Get-Command git -ErrorAction SilentlyContinue).Source

# 2. 改完代码、跑完回归测试
& $node --check client.js
& $node probe-client-run.mjs      # 离线渲染
& $node probe-host.mjs            # Host 接口
& $node probe-layout-fix.mjs      # 布局约束
& $node probe-auth-renewal.mjs    # 续期探测必须带 ql:true（v1.1.7 新增）

# 3. 先提交并打 tag（在装机之前！）
& $git add -A
& $git commit -m "v1.0.2: 说明改了什么"
& $git tag -a v1.0.2 -m "一句话说明"

# 4. 改 package.json 和 client.js 的 PLUGIN_VERSION，再装机
#    plugin_manager remove_bundle → install_bundle
```

**顺序很重要**：先 tag 再装机。装机前要是忘了 tag，这一版的源码又只剩工作区里那一份。

> `probe-host.mjs` 会依次调用 `setupAuto` / `setupMinutes` / `setupGoal` 做参数校验，
> 每次成功都落盘。它**用的是 `%TEMP%` 下的临时状态文件**，跑完即删，
> 不会碰你真实的 `~/.dsh/weread-state.json`——否则跑一次回归就会把自动打卡时间
> 和时长档位全部改成测试值。


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
| 回归测试：`probe-client-run.mjs`、`probe-host.mjs`、`probe-layout-fix.mjs`、`probe-auth-renewal.mjs` | |

诊断脚本用完即弃（`probe-scroll*.mjs`、`probe-slot*.mjs` 之类），
但**上面这四个回归测试要留**——它们断言 UI 结构、接口契约和鉴权请求体，
是防回归的主要手段。

> 为什么会有 `probe-auth-renewal.mjs`：v1.1.6 的侧边栏红点 bug 是「接口回了 200、
> 但请求体缺 `ql:true`」，服务端对**有效** Cookie 也回 `-2013 鉴权失败`。
> 这种错光看代码发现不了，只能靠静态断言钉住。

## 注意

- **源码目录名 ≠ 包名**：目录是任意路径（作者本机是 `D:\DSH工作区\微信读书插件`，2026-11-01
  从 `dsh-weread-checkin` 迁来），包名仍是 `dsh-weread-checkin`。
  `package.json` / `cordis.patch.yml` / `client.js` / `index.js` / `release.ps1`
  里的 `dsh-weread-checkin` 是**包标识、Junction 名和 GitHub 仓库名**，改目录时不能跟着改。
- **所有脚本都按 `$PSScriptRoot` / `import.meta.url` 定位，不写死绝对路径**，
  换机器换目录不用改代码；新增代码请沿用这个约定。
- **`release.ps1` 必须存成 UTF-8 with BOM**。PowerShell 5.1 会用 ANSI 解码无 BOM 的 UTF-8，
  中文字符串（含报错文案）会变成乱码并引发成片 ParserError。用编辑器改完检查一下：
  `[System.IO.File]::ReadAllBytes('release.ps1')[0..2]` 应为 `239,187,191`。
- 仓库身份是仓库内局部配置（`DSH Agent <agent@dsh.local>`），没有改全局 git 配置。
- **换行符**：本机全局 `core.autocrlf = true`（仓库内没有覆盖它），所以索引里存 LF、
  工作区落 CRLF —— `git ls-files --eol` 显示 `i/lf w/crlf`。这是正常状态，
  **不要**为了「消掉 diff 里的换行警告」去改 `core.autocrlf`：改成 `false` 会让
  所有文件都显示为已修改。手工用 PowerShell 改写文件时也要注意别写出裸 LF
  （`[System.IO.File]::WriteAllText` 不会自动转换），否则下次 git 触碰时有告警。
- 推送凭据用本仓库的 `url.insteadOf`（含 token），**只在本仓库生效**。
  注意它不影响 `git remote -v` 的显示：远端 URL 里本来就带 token，
  用 `git remote -v` 排查时别把 token 贴到公开地方。
- 本机 git 走 schannel 会报 `SEC_E_NO_CREDENTIALS`，所以本仓库固定了
  `http.sslBackend=openssl` + `http.sslVerify=false`（本机证书链不全导致的，不影响安全边界）。
- 回归脚本 `probe-client-run.mjs` 已改为按自身文件位置读 `client.js`，
  **换目录后不用再改路径**；其它 `probe-*.mjs` 若再出现写死的 `D:\DSH工作区\...` 路径，同样改成相对定位。

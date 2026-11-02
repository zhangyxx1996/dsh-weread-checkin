# 发版脚本（PowerShell）
#
# 用途：一条命令完成「校验 → 提交 → 打 tag → 推送 → 建 GitHub Release」。
# 用法：
#   .\release.ps1 -Version 1.0.2 -Note "修了什么"
#
# 说明：
#   - 版本号同时写进 package.json 和 client.js 的 PLUGIN_VERSION，避免两处不一致
#   - 推送前会先跑三个回归测试，任何一个失败就中止，不会把坏代码推上去
#   - 推送用的是本仓库 git 配置里的 url.insteadOf（含凭据），所以命令行里不出现 token

param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Note = ''
)

$ErrorActionPreference = 'Stop'

$Repo = Split-Path -Parent $MyInvocation.MyCommand.Path

# ---------------------------------------------------------------------------
# 定位 git / node / pnpm（换机器时这一段不用改）
#
# 顺序：先看 PATH，再翻 DSH 桌面端自带的 runtime
#   <用户>\.dsh\dsh-runtimes\<runtime>\dependencies\{node,pnpm}
# 最后才回落到本机旧路径。本机 git 和 node 都不在 PATH 上，
# 所以 PATH 通常落空，实际靠 runtime 目录兜住。
# ---------------------------------------------------------------------------
function Find-Tool {
  param([string]$Name, [string[]]$Fallbacks = @())
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($f in $Fallbacks) {
    if ($f -and (Test-Path $f)) { return $f }
  }
  return $null
}

# 收集所有 DSH runtime 下的 node.exe / pnpm.mjs 候选
$NodeCandidates = @()
$PnpmCandidates = @()
$RuntimeBases = @()
if ($env:USERPROFILE) { $RuntimeBases += (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes') }
if ($env:DSH_HOME)    { $RuntimeBases += (Join-Path $env:DSH_HOME 'dsh-runtimes') }
foreach ($base in ($RuntimeBases | Select-Object -Unique)) {
  if (-not (Test-Path $base)) { continue }
  foreach ($rt in (Get-ChildItem $base -Directory -ErrorAction SilentlyContinue)) {
    $NodeCandidates += (Join-Path $rt.FullName 'dependencies\node\bin\node.exe')
    $PnpmCandidates += (Join-Path $rt.FullName 'dependencies\pnpm\bin\pnpm.mjs')
  }
}

$Git = Find-Tool 'git' @(
  (Join-Path $env:ProgramFiles 'Git\cmd\git.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Git\cmd\git.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\Git\cmd\git.exe'),
  # WorkBuddy 随附的 PortableGit（本机 git 就靠它，不在 PATH 上）
  (Join-Path $env:USERPROFILE '.workbuddy\vendor\PortableGit\cmd\git.exe')
)
$Node = Find-Tool 'node' $NodeCandidates

if (-not $Git)  { throw '找不到 git：装进 PATH，或改本脚本顶部的 $Git 回落列表' }
if (-not $Node) { throw '找不到 node：装 Node 20+，或在 DSH 桌面端里启动过一次（会下发 runtime）' }

# pnpm：先从 node 的同级目录反推（DSH runtime 是 dependencies\{node,pnpm} 并排）
$PnpmJs = $null
$DepsDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $Node))
$GuessPnpm = Join-Path $DepsDir 'pnpm\bin\pnpm.mjs'
if (Test-Path $GuessPnpm) {
  $PnpmJs = $GuessPnpm
} else {
  foreach ($c in $PnpmCandidates) { if (Test-Path $c) { $PnpmJs = $c; break } }
}

Write-Host "git  = $Git"
Write-Host "node = $Node"
if ($PnpmJs) {
  Write-Host "pnpm = $PnpmJs"
} else {
  Write-Host "pnpm = (未找到，装机步骤会跳过)" -ForegroundColor Yellow
}
Write-Host ""

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
  throw "版本号格式应为 X.Y.Z，收到：$Version"
}

Write-Host "=== 1/6 语法校验 ===" -ForegroundColor Cyan
foreach ($f in @('index.js', 'client.js', 'weread-api.js', 'weread-verify.js')) {
  & $Node --check (Join-Path $Repo $f)
  if ($LASTEXITCODE -ne 0) { throw "$f 语法错误" }
  Write-Host "  ✓ $f"
}

Write-Host "=== 2/6 回归测试 ===" -ForegroundColor Cyan
Push-Location $Repo
try {
  # 离线静态回归：不需要网络、不碰真实凭据，所以放在这里先跑
  foreach ($t in @('probe-client-run.mjs', 'probe-layout-fix.mjs', 'probe-auth-renewal.mjs')) {
    & $Node $t *> $null
    if ($LASTEXITCODE -ne 0) { throw "$t 失败" }
    Write-Host "  ✓ $t"
  }
} finally {
  Pop-Location
}

Write-Host "=== 3/6 写入版本号 $Version ===" -ForegroundColor Cyan
# 用 PowerShell 直接改文件，不走 node -e：
#   PowerShell 5.1 把多行 here-string 当参数传给原生 exe 时，
#   里面的双引号会被吞掉（node 收到 `/, const PLUGIN_VERSION = ...` 而报 SyntaxError）。
# 这里保持各文件原有编码（有无 BOM）不变，避免把 BOM 写进去或写掉。
function Set-VersionInFile {
  param([string]$Path, [string]$Pattern, [string]$Replacement)
  if (-not (Test-Path $Path)) { throw "找不到文件：$Path" }
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  $text = [System.IO.File]::ReadAllText($Path, [System.Text.UTF8Encoding]::new($false))
  $new = [regex]::Replace($text, $Pattern, $Replacement)
  # 脚本可重入：上一次发版在中途失败（比如 git 身份没配），重跑时版本号已经是目标值。
  # 这种情况不算错误，直接跳过写入，否则重跑会在第 3 步就抛「未能替换」。
  if ($new -eq $text) {
    $m = [regex]::Match($text, $Pattern)
    if ($m.Success -and $m.Value.Contains($Version)) {
      Write-Host "  $(Split-Path -Leaf $Path) 已是 $Version，跳过"
      return
    }
    throw "未能替换 $Path 中的版本号（模式：$Pattern）"
  }
  [System.IO.File]::WriteAllText($Path, $new, [System.Text.UTF8Encoding]::new($hasBom))
}

Set-VersionInFile (Join-Path $Repo 'package.json') '"version"\s*:\s*"[^"]*"' "`"version`": `"$Version`""
Set-VersionInFile (Join-Path $Repo 'client.js') "const PLUGIN_VERSION = '[^']*';" "const PLUGIN_VERSION = '$Version';"

$live = (Get-Content (Join-Path $Repo 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($live -ne $Version) { throw "package.json 版本号写入失败（读到 $live）" }
Write-Host "  package.json version = $live"

Write-Host "=== 4/6 提交并打 tag ===" -ForegroundColor Cyan
$msg = if ($Note) { "v${Version}: $Note" } else { "v${Version}" }
# 提交身份：仓库内局部配置优先。历史上这个仓库用的是 DSH Agent <agent@dsh.local>，
# 但 clone 到新机器时不会有它，git commit 会直接报 "Author identity unknown" 中止发版。
# 这里在缺失时补上同一身份（只写本仓库，不动全局配置）。
$identName = (& $Git -C $Repo config --local user.name) 2>$null
$identMail = (& $Git -C $Repo config --local user.email) 2>$null
if (-not $identName) { & $Git -C $Repo config --local user.name 'DSH Agent' | Out-Null }
if (-not $identMail) { & $Git -C $Repo config --local user.email 'agent@dsh.local' | Out-Null }
& $Git -C $Repo add -A
& $Git -C $Repo commit -m $msg
if ($LASTEXITCODE -ne 0) { Write-Host '  没有改动可提交，继续' -ForegroundColor Yellow }
$existingTag = & $Git -C $Repo tag -l "v$Version"
if ($existingTag) {
  Write-Host "  tag v$Version 已存在，跳过（重跑发版时正常）" -ForegroundColor Yellow
} else {
  & $Git -C $Repo tag -a "v$Version" -m $msg
  if ($LASTEXITCODE -ne 0) { throw "打 tag v$Version 失败" }
}

Write-Host "=== 5/6 推送到 GitHub ===" -ForegroundColor Cyan
& $Git -C $Repo push origin main --tags
if ($LASTEXITCODE -ne 0) { throw '推送失败' }

Write-Host "=== 6/6 装机 ===" -ForegroundColor Cyan
# 装机 = 把本仓库的 link 依赖装进 DSH profile，让 DSH 下次加载时用上新代码。
# 因为安装方式是 Junction（软链），代码本身已经在目标位置，这一步主要是让 pnpm
# 确认依赖树一致（改了 package.json 的依赖/版本时需要它），并把 package.json 里的
# version 同步进 profile 的锁文件。
# profile 目录：优先用 DSH 进程传下来的，其次 <用户>\.dsh\profiles\<profile>
$ProfileName = if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'desktop' }
$ProfileDir = if ($env:DSH_PROFILE_DIR) { $env:DSH_PROFILE_DIR } else { Join-Path $env:USERPROFILE ".dsh\profiles\$ProfileName" }

if (-not (Test-Path $ProfileDir)) {
  Write-Host "  找不到 profile 目录，跳过自动装机：$ProfileDir" -ForegroundColor Yellow
} elseif (-not $PnpmJs -or -not (Test-Path $PnpmJs)) {
  Write-Host "  找不到 pnpm，跳过自动装机（不影响代码与 tag）" -ForegroundColor Yellow
} else {
  # pnpm 需要 node 在 PATH 上
  $NodeDir = Split-Path -Parent $Node
  $env:PATH = "$NodeDir;$env:PATH"

  Push-Location $ProfileDir
  try {
    & $Node $PnpmJs install --silent 2>&1 | ForEach-Object { "  $_" }
    if ($LASTEXITCODE -ne 0) {
      Write-Host "  pnpm install 返回 $LASTEXITCODE，继续（通常不影响 link 安装）" -ForegroundColor Yellow
    } else {
      Write-Host "  ✓ 依赖已同步" -ForegroundColor Green
    }
  } finally {
    Pop-Location
  }

  # 校验软链指向本仓库
  $linkPath = Join-Path $ProfileDir 'node_modules\dsh-weread-checkin'
  if (Test-Path $linkPath) {
    $target = (Get-Item $linkPath).Target
    $targetText = if ($target -is [array]) { $target[0] } else { $target }
    if ($targetText -and ($targetText -replace '/', '\').TrimEnd('\') -eq $Repo.TrimEnd('\')) {
      Write-Host "  ✓ 软链指向本仓库：$targetText" -ForegroundColor Green
    } else {
      Write-Host "  软链指向 $targetText（预期 $Repo）" -ForegroundColor Yellow
    }
  } else {
    Write-Host "  没找到 node_modules\dsh-weread-checkin，请在 DSH 里手动安装一次" -ForegroundColor Yellow
  }
}

# 读回来的确认输出，失败不影响发版结果（此时 commit/tag/push 都已经做完了）
try {
  $live = (Get-Content (Join-Path $Repo 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
} catch {
  $live = $Version
}
Write-Host ""
Write-Host "完成：v$Version（package.json 记为 $live）" -ForegroundColor Green
Write-Host "GitHub: https://github.com/zhangyxx1996/dsh-weread-checkin/releases/tag/v$Version"
Write-Host ""
Write-Host "最后一步：DSH 需要重新加载插件才会用上新代码。" -ForegroundColor Yellow
Write-Host "  在 DSH 对话里说一句「装一下新版本」即可（我会执行 remove_bundle + install_bundle）。" -ForegroundColor Yellow

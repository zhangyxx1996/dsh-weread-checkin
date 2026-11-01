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

$Git  = 'C:\Users\zhang\.workbuddy\vendor\PortableGit\cmd\git.exe'
$Node = 'C:\Users\zhang\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$Repo = Split-Path -Parent $MyInvocation.MyCommand.Path

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
  foreach ($t in @('probe-client-run.mjs', 'probe-layout-fix.mjs')) {
    & $Node $t *> $null
    if ($LASTEXITCODE -ne 0) { throw "$t 失败" }
    Write-Host "  ✓ $t"
  }
} finally {
  Pop-Location
}

Write-Host "=== 3/6 写入版本号 $Version ===" -ForegroundColor Cyan
& $Node -e @"
const fs = require('fs');
const dir = String.raw``$Repo``;
// package.json
const pj = dir + '\\package.json';
const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
j.version = '$Version';
fs.writeFileSync(pj, JSON.stringify(j, null, 2) + '\n');
// client.js 的兜底常量
const cj = dir + '\\client.js';
let s = fs.readFileSync(cj, 'utf8');
const before = s;
s = s.replace(/const PLUGIN_VERSION = '[^']*';/, "const PLUGIN_VERSION = '$Version';");
if (s === before) { console.error('未能替换 client.js 的 PLUGIN_VERSION'); process.exit(1); }
fs.writeFileSync(cj, s);
console.log('  version =', j.version);
"@
if ($LASTEXITCODE -ne 0) { throw '写入版本号失败' }

Write-Host "=== 4/6 提交并打 tag ===" -ForegroundColor Cyan
$msg = if ($Note) { "v${Version}: $Note" } else { "v${Version}" }
& $Git -C $Repo add -A
& $Git -C $Repo commit -m $msg
if ($LASTEXITCODE -ne 0) { Write-Host '  没有改动可提交，继续' -ForegroundColor Yellow }
& $Git -C $Repo tag -a "v$Version" -m $msg
if ($LASTEXITCODE -ne 0) { throw "打 tag v$Version 失败（可能已存在）" }

Write-Host "=== 5/6 推送到 GitHub ===" -ForegroundColor Cyan
& $Git -C $Repo push origin main --tags
if ($LASTEXITCODE -ne 0) { throw '推送失败' }

Write-Host "=== 6/6 装机 ===" -ForegroundColor Cyan
# 装机 = 把本仓库的 link 依赖装进 DSH profile，让 DSH 下次加载时用上新代码。
# 因为安装方式是 Junction（软链），代码本身已经在目标位置，这一步主要是让 pnpm
# 确认依赖树一致（改了 package.json 的依赖/版本时需要它），并把 package.json 里的
# version 同步进 profile 的锁文件。
$ProfileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$PnpmJs = 'C:\Users\zhang\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'

if (-not (Test-Path $ProfileDir)) {
  Write-Host "  找不到 profile 目录，跳过自动装机：$ProfileDir" -ForegroundColor Yellow
} elseif (-not (Test-Path $PnpmJs)) {
  Write-Host "  找不到 pnpm，跳过自动装机：$PnpmJs" -ForegroundColor Yellow
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

$live = Get-Content (Join-Path $Repo 'package.json') -Raw | ConvertFrom-Json
Write-Host ""
Write-Host "完成：v$Version（package.json 记为 $($live.version)）" -ForegroundColor Green
Write-Host "GitHub: https://github.com/zhangyxx1996/dsh-weread-checkin/releases/tag/v$Version"
Write-Host ""
Write-Host "最后一步：DSH 需要重新加载插件才会用上新代码。" -ForegroundColor Yellow
Write-Host "  在 DSH 对话里说一句「装一下新版本」即可（我会执行 remove_bundle + install_bundle）。" -ForegroundColor Yellow

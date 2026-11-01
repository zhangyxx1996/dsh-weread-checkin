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
Write-Host "  请回到 DSH 对话里说「装一下新版本」，或用 plugin_manager 重新安装。" -ForegroundColor Yellow
Write-Host ""
Write-Host "完成：v$Version 已发布 https://github.com/zhangyxx1996/dsh-weread-checkin/releases/tag/v$Version" -ForegroundColor Green

# install.ps1 — cài alp-code bằng một dòng (Windows PowerShell).
#
#   irm https://raw.githubusercontent.com/phucanh08/alp-code/main/install.ps1 | iex
#
# `iex` không nhận tham số dòng lệnh, nên tuỳ chọn đi qua biến môi trường:
#
#   $env:ALP_HOME = "D:\alp-code"; irm …/install.ps1 | iex
#   $env:ALP_NO_TRUST = "1";       irm …/install.ps1 | iex
#   $env:ALP_NO_PATH = "1";        irm …/install.ps1 | iex
#
# Biến: ALP_HOME (mặc định ~\.alp-code) · ALP_BRANCH (main) · ALP_REPO ·
#       ALP_NO_TRUST · ALP_NO_PATH
#
# Bản song sinh của install.sh và cũng cố ý mỏng: kiểm dependency, lấy code, rồi giao
# cho scripts/bootstrap.cjs — implementation thật, dùng chung cho cả ba OS.
# Chạy lại lệnh này = cập nhật (git pull + recompile), không đụng vào memory/.

$ErrorActionPreference = 'Stop'

function Say([string]$m) { Write-Host $m }
function Die([string]$m) { Write-Host "ERROR    $m" -ForegroundColor Red; exit 1 }

$repo   = if ($env:ALP_REPO)   { $env:ALP_REPO }   else { 'https://github.com/phucanh08/alp-code.git' }
$branch = if ($env:ALP_BRANCH) { $env:ALP_BRANCH } else { 'main' }
$target = if ($env:ALP_HOME)   { $env:ALP_HOME }   else { Join-Path $HOME '.alp-code' }
$nodeMin = 18

# ------------------------------------------------------------------ preflight
foreach ($cmd in @('git', 'node')) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    Die "thiếu ``$cmd``. git: https://git-scm.com/download/win · node: https://nodejs.org (cần >= v$nodeMin)"
  }
}

$nodeMajor = 0
try { $nodeMajor = [int](& node -p 'process.versions.node.split(".")[0]') } catch { $nodeMajor = 0 }
if ($nodeMajor -lt $nodeMin) { Die "Node $(& node -v) quá cũ — alp-code cần >= v$nodeMin" }

# ------------------------------------------------------------------ lấy code
if (Test-Path (Join-Path $target '.git')) {
  Say "PULL     $target"
  # --ff-only: nhánh nội bộ đã rẽ thì DỪNG. Không tự merge/stash hộ người dùng.
  & git -C $target pull --ff-only
  if ($LASTEXITCODE -ne 0) {
    Die "$target không fast-forward được — nhánh nội bộ đã rẽ hoặc đang dở việc.`n         Tự xử lý (git -C `"$target`" status) rồi chạy lại lệnh cài."
  }
}
elseif (Test-Path $target) {
  Die "$target đã tồn tại nhưng không phải git repo — installer không đụng vào.`n         Dọn thủ công, hoặc cài chỗ khác: `$env:ALP_HOME = `"D:\alp-code`""
}
else {
  Say "CLONE    $repo -> $target"
  $parent = Split-Path -Parent $target
  if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  & git clone --branch $branch $repo $target
  if ($LASTEXITCODE -ne 0) { Die "git clone thất bại" }
}

$bootstrap = Join-Path $target 'scripts\bootstrap.cjs'
if (-not (Test-Path $bootstrap)) { Die "$target thiếu scripts\bootstrap.cjs — clone hỏng hoặc nhánh ``$branch`` quá cũ" }

# ------------------------------------------------------------------ bàn giao
$forward = @()
if ($env:ALP_NO_TRUST) { $forward += '--no-trust' }

& node $bootstrap @forward
exit $LASTEXITCODE

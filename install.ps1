# install.ps1 — cài alp-code bằng một dòng (Windows PowerShell).
#
#   irm https://raw.githubusercontent.com/phucanh08/alp-code/main/install.ps1 | iex
#
# `iex` không nhận tham số dòng lệnh, nên tuỳ chọn đi qua biến môi trường:
#
#   $env:ALP_HOME = "D:\alp-code"; irm …/install.ps1 | iex
#   $env:ALP_NO_PATH = "1";        irm …/install.ps1 | iex
#
# Biến: ALP_HOME (mặc định ~\.alp-code) · ALP_BRANCH (main) · ALP_REPO ·
#       ALP_NO_PATH
#
# Bản song sinh của install.sh và cũng cố ý mỏng: kiểm dependency, lấy code, rồi giao
# cho scripts/bootstrap.cjs — implementation thật, dùng chung cho cả ba OS.
# Chạy lại lệnh này = cập nhật code + rebuild, không đụng memory/runtime/backend preferences.

# Chạy trong child scope để function/biến và ErrorActionPreference không rò vào terminal
# đang gọi `iex`. Biến môi trường PATH vẫn thuộc process nên thay đổi bên dưới có hiệu lực
# ngay trong chính terminal đó.
& {
  $ErrorActionPreference = 'Stop'

  function Say([string]$m) { Write-Host $m }
  # Không dùng `exit`: qua `irm | iex`, exit sẽ đóng luôn PowerShell của người dùng.
  function Die([string]$m) { throw "ERROR    $m" }

  $repo   = if ($env:ALP_REPO)   { $env:ALP_REPO }   else { 'https://github.com/phucanh08/alp-code.git' }
  $branch = if ($env:ALP_BRANCH) { $env:ALP_BRANCH } else { 'main' }
  $target = if ($env:ALP_HOME)   { $env:ALP_HOME }   else { Join-Path $HOME '.alp-code' }
  $nodeMin = 18

  # ---------------------------------------------------------------- preflight
  foreach ($cmd in @('git', 'node')) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
      Die "thiếu ``$cmd``. git: https://git-scm.com/download/win · node: https://nodejs.org (cần >= v$nodeMin)"
    }
  }

  # Windows PowerShell 5.1 làm mất quote lồng nhau khi truyền biểu thức `node -p` cho
  # native process. Đọc `node --version` rồi parse ở PowerShell để chạy giống nhau trên
  # powershell.exe 5.1 và pwsh 7+.
  $nodeVersion = ''
  $nodeMajor = 0
  try {
    $nodeVersion = (& node --version).Trim()
    $nodeMajor = [int]($nodeVersion.TrimStart('v').Split('.')[0])
  }
  catch {
    Die "không đọc được phiên bản Node — alp-code cần >= v$nodeMin"
  }
  if ($nodeMajor -lt $nodeMin) { Die "Node $nodeVersion quá cũ — alp-code cần >= v$nodeMin" }

  # ---------------------------------------------------------------- lấy code
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

  # ---------------------------------------------------------------- bàn giao
  $forward = @()
  & node $bootstrap @forward
  $bootstrapExit = $LASTEXITCODE
  if ($bootstrapExit -ne 0) { Die "bootstrap thất bại (exit $bootstrapExit)" }

  # bootstrap cập nhật User PATH cho terminal mở sau. Vì installer chạy bằng `iex` trong
  # terminal hiện tại, bổ sung luôn process PATH để `alp init` dùng được ngay, không cần mở
  # cửa sổ mới. ALP_NO_PATH vẫn giữ đúng nghĩa: không sửa cả User PATH lẫn process PATH.
  if (-not $env:ALP_NO_PATH) {
    $localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME 'AppData\Local' }
    $binDir = Join-Path $localAppData 'alp\bin'
    $alpShim = Join-Path $binDir 'alp.cmd'
    if (-not (Test-Path $alpShim)) { Die "bootstrap báo thành công nhưng thiếu $alpShim" }

    $normalizedBin = $binDir.TrimEnd('\')
    $pathParts = @($env:Path -split ';' | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\') })
    if ($pathParts -notcontains $normalizedBin) {
      $env:Path = if ($env:Path) { "$binDir;$env:Path" } else { $binDir }
    }
    Say "ACTIVE   alp dùng được ngay trong terminal này — thử: alp init"
  }
}

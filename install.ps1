# install.ps1 — cài alp-code bằng một dòng (Windows PowerShell).
#
#   irm https://raw.githubusercontent.com/phucanh08/alp-code/main/install.ps1 | iex
#
# `iex` không nhận tham số dòng lệnh, nên tuỳ chọn đi qua biến môi trường:
#
#   $env:ALP_CHANNEL = "tarball"; irm …/install.ps1 | iex
#   $env:ALP_VERSION = "v0.9.0";  irm …/install.ps1 | iex
#   $env:ALP_HOME = "D:\alp-code"; irm …/install.ps1 | iex
#   $env:ALP_NO_PATH = "1";       irm …/install.ps1 | iex
#
# Biến: ALP_CHANNEL (auto|npm|tarball) · ALP_VERSION (tag cụ thể) · ALP_HOME (mặc định
#       ~\.alp-code, chỉ dùng cho tarball/dev) · ALP_BRANCH (dev) · ALP_REPO · ALP_NO_PATH
#
# KHÔNG BUILD GÌ TRÊN MÁY NÀY — bản phát hành đã compile sẵn. Bản song sinh của install.sh và
# cũng cố ý mỏng: lấy artifact về đúng chỗ rồi giao cho scripts/bootstrap.cjs, implementation
# thật dùng chung cho cả ba OS.
#
# Chạy lại lệnh này = cập nhật code. Memory và preferences nằm ở `~\.alp`, ngoài thư mục cài.

# Chạy trong child scope để function/biến và ErrorActionPreference không rò vào terminal
# đang gọi `iex`. Biến môi trường PATH vẫn thuộc process nên thay đổi bên dưới có hiệu lực
# ngay trong chính terminal đó.
& {
  $ErrorActionPreference = 'Stop'

  function Say([string]$m) { Write-Host $m }
  # Không dùng `exit`: qua `irm | iex`, exit sẽ đóng luôn PowerShell của người dùng.
  function Die([string]$m) { throw "ERROR    $m" }
  function Have([string]$c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }

  $package  = 'alp-code'
  $repoSlug = if ($env:ALP_REPO_SLUG) { $env:ALP_REPO_SLUG } else { 'phucanh08/alp-code' }
  $repo     = if ($env:ALP_REPO)      { $env:ALP_REPO }      else { "https://github.com/$repoSlug.git" }
  $channel  = if ($env:ALP_CHANNEL)   { $env:ALP_CHANNEL }   else { 'auto' }
  $branch   = if ($env:ALP_BRANCH)    { $env:ALP_BRANCH }    else { '' }
  $version  = if ($env:ALP_VERSION)   { $env:ALP_VERSION }   else { '' }
  $target   = if ($env:ALP_HOME)      { $env:ALP_HOME }      else { Join-Path $HOME '.alp-code' }
  $nodeMin  = 18
  if ($branch) { $channel = 'dev' }
  if (@('auto', 'npm', 'tarball', 'dev') -notcontains $channel) { Die "ALP_CHANNEL không hợp lệ: $channel (auto|npm|tarball)" }

  # ---------------------------------------------------------------- preflight
  if (-not (Have 'node')) { Die "thiếu ``node``. Cần Node >= v$nodeMin — https://nodejs.org" }

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

  $auto = ($channel -eq 'auto')
  if ($auto) { $channel = if (Have 'npm') { 'npm' } else { 'tarball' } }

  # ---------------------------------------------------------------- channel npm
  function Install-Npm {
    $spec = if ($version) { "$package@$($version.TrimStart('v'))" } else { $package }
    Say "NPM      npm install -g $spec"
    & npm install --global $spec
    if ($LASTEXITCODE -ne 0) { return $null }
    $globalRoot = (& npm root -g | Select-Object -Last 1).Trim()
    $root = Join-Path $globalRoot $package
    if (-not (Test-Path (Join-Path $root 'scripts\bootstrap.cjs'))) {
      Die "npm báo thành công nhưng không thấy $root — kiểm tra ``npm root -g``"
    }
    return $root
  }

  # ------------------------------------------------------------ channel tarball
  # Giải nén sang thư mục MỚI rồi mới trỏ `current` sang đó: tải hỏng giữa chừng thì bản đang
  # dùng vẫn còn nguyên. Đúng cách `alp update` làm, để hai đường không lệch nhau.
  function Install-Tarball {
    $tag = $version
    if (-not $tag) {
      Say "RESOLVE  tag release mới nhất của $repoSlug"
      try {
        $tag = (Invoke-RestMethod -UseBasicParsing "https://api.github.com/repos/$repoSlug/releases/latest").tag_name
      }
      catch { Die "không hỏi được GitHub Releases ($($_.Exception.Message)) — thử lại, hoặc đặt `$env:ALP_VERSION" }
    }
    if (-not $tag.StartsWith('v')) { $tag = "v$tag" }

    $url      = "https://github.com/$repoSlug/releases/download/$tag/$package-$tag-bundle.tar.gz"
    $versions = Join-Path $target 'versions'
    $dest     = Join-Path $versions $tag
    $staging  = Join-Path $versions ".incoming-$tag-$PID"
    $archive  = Join-Path $versions ".$tag-$PID.tar.gz"

    # tar.exe có sẵn từ Windows 10 1803. Máy cũ hơn thì nói thẳng thay vì gãy giữa chừng.
    if (-not (Have 'tar')) { Die "thiếu ``tar`` (Windows 10 1803 trở lên mới có sẵn) — dùng kênh npm thay thế" }
    New-Item -ItemType Directory -Path $versions -Force | Out-Null
    if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
    New-Item -ItemType Directory -Path $staging -Force | Out-Null

    try {
      Say "DOWNLOAD $url"
      try { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $archive }
      catch { Die "không tải được $url`n         Kiểm tra tag và asset bundle: https://github.com/$repoSlug/releases" }

      & tar -xzf $archive -C $staging
      if ($LASTEXITCODE -ne 0) { Die "bundle hỏng — giải nén thất bại" }
      if (-not (Test-Path (Join-Path $staging 'scripts\alp.cjs'))) { Die "bundle $tag không đúng cấu trúc — thiếu scripts\alp.cjs" }

      if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
      Move-Item $staging $dest
    }
    finally {
      if (Test-Path $archive) { Remove-Item -Force $archive }
      if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
    }

    # Junction chứ không phải symlink: symlink thư mục trên Windows cần quyền admin hoặc
    # Developer Mode, junction thì không cần gì cả.
    $link = Join-Path $target 'current'
    if (Test-Path $link) {
      $item = Get-Item $link -Force
      if (-not $item.LinkType) { Die "$link đang là thư mục thật, không phải junction — dọn thủ công rồi chạy lại" }
      Remove-Item -Force -Recurse $link
    }
    New-Item -ItemType Junction -Path $link -Target $dest | Out-Null
    Say "INSTALL  $tag -> $dest (current -> $tag)"
    return $link
  }

  # ---------------------------------------------------------------- channel dev
  function Install-Dev {
    if (-not (Have 'git')) { Die "thiếu ``git`` — https://git-scm.com/download/win" }
    if (Test-Path (Join-Path $target '.git')) {
      Say "PULL     $target (nhánh $branch)"
      # --ff-only: nhánh nội bộ đã rẽ thì DỪNG. Không tự merge/stash hộ người dùng.
      & git -C $target fetch origin $branch
      $ok = ($LASTEXITCODE -eq 0)
      if ($ok) { & git -C $target checkout $branch; $ok = ($LASTEXITCODE -eq 0) }
      if ($ok) { & git -C $target pull --ff-only; $ok = ($LASTEXITCODE -eq 0) }
      if (-not $ok) {
        Die "$target không cập nhật được nhánh ``$branch`` — nhánh nội bộ đã rẽ hoặc đang dở việc.`n         Tự xử lý (git -C `"$target`" status) rồi chạy lại lệnh cài."
      }
    }
    elseif (Test-Path $target) {
      Die "$target đã tồn tại nhưng không phải git repo — installer không đụng vào.`n         Dọn thủ công, hoặc clone chỗ khác: `$env:ALP_HOME = `"D:\alp-code`""
    }
    else {
      $parent = Split-Path -Parent $target
      if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
      Say "CLONE    $repo (nhánh $branch) -> $target"
      & git clone --branch $branch $repo $target
      if ($LASTEXITCODE -ne 0) { Die "git clone thất bại" }
    }
    return $target
  }

  # ---------------------------------------------------------------- lấy code
  $root = $null
  switch ($channel) {
    'npm' {
      $root = Install-Npm
      if (-not $root) {
        if (-not $auto) { Die "``npm install -g $package`` thất bại — xem log ở trên" }
        # Registry bị chặn hay npm global không ghi được là chuyện thường trên máy công ty.
        # Đó chính là lý do có channel thứ hai, nên tự chuyển thay vì bắt người dùng đọc lại.
        Say "FALLBACK npm không cài được — chuyển sang bundle của GitHub Release"
        $channel = 'tarball'
        $root = Install-Tarball
      }
    }
    'tarball' { $root = Install-Tarball }
    'dev'     { $root = Install-Dev }
  }

  $bootstrap = Join-Path $root 'scripts\bootstrap.cjs'
  if (-not (Test-Path $bootstrap)) { Die "$root thiếu scripts\bootstrap.cjs — bản cài hỏng hoặc quá cũ" }

  # ---------------------------------------------------------------- bàn giao
  & node $bootstrap
  $bootstrapExit = $LASTEXITCODE
  if ($bootstrapExit -ne 0) { Die "bootstrap thất bại (exit $bootstrapExit)" }

  # bootstrap cập nhật User PATH cho terminal mở sau. Vì installer chạy bằng `iex` trong
  # terminal hiện tại, bổ sung luôn process PATH để `alp init` dùng được ngay, không cần mở
  # cửa sổ mới. ALP_NO_PATH vẫn giữ đúng nghĩa: không sửa cả User PATH lẫn process PATH.
  #
  # Bản npm không đi qua đây: lệnh `alp` ở đó do npm tạo trong global bin dir của chính nó,
  # thư mục vốn đã nằm sẵn trong PATH.
  if ($channel -ne 'npm' -and -not $env:ALP_NO_PATH) {
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

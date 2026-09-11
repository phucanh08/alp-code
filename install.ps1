# Native alp-code installer for Windows x64. The binary channel does not require Node.
& {
  $ErrorActionPreference = 'Stop'
  function Say([string]$Message) { Write-Host $Message }
  function Die([string]$Message) { throw "ERROR     $Message" }
  function Have([string]$Command) { [bool](Get-Command $Command -ErrorAction SilentlyContinue) }

  $package = 'alp-code'
  $repoSlug = if ($env:ALP_REPO_SLUG) { $env:ALP_REPO_SLUG } else { 'phucanh08/alp-code' }
  $repo = if ($env:ALP_REPO) { $env:ALP_REPO } else { "https://github.com/$repoSlug.git" }
  $channel = if ($env:ALP_CHANNEL) { $env:ALP_CHANNEL } else { 'auto' }
  $version = if ($env:ALP_VERSION) { $env:ALP_VERSION } else { '' }
  $branch = if ($env:ALP_BRANCH) { $env:ALP_BRANCH } else { '' }
  $target = if ($env:ALP_HOME) { $env:ALP_HOME } else { Join-Path $HOME '.alp-code' }
  $noPath = ($env:ALP_NO_PATH -eq '1')
  if ($branch) { $channel = 'dev' }
  if ($channel -eq 'auto' -or $channel -eq 'tarball') { $channel = 'binary' }
  if (@('binary', 'npm', 'dev') -notcontains $channel) { Die "unsupported ALP_CHANNEL: $channel" }

  function Require-Node {
    if (-not (Have 'node')) { Die "Node >=18 is required only for the $channel channel" }
    $nodeVersion = (& node --version).Trim()
    if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 18) { Die "Node $nodeVersion is too old; $channel requires >=18" }
  }

  function Install-Npm {
    Require-Node
    if (-not (Have 'npm')) { Die 'npm is required for the npm channel' }
    $spec = if ($version) { "$package@$($version.TrimStart('v'))" } else { $package }
    Say "NPM       npm install -g $spec"
    & npm install --global $spec
    if ($LASTEXITCODE -ne 0) { Die "npm install -g $spec failed" }
    & alp __internal ensure-state
    if ($LASTEXITCODE -ne 0) { Die 'npm wrapper installed but state initialization failed' }
  }

  function Install-Dev {
    Require-Node
    if (-not (Have 'git')) { Die 'git is required for the dev channel' }
    if (-not $branch) { $branch = 'main' }
    if (Test-Path (Join-Path $target '.git')) {
      & git -C $target fetch origin $branch
      if ($LASTEXITCODE -ne 0) { Die 'git fetch failed' }
      & git -C $target checkout $branch
      if ($LASTEXITCODE -ne 0) { Die 'git checkout failed' }
      & git -C $target pull --ff-only
      if ($LASTEXITCODE -ne 0) { Die 'git pull --ff-only failed' }
    } elseif (Test-Path $target) {
      Die "$target exists and is not a git clone"
    } else {
      New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
      & git clone --branch $branch $repo $target
      if ($LASTEXITCODE -ne 0) { Die 'git clone failed' }
    }
    $bootstrap = Join-Path $target 'scripts\bootstrap.cjs'
    if (-not (Test-Path $bootstrap)) { Die "$target is missing scripts\bootstrap.cjs" }
    if ($noPath) { & node $bootstrap --no-path } else { & node $bootstrap }
    if ($LASTEXITCODE -ne 0) { Die "bootstrap failed (exit $LASTEXITCODE)" }
  }

  function Get-ReleaseVersion {
    $tag = $version
    if (-not $tag) {
      Say "RESOLVE   latest release for $repoSlug"
      $tag = (Invoke-RestMethod -UseBasicParsing "https://api.github.com/repos/$repoSlug/releases/latest").tag_name
    }
    if (-not $tag.StartsWith('v')) { $tag = "v$tag" }
    if ($tag -notmatch '^v\d+\.\d+\.\d+$') { Die "invalid release version: $tag" }
    return $tag
  }

  function Assert-SafeArchive([string]$Archive) {
    $entries = @(& tar -tzf $Archive)
    if ($LASTEXITCODE -ne 0) { Die 'release archive is not readable' }
    foreach ($raw in $entries) {
      $entry = $raw -replace '^\./', ''
      if (-not $entry -or $entry -eq '.') { continue }
      if ($entry.StartsWith('/') -or $entry.StartsWith('\') -or $entry.Contains('\') -or $entry -match '^[A-Za-z]:' -or ($entry -split '/') -contains '..') {
        Die "unsafe archive entry: $raw"
      }
    }
    foreach ($line in @(& tar -tvzf $Archive)) {
      if ($line -match '^[lh]') { Die 'release archive contains a link entry; refusing extraction' }
    }
  }

  function Replace-Current([string]$InstallRoot, [string]$Destination) {
    $current = Join-Path $InstallRoot 'current'
    $temporary = Join-Path $InstallRoot ".current.$PID.$([DateTime]::UtcNow.Ticks)"
    New-Item -ItemType Junction -Path $temporary -Target $Destination | Out-Null
    try {
      if (Test-Path $current) {
        $item = Get-Item $current -Force
        if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { Die "$current is not a junction; refusing to replace it" }
        # Rename-over-junction is attempted without pre-unlink. If this host rejects that
        # operation the old current remains live and the installer reports the exact failure.
        Move-Item -LiteralPath $temporary -Destination $current -Force
      } else {
        Move-Item -LiteralPath $temporary -Destination $current
      }
    } finally {
      if (Test-Path $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
    }
  }

  function Add-Command([string]$Executable) {
    if ($noPath) { return }
    $localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME 'AppData\Local' }
    $binDir = Join-Path $localAppData 'alp\bin'
    $shim = Join-Path $binDir 'alp.cmd'
    $body = "@rem alp-code native shim`r`n@echo off`r`n`"$Executable`" %*`r`n"
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
    if (Test-Path $shim) {
      $existing = [IO.File]::ReadAllText($shim)
      if (-not $existing.StartsWith('@rem alp-code native shim')) { Die "$shim exists and is not owned by alp-code" }
    }
    [IO.File]::WriteAllText($shim, $body, [Text.Encoding]::ASCII)
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @($userPath -split ';' | Where-Object { $_ })
    if ($parts -notcontains $binDir) {
      [Environment]::SetEnvironmentVariable('Path', (($parts + $binDir) -join ';'), 'User')
    }
    if (@($env:Path -split ';') -notcontains $binDir) { $env:Path = "$binDir;$env:Path" }
  }

  function Install-Binary {
    $architecture = $env:PROCESSOR_ARCHITEW6432
    if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
    if ($architecture -notmatch '^(AMD64|x86_64)$') { Die "unsupported Windows architecture: $architecture (only x64 is published)" }
    if (-not (Have 'tar')) { Die 'tar.exe is required (Windows 10 1803 or newer)' }
    $tag = Get-ReleaseVersion
    $number = $tag.TrimStart('v')
    $targetId = 'windows-x64'
    $filename = "$package-$tag-$targetId.tar.gz"
    $base = "https://github.com/$repoSlug/releases/download/$tag"
    $staging = Join-Path $target ".staging-$tag-$PID"
    $archive = Join-Path $target ".$filename.$PID"
    $checksums = Join-Path $target ".SHA256SUMS.$PID"
    $destination = Join-Path $target "versions\$tag"
    New-Item -ItemType Directory -Path (Join-Path $target 'versions') -Force | Out-Null
    try {
      Say "DOWNLOAD  $filename"
      Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $checksums
      Invoke-WebRequest -UseBasicParsing -Uri "$base/$filename" -OutFile $archive
      $line = Get-Content -LiteralPath $checksums | Where-Object { $_ -match "^[0-9a-fA-F]{64}\s+\*?$([regex]::Escape($filename))$" } | Select-Object -First 1
      if (-not $line) { Die "checksum entry missing for $filename" }
      $expected = ($line -split '\s+')[0].ToLowerInvariant()
      $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
      if ($actual -ne $expected) { Die "checksum mismatch for $filename" }
      Assert-SafeArchive $archive
      New-Item -ItemType Directory -Path $staging -Force | Out-Null
      & tar -xzf $archive -C $staging
      if ($LASTEXITCODE -ne 0) { Die 'release archive extraction failed' }
      $manifest = Get-Content -LiteralPath (Join-Path $staging 'install-manifest.json') -Raw | ConvertFrom-Json
      if ($manifest.app -ne 'alp-code' -or $manifest.version -ne $number -or $manifest.target -ne $targetId) { Die 'install manifest does not match version/target' }
      $stagedExe = Join-Path $staging 'bin\alp.exe'
      $reported = (& $stagedExe --version | Out-String).Trim()
      if ($LASTEXITCODE -ne 0 -or $reported -ne "alp $number") { Die 'staged binary version smoke failed' }
      if (Test-Path $destination) {
        $existing = (& (Join-Path $destination 'bin\alp.exe') --version | Out-String).Trim()
        if ($existing -ne "alp $number") { Die "$destination exists but is incomplete" }
        Remove-Item -LiteralPath $staging -Recurse -Force
      } else { Move-Item -LiteralPath $staging -Destination $destination }
      $current = Join-Path $target 'current'
      $previous = $null
      if (Test-Path $current) {
        $previous = (Get-Item $current -Force).Target
        if ($previous -is [array]) { $previous = $previous[0] }
      }
      Replace-Current $target $destination
      $stable = Join-Path $target 'current\bin\alp.exe'
      & $stable __internal ensure-state
      if ($LASTEXITCODE -ne 0) {
        if ($previous) { Replace-Current $target $previous }
        elseif (Test-Path $current) { Remove-Item -LiteralPath $current -Recurse -Force }
        Die 'state initialization failed; previous current pointer restored'
      }
      Add-Command $stable
      Say "READY     alp-code $tag ($targetId) at $target"
    } finally {
      foreach ($item in @($staging, $archive, $checksums)) { if (Test-Path $item) { Remove-Item -LiteralPath $item -Recurse -Force } }
    }
  }

  function Install-Tarball { Install-Binary }

  switch ($channel) {
    'binary' { Install-Binary }
    'npm' { Install-Npm }
    'dev' { Install-Dev }
  }

  # Keep the current iex terminal usable after the dev bootstrap creates its shim.
  if ($channel -eq 'dev' -and -not $noPath) {
    $localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME 'AppData\Local' }
    $binDir = Join-Path $localAppData 'alp\bin'
    if (@($env:Path -split ';') -notcontains $binDir) { $env:Path = "$binDir;$env:Path" }
  }
}

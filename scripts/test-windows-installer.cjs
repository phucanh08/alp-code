#!/usr/bin/env node
// test-windows-installer.cjs — integration test wrapper `irm ... | iex` trên Windows.
//
// Dùng fake git/node trong process PowerShell con để không clone, không trust và không sửa
// User PATH thật. Fixture chỉ kiểm contract của install.ps1: PS 5.1 đọc đúng Node version,
// lỗi không `exit` host, success kích hoạt alp.cmd ngay và child scope không rò biến/function.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

if (process.platform !== "win32") {
  console.log("SKIP             Windows installer: cần Windows");
  process.exit(0);
}

const repoRoot = path.resolve(__dirname, "..");
const installer = path.join(repoRoot, "install.ps1");
const engines = ["powershell.exe", "pwsh.exe"].filter(commandExists);
assert(engines.length > 0, "không tìm thấy powershell.exe hoặc pwsh.exe");

let failed = 0;
for (const engine of engines) runEngine(engine);
if (failed) process.exit(1);
console.log(`OK               Windows installer: ${engines.length} engine đều xanh`);

function runEngine(engine) {
  const sandbox = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "alp-win-installer-"));
  const target = path.join(sandbox, "alp home");
  const badTarget = path.join(sandbox, "not a repo");
  const localAppData = path.join(sandbox, "local app data");
  const harness = path.join(sandbox, "harness.ps1");

  fs.mkdirSync(path.join(target, ".git"), { recursive: true });
  fs.mkdirSync(path.join(target, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(target, "scripts", "bootstrap.cjs"), "// fake bootstrap\n");
  fs.mkdirSync(badTarget, { recursive: true });
  // BOM để powershell.exe 5.1 chắc chắn đọc harness dưới dạng UTF-8.
  fs.writeFileSync(harness, `\ufeff${harnessSource({ installer, target, badTarget, localAppData })}`);

  try {
    const r = spawnSync(engine, ["-NoProfile", "-NonInteractive", "-File", harness], {
      encoding: "utf8",
      cwd: repoRoot,
      env: { ...process.env },
    });
    const output = `${r.stdout || ""}\n${r.stderr || ""}`;
    check(`${engine}: installer trả quyền cho caller`, () => {
      assert.strictEqual(r.status, 0, output);
      assert(output.includes("AFTER_SUCCESS"), output);
      assert(output.includes("CAUGHT_ERROR"), output);
      assert(output.includes("AFTER_ERROR"), output);
    });
    check(`${engine}: dùng node --version tương thích PS 5.1`, () => {
      assert(output.includes("NODE_VERSION_MODE::dash-dash-version"), output);
      assert(!output.includes("NODE_VERSION_MODE::node-p"), output);
    });
    check(`${engine}: bootstrap sở hữu npm ci/build code-native`, () => {
      const source = fs.readFileSync(installer, "utf8");
      assert(source.includes("scripts\\bootstrap.cjs"));
    });
    check(`${engine}: alp dùng được ngay trong terminal hiện tại`, () => {
      assert(output.includes("PATH_ACTIVE::True"), output);
      assert(output.includes("ALP_OK"), output);
    });
    check(`${engine}: child scope không làm bẩn terminal`, () => {
      assert(output.includes("PREFERENCE::Continue"), output);
      assert(output.includes("SCOPE::clean"), output);
    });
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

function harnessSource({ installer, target, badTarget, localAppData }) {
  return `$ErrorActionPreference = 'Continue'
$env:ALP_HOME = ${psQuote(target)}
$env:LOCALAPPDATA = ${psQuote(localAppData)}
$env:ALP_NO_TRUST = '1'
Remove-Item Env:ALP_NO_PATH -ErrorAction SilentlyContinue
$global:NodeVersionMode = 'missing'

function global:git {
  $global:LASTEXITCODE = 0
}

function global:node {
  if ($args.Count -eq 1 -and $args[0] -eq '--version') {
    $global:NodeVersionMode = 'dash-dash-version'
    $global:LASTEXITCODE = 0
    Write-Output 'v20.13.1'
    return
  }
  if ($args.Count -gt 0 -and $args[0] -eq '-p') {
    $global:NodeVersionMode = 'node-p'
    $global:LASTEXITCODE = 9
    return
  }

  $binDir = Join-Path $env:LOCALAPPDATA 'alp\\bin'
  New-Item -ItemType Directory -Path $binDir -Force | Out-Null
  [IO.File]::WriteAllText(
    (Join-Path $binDir 'alp.cmd'),
    "@echo off\r\necho ALP_OK\r\n",
    [Text.Encoding]::ASCII
  )
  $global:LASTEXITCODE = 0
}

(Get-Content -LiteralPath ${psQuote(installer)} -Raw -Encoding UTF8) | Invoke-Expression
Write-Output 'AFTER_SUCCESS'
Write-Output "NODE_VERSION_MODE::$global:NodeVersionMode"
Write-Output "PREFERENCE::$ErrorActionPreference"
if (Get-Command Die -ErrorAction SilentlyContinue) {
  Write-Output 'SCOPE::leaked'
} else {
  Write-Output 'SCOPE::clean'
}
$expectedBin = Join-Path $env:LOCALAPPDATA 'alp\\bin'
$pathActive = @(($env:Path -split ';') | Where-Object { $_.TrimEnd('\\') -eq $expectedBin.TrimEnd('\\') }).Count -gt 0
Write-Output "PATH_ACTIVE::$pathActive"
& alp

$env:ALP_HOME = ${psQuote(badTarget)}
try {
  (Get-Content -LiteralPath ${psQuote(installer)} -Raw -Encoding UTF8) | Invoke-Expression
  Write-Output 'ERROR_NOT_THROWN'
} catch {
  Write-Output 'CAUGHT_ERROR'
}
Write-Output 'AFTER_ERROR'
`;
}

function psQuote(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function commandExists(command) {
  const r = spawnSync(command, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
    stdio: "ignore",
  });
  return !r.error;
}

function check(name, fn) {
  try {
    fn();
    console.log(`PASS             ${name}`);
  } catch (e) {
    console.log(`FAIL             ${name}\n                 ${e.message.split("\n").join("\n                 ")}`);
    failed++;
  }
}

#!/usr/bin/env node
// test-cli-link.cjs — nghiệm thu bước đưa `alp` vào PATH trên macOS/Linux/Windows.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const CLI = require("./lib/cli-link.cjs");

const sandbox = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "alp-cli-link-"));
const repo = path.join(sandbox, "alp code");
const cli = path.join(repo, "scripts", "alp.cjs");
fs.mkdirSync(path.dirname(cli), { recursive: true });
fs.writeFileSync(cli, "#!/usr/bin/env node\n");

let failed = 0;
try {
  testProfiles();
  testUnixInstall();
  testUnixUninstall();
  testSkipPath();
  testForeignUnixCommand();
  testWindowsInstall();
  testWindowsUninstall();
  testWindowsRemovePathSyntax();
  testWindowsPathDetection();
  testForeignWindowsCommand();
  testForeignWindowsUninstall();
  testBootstrapWiring();
  testDoctorAndInstallerWiring();
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log("OK               cli link: 12 nhóm ca đều xanh");

function testProfiles() {
  const home = path.join(sandbox, "profiles");
  check("zsh dùng .zshrc", () =>
    assert.deepStrictEqual(CLI.profileFor({ HOME: home, SHELL: "/bin/zsh" }, "darwin"), {
      file: path.join(home, ".zshrc"),
      syntax: "posix",
    }));
  check("bash macOS dùng .bash_profile", () =>
    assert.strictEqual(
      CLI.profileFor({ HOME: home, SHELL: "/bin/bash" }, "darwin").file,
      path.join(home, ".bash_profile")
    ));
  check("bash Linux dùng .bashrc", () =>
    assert.strictEqual(
      CLI.profileFor({ HOME: home, SHELL: "/bin/bash" }, "linux").file,
      path.join(home, ".bashrc")
    ));
  check("fish dùng config.fish", () =>
    assert.strictEqual(
      CLI.profileFor({ HOME: home, SHELL: "/usr/bin/fish" }, "linux").file,
      path.join(home, ".config", "fish", "config.fish")
    ));
  check("shell lạ không bị đoán profile", () =>
    assert.strictEqual(CLI.profileFor({ HOME: home, SHELL: "/bin/nu" }, "linux"), null));
}

function testUnixInstall() {
  const home = path.join(sandbox, "unix-home");
  const env = { HOME: home, SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" };
  const target = path.join(home, ".local", "bin", "alp");
  const profile = path.join(home, ".zshrc");

  const first = CLI.installCli(repo, { env, platform: "darwin" });
  check("Unix tạo symlink alp", () => {
    assert(fs.lstatSync(target).isSymbolicLink());
    assert.strictEqual(fs.readlinkSync(target), cli);
    assert(first.some((x) => x.level === "LINKED"));
  });
  check("Unix thêm PATH có marker", () => {
    const body = fs.readFileSync(profile, "utf8");
    assert(body.includes(CLI.BEGIN));
    assert(body.includes(`export PATH="${path.dirname(target)}:$PATH"`));
  });

  CLI.installCli(repo, { env, platform: "darwin" });
  check("chạy lại không nhân bản khối PATH", () => {
    const body = fs.readFileSync(profile, "utf8");
    assert.strictEqual(body.split(CLI.BEGIN).length - 1, 1);
  });
}

function testUnixUninstall() {
  const home = path.join(sandbox, "unix-uninstall-home");
  const env = { HOME: home, SHELL: "/bin/zsh", PATH: "/usr/bin" };
  const target = path.join(home, ".local", "bin", "alp");
  const profile = path.join(home, ".zshrc");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(profile, "export MINE=1\n");
  CLI.installCli(repo, { env, platform: "darwin" });
  env.PATH = `/usr/bin:${path.dirname(target)}`;

  const first = CLI.uninstallCli(repo, { env, platform: "darwin" });
  const second = CLI.uninstallCli(repo, { env, platform: "darwin" });
  check("Unix uninstall gỡ symlink và chỉ khối PATH có marker", () => {
    const body = fs.readFileSync(profile, "utf8");
    assert(!fs.existsSync(target));
    assert(body.includes("export MINE=1"));
    assert(!body.includes(CLI.BEGIN));
    assert(first.some((x) => x.level === "REMOVED"));
  });
  check("Unix uninstall chạy lại an toàn", () =>
    assert(second.some((x) => x.level === "ABSENT")));
}

function testSkipPath() {
  const home = path.join(sandbox, "no-path-home");
  const env = { HOME: home, SHELL: "/bin/zsh", PATH: "/usr/bin" };
  const log = CLI.installCli(repo, { env, platform: "linux", skipPath: true });
  check("--no-path vẫn tạo lệnh nhưng không sửa profile", () => {
    assert(fs.existsSync(path.join(home, ".local", "bin", "alp")));
    assert(!fs.existsSync(path.join(home, ".zshrc")));
    assert(log.some((x) => x.text.includes("--no-path")));
  });
}

function testForeignUnixCommand() {
  const home = path.join(sandbox, "foreign-unix-home");
  const target = path.join(home, ".local", "bin", "alp");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "mine\n");

  const log = CLI.installCli(repo, {
    env: { HOME: home, SHELL: "/bin/zsh", PATH: "/usr/bin" },
    platform: "linux",
  });
  check("Unix không đè lệnh alp của người dùng", () => {
    assert.strictEqual(fs.readFileSync(target, "utf8"), "mine\n");
    assert(log.some((x) => x.level === "SKIP"));
  });
}

function testWindowsInstall() {
  const localAppData = path.join(sandbox, "win-local");
  const env = { USERPROFILE: path.join(sandbox, "win-user"), LOCALAPPDATA: localAppData, Path: "C:\\Windows" };
  let applied = null;
  const log = CLI.installCli(repo, {
    env,
    platform: "win32",
    applyWindowsPath(dir) {
      applied = dir;
      return "added";
    },
  });
  const dir = path.join(localAppData, "alp", "bin");
  const target = path.join(dir, "alp.cmd");

  check("Windows tạo alp.cmd không cần symlink", () => {
    const body = fs.readFileSync(target, "utf8");
    assert.strictEqual(body, CLI.cmdShim(cli));
    assert(body.includes(`node "${cli}" %*`));
    assert(body.includes("\r\n"));
  });
  check("Windows thêm đúng thư mục shim vào User PATH", () => {
    assert.strictEqual(applied, dir);
    assert(log.some((x) => x.level === "WROTE" && x.text.includes("PATH (User)")));
  });
}

function testWindowsUninstall() {
  const localAppData = path.join(sandbox, "win-uninstall-local");
  const dir = path.join(localAppData, "alp", "bin");
  const target = path.join(dir, "alp.cmd");
  const env = {
    USERPROFILE: path.join(sandbox, "win-uninstall-user"),
    LOCALAPPDATA: localAppData,
    Path: `C:\\Windows;${dir};C:\\Node`,
  };
  CLI.installCli(repo, { env, platform: "win32" });
  let removed = null;
  const first = CLI.uninstallCli(repo, {
    env,
    platform: "win32",
    removeWindowsPath(value) {
      removed = value;
      return "removed";
    },
  });
  const second = CLI.uninstallCli(repo, {
    env,
    platform: "win32",
    removeWindowsPath() { return "absent"; },
  });

  check("Windows uninstall gỡ alp.cmd và User PATH", () => {
    assert.strictEqual(removed, dir);
    assert(!fs.existsSync(target));
    assert(!env.Path.toLowerCase().split(";").includes(dir.toLowerCase()));
    assert(first.some((x) => x.level === "WROTE" && x.text.includes("PATH (User)")));
  });
  check("Windows uninstall chạy lại an toàn", () =>
    assert(second.some((x) => x.level === "ABSENT")));
}

function testWindowsRemovePathSyntax() {
  check("PowerShell script gỡ User PATH parse được", () => {
    if (process.platform !== "win32") return;
    const source = CLI.windowsRemovePathScript();
    const probe = path.join(sandbox, "path-probe-khong-ton-tai");
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", source], {
      encoding: "utf8",
      env: { ...process.env, ALP_BIN_DIR: probe },
    });
    assert.strictEqual(r.status, 0, (r.stdout || "") + (r.stderr || ""));
    assert.strictEqual((r.stdout || "").trim(), "absent");
  });
}

function testWindowsPathDetection() {
  const dir = path.join(sandbox, "CaseSensitive", "alp", "bin");
  const lower = dir.toLowerCase();
  check("Windows tách PATH bằng dấu chấm phẩy và không phân biệt hoa thường", () =>
    assert.strictEqual(CLI.onPath(dir, { Path: `C:\\Windows;${lower};C:\\Node` }, "win32"), true));
}

function testForeignWindowsCommand() {
  const localAppData = path.join(sandbox, "foreign-win-local");
  const target = path.join(localAppData, "alp", "bin", "alp.cmd");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "@echo off\r\necho mine\r\n");

  const log = CLI.installCli(repo, {
    env: { LOCALAPPDATA: localAppData, USERPROFILE: sandbox, Path: "C:\\Windows" },
    platform: "win32",
    applyWindowsPath() {
      throw new Error("không được gọi khi shim bị trùng");
    },
  });
  check("Windows không đè alp.cmd của người dùng", () => {
    assert.strictEqual(fs.readFileSync(target, "utf8"), "@echo off\r\necho mine\r\n");
    assert(log.some((x) => x.level === "SKIP"));
  });
}

function testForeignWindowsUninstall() {
  const localAppData = path.join(sandbox, "foreign-win-uninstall-local");
  const target = path.join(localAppData, "alp", "bin", "alp.cmd");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "@echo off\r\necho mine\r\n");

  let pathTouched = false;
  const log = CLI.uninstallCli(repo, {
    env: { LOCALAPPDATA: localAppData, USERPROFILE: sandbox, Path: "C:\\Windows" },
    platform: "win32",
    removeWindowsPath() {
      pathTouched = true;
      return "removed";
    },
  });
  check("Windows uninstall không gỡ lệnh alp hay PATH của người khác", () => {
    assert.strictEqual(fs.readFileSync(target, "utf8"), "@echo off\r\necho mine\r\n");
    assert.strictEqual(pathTouched, false);
    assert(log.some((x) => x.level === "KEEP"));
  });
}

/**
 * Bootstrap is exercised against a throwaway copy of the repository, never the working
 * one. `bootstrap.cjs` resolves its root from `__dirname`, not the caller's cwd, so
 * pointing `cwd` elsewhere does nothing — the copy's own script has to be the one spawned.
 * That matters because the first thing bootstrap does is `npm ci`, which deletes
 * `node_modules` before reinstalling: aimed at this repo, a failed reinstall leaves the
 * checkout without its dependencies.
 */
function copyRepositoryForBootstrap() {
  const source = path.resolve(__dirname, "..");
  const destination = path.join(sandbox, "bootstrap-repo");
  // Skipped: rebuilt by bootstrap (`node_modules`, `dist`), irrelevant to it (`.git`,
  // `.worktrees`), or machine state it must not inherit (`.alp`).
  const skipped = new Set(["node_modules", "dist", ".git", ".worktrees", ".alp"]);
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (from) => !skipped.has(path.basename(from)),
  });
  return destination;
}

function testBootstrapWiring() {
  const repoCopy = copyRepositoryForBootstrap();
  const home = path.join(sandbox, "bootstrap-home");
  const localAppData = path.join(home, "AppData", "Local");
  const delegationState = path.join(home, ".alp", "delegation", "test");
  const run = spawnSync(process.execPath, [path.join(repoCopy, "scripts", "bootstrap.cjs"), "--no-path"], {
    cwd: repoCopy,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: localAppData,
      SHELL: "/bin/zsh",
      PATH: process.env.PATH,
      npm_config_cache: path.join(os.homedir(), ".npm"),
      // Cache-first, but able to fetch what the cache lacks. Hard `offline` made the whole
      // step fail the moment one tarball was missing.
      npm_config_prefer_offline: "true",
      ALP_DELEGATION_STATE_DIR: delegationState,
    },
  });
  check("bootstrap clean-install chạy dependencies/build/registry/runtime/state/doctor/CLI", () => {
    assert.strictEqual(run.status, 0, (run.stdout || "") + (run.stderr || ""));
    assert.match(run.stdout, /AgentRegistry 8 agents; runtime adapters claude,codex/);
    assert.match(run.stdout, /BUILD-DRIFT\s+compiled artifacts match source hash/);
    assert(fs.existsSync(path.join(home, ".alp", "executions")));
    assert(fs.existsSync(delegationState));
  });
  check("bootstrap --no-path creates the shared CLI link without editing a shell profile", () => {
    const cli = path.join(repoCopy, "scripts", "alp.cjs");
    const command = process.platform === "win32"
      ? path.join(localAppData, "alp", "bin", "alp.cmd")
      : path.join(home, ".local", "bin", "alp");
    if (process.platform === "win32") assert(fs.readFileSync(command, "utf8").includes(cli));
    else assert.strictEqual(fs.realpathSync(command), cli);
    if (process.platform !== "win32") assert(!fs.existsSync(path.join(home, ".zshrc")));
    assert.match(run.stdout, /bỏ qua theo --no-path/);
  });
  check("bootstrap không compile/trust identity workspace", () => {
    assert(!fs.existsSync(path.join(home, ".claude.json")));
    assert(!fs.existsSync(path.join(home, ".codex")));
  });
  const deprecated = spawnSync(process.execPath, [path.join(repoCopy, "scripts", "bootstrap.cjs"), "--no-trust"], {
    cwd: repoCopy,
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home, ALP_DELEGATION_STATE_DIR: delegationState },
  });
  check("bootstrap rejects the removed --no-trust option", () => {
    assert.notStrictEqual(deprecated.status, 0);
    assert.match((deprecated.stdout || "") + (deprecated.stderr || ""), /tham số lạ: --no-trust/);
  });
}

function testDoctorAndInstallerWiring() {
  const home = path.join(sandbox, "doctor-home");
  const memoryRoot = path.join(sandbox, "doctor-read-only-memory");
  fs.mkdirSync(memoryRoot, { recursive: true, mode: 0o500 });
  fs.chmodSync(memoryRoot, 0o500);
  const checked = spawnSync(process.execPath, [path.join(__dirname, "doctor.cjs")], {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      ALP_MEMORY_ROOT: memoryRoot,
      ALP_DELEGATION_STATE_DIR: path.join(home, ".alp", "delegation", "test"),
    },
  });
  fs.chmodSync(memoryRoot, 0o700);
  check("doctor executes every code-native health check", () => {
    for (const tag of ["AGENT-REGISTRY", "RUNTIME-CLAUDE", "RUNTIME-CODEX", "MEMORY-ADAPTER", "EXECUTION-STATE", "BUILD-DRIFT"])
      assert.match(checked.stdout, new RegExp(tag), `thiếu kết quả hành vi ${tag}`);
  });
  check("doctor behavior reports an unwritable memory adapter", () => {
    if (process.platform === "win32") return;
    assert.strictEqual(checked.status, 1, (checked.stdout || "") + (checked.stderr || ""));
    assert.match(checked.stdout, /MEMORY-ADAPTER\s+(?:EACCES|EPERM):[^\n]*access/);
    assert.match(checked.stdout, /MEMORY-ADAPTER[^\n]*\n\s+→ fix: node scripts\/bootstrap\.cjs --no-path/);
  });

  const unix = fs.readFileSync(path.join(__dirname, "..", "install.sh"), "utf8");
  const windows = fs.readFileSync(path.join(__dirname, "..", "install.ps1"), "utf8");
  check("installers no longer expose trust/compile identity behavior", () => {
    for (const source of [unix, windows]) {
      assert(!source.includes("ALP_NO_TRUST"));
      assert(!source.includes("--no-trust"));
      assert(!source.includes("recompile"));
    }
  });
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

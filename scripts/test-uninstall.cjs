#!/usr/bin/env node
// test-uninstall.cjs — nghiệm thu gỡ toàn hệ trên fixture, không đụng bản cài thật.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const CLI = require("./lib/cli-link.cjs");
const U = require("./lib/uninstall.cjs");

const sandbox = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "alp-uninstall-"));
let failed = 0;
try {
  testKeepsMemoryAndCleansIntegration();
  testChannelAwareRemoval();
  testPurgeMemory();
  testRefusesCwdInsideRepo();
  testRefusesDirtyRepo();
  testDeletesOwnRunningRepo();
  testCliWiring();
  testMachineLocalProjectRegistry();
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

function testMachineLocalProjectRegistry() {
  const home = path.join(sandbox, "registry-home");
  const project = path.join(sandbox, "registered-project");
  fs.mkdirSync(path.join(home, ".alp"), { recursive: true });
  fs.writeFileSync(path.join(home, ".alp", "projects.json"), JSON.stringify({ version: 1, projects: [{ path: project, backend: null }] }));
  check("uninstall resolves projects from the supplied machine-local environment", () => {
    assert.deepStrictEqual(U.registeredProjects(sandbox, process.platform, { HOME: home }), [project]);
  });
}

if (failed) process.exit(1);
console.log("OK               uninstall: 8 nhóm ca đều xanh");

function testKeepsMemoryAndCleansIntegration() {
  const repo = makeRepo("keep-memory");
  const home = path.join(sandbox, "keep-home");
  const project = path.join(sandbox, "project");
  const localAppData = path.join(home, "local-app-data");
  const bin = path.join(localAppData, "alp", "bin");
  const env = { HOME: home, USERPROFILE: home, LOCALAPPDATA: localAppData, Path: `C:\\Windows;${bin}` };
  const state = path.join(home, ".alp");
  const memoryFile = path.join(state, "memory", "projects", "demo.md");
  fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
  fs.writeFileSync(memoryFile, "important memory\n");
  makeGeneratedProjectConfig(project);
  CLI.installCli(repo, { env, platform: "win32" });
  fs.mkdirSync(path.join(state, "executions", "exec_old"), { recursive: true });
  fs.writeFileSync(path.join(state, "install.json"), '{"root":"x"}\n');
  // `~/.alp` là nhà chung — những thứ dưới đây không phải của alp-code và phải sống sót.
  fs.mkdirSync(path.join(state, "memories"), { recursive: true });
  fs.writeFileSync(path.join(state, "SOUL.md"), "not ours\n");

  let removedPath = null;
  const result = U.uninstall(repo, {
    env,
    platform: "win32",
    cwd: sandbox,
    force: true,
    projectPaths: [project],
    now: new Date("2026-08-22T01:02:03.000Z"),
    removeWindowsPath(dir) {
      removedPath = dir;
      return "removed";
    },
  });

  check("uninstall xoá bản cài, CLI/PATH và config project", () => {
    assert(!fs.existsSync(repo));
    assert(!fs.existsSync(path.join(bin, "alp.cmd")));
    assert.strictEqual(removedPath, bin);
    assert(!fs.existsSync(path.join(project, ".claude", "settings.local.json")));
    assert(!fs.existsSync(path.join(project, ".codex", "config.toml")));
  });
  check("uninstall mặc định chuyển memory ra backup cạnh ~/.alp", () => {
    assert(result.memoryBackup);
    assert.strictEqual(fs.readFileSync(path.join(result.memoryBackup, "projects", "demo.md"), "utf8"), "important memory\n");
    assert.strictEqual(result.memoryBackup, `${state}.memory-backup-20260822T010203Z`);
    assert(!fs.existsSync(path.join(state, "memory")));
  });
  check("uninstall gỡ state của alp-code trong ~/.alp", () => {
    assert(!fs.existsSync(path.join(state, "executions")));
    assert(!fs.existsSync(path.join(state, "install.json")));
  });
  // Đây là ca hồi quy đắt nhất của file này: bản trước xoá thẳng cả `~/.alp`, và từ khi
  // memory dọn vào đó thì cách làm ấy đồng nghĩa với xoá dữ liệu người dùng.
  check("uninstall không đụng thứ của người khác trong ~/.alp", () => {
    assert.strictEqual(fs.readFileSync(path.join(state, "SOUL.md"), "utf8"), "not ours\n");
    assert(fs.existsSync(path.join(state, "memories")));
  });
  check("cleanup CLI chạy lại vẫn an toàn", () => {
    const again = CLI.uninstallCli(repo, {
      env,
      platform: "win32",
      removeWindowsPath() { return "absent"; },
    });
    assert(again.some((x) => x.level === "ABSENT"));
  });
}

/**
 * Mỗi channel được gỡ theo đúng cách của nó.
 *
 * Bản npm là ca dễ sai nhất: thư mục nằm trong `node_modules` của npm, và `rm -rf` nó sau lưng
 * npm để lại một entry ma khiến lần cài lại sau đó im lặng không làm gì.
 */
function testChannelAwareRemoval() {
  const npmRoot = path.join(sandbox, "npm-prefix", "lib", "node_modules", "alp-code");
  makeInstallAt(npmRoot);
  const npmHome = path.join(sandbox, "npm-home");
  const commands = [];
  const npmResult = U.uninstall(npmRoot, {
    env: { HOME: npmHome, USERPROFILE: npmHome },
    cwd: sandbox,
    force: true,
    projectPaths: [],
    runCommand(command, args) { commands.push([command, ...args].join(" ")); return { status: 0, error: null, stdout: "", stderr: "" }; },
  });
  check("bản npm được gỡ bằng npm uninstall -g, không rm -rf", () => {
    assert.strictEqual(npmResult.channel, "npm");
    assert.deepStrictEqual(commands, ["npm uninstall --global alp-code"]);
    assert(fs.existsSync(npmRoot), "uninstall không được tự xoá thư mục do npm sở hữu");
  });

  // npm hỏng giữa chừng: memory đã dời đi phải quay về, không để dữ liệu tách khỏi bản cài.
  const failHome = path.join(sandbox, "npm-fail-home");
  const failMemory = path.join(failHome, ".alp", "memory");
  fs.mkdirSync(failMemory, { recursive: true });
  fs.writeFileSync(path.join(failMemory, "fact.md"), "still here\n");
  check("npm uninstall thất bại thì memory quay về chỗ cũ", () => {
    assert.throws(() => U.uninstall(npmRoot, {
      env: { HOME: failHome, USERPROFILE: failHome },
      cwd: sandbox,
      force: true,
      projectPaths: [],
      runCommand() { return { status: 1, error: null, stdout: "", stderr: "EACCES" }; },
    }), /npm uninstall -g alp-code` thất bại/);
    assert.strictEqual(fs.readFileSync(path.join(failMemory, "fact.md"), "utf8"), "still here\n");
  });

  // Tarball: `current` và mọi version cùng đi, không chỉ version đang chạy.
  const tarballHome = path.join(sandbox, "tarball-home");
  const running = path.join(tarballHome, "versions", "v1.0.0");
  makeInstallAt(running);
  makeInstallAt(path.join(tarballHome, "versions", "v0.9.0"));
  fs.symlinkSync(running, path.join(tarballHome, "current"), process.platform === "win32" ? "junction" : "dir");
  const tarballHomeHome = path.join(sandbox, "tarball-user-home");
  const tarballResult = U.uninstall(running, {
    env: { HOME: tarballHomeHome, USERPROFILE: tarballHomeHome },
    cwd: sandbox,
    force: true,
    projectPaths: [],
  });
  check("bản tarball gỡ cả ~/.alp-code: versions/ lẫn current", () => {
    assert.strictEqual(tarballResult.channel, "tarball");
    assert(!fs.existsSync(tarballHome));
    assert.strictEqual(U.tarballHomeOf(running), tarballHome);
    assert.strictEqual(U.tarballHomeOf(path.join(tarballHome, "current")), tarballHome);
  });
}

function testPurgeMemory() {
  const repo = makeRepo("purge-memory");
  const home = path.join(sandbox, "purge-home");
  const memoryFile = path.join(home, ".alp", "memory", "private", "fact.md");
  fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
  fs.writeFileSync(memoryFile, "delete me\n");

  const result = U.uninstall(repo, {
    env: { HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, "local-app-data"), Path: "C:\\Windows" },
    platform: "win32",
    cwd: sandbox,
    force: true,
    purgeMemory: true,
    projectPaths: [],
    removeWindowsPath() { return "absent"; },
  });
  check("--purge-memory xoá memory cùng bản cài và không tạo backup", () => {
    assert(!fs.existsSync(repo));
    assert(!fs.existsSync(path.dirname(path.dirname(memoryFile))));
    assert.strictEqual(result.memoryBackup, null);
    assert(result.log.some((x) => x.level === "PURGED"));
  });
}

function testRefusesCwdInsideRepo() {
  const repo = makeRepo("cwd-guard");
  check("uninstall từ cwd bên trong repo bị chặn", () => {
    assert.throws(
      () => U.uninstall(repo, { cwd: path.join(repo, "scripts"), force: true, projectPaths: [] }),
      /cwd đang nằm trong/
    );
    assert(fs.existsSync(repo));
  });
}

function testRefusesDirtyRepo() {
  const repo = makeRepo("dirty-guard");
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "fixture"]);
  fs.appendFileSync(path.join(repo, "package.json"), "dirty\n");
  check("uninstall chặn repo còn thay đổi chưa commit", () => {
    assert.throws(() => U.assertGitSafe(repo), /còn thay đổi chưa commit/);
    assert(fs.existsSync(repo));
  });
}

function testDeletesOwnRunningRepo() {
  const sourceRoot = path.resolve(__dirname, "..");
  const repo = path.join(sandbox, "self-delete");
  fs.mkdirSync(repo, { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, "package.json"), path.join(repo, "package.json"));
  fs.cpSync(path.join(sourceRoot, "scripts"), path.join(repo, "scripts"), { recursive: true });
  const entry = path.join(repo, "dist", "src", "cli", "alp.js");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, [
    'const path = require("path");',
    "exports.main = async function (argv) {",
    '  if (argv[0] !== "uninstall") return 2;',
    '  const root = process.env.ALP_REPO_ROOT;',
    '  const U = require(path.join(root, "scripts", "lib", "uninstall.cjs"));',
    '  const result = U.uninstall(root, { cwd: process.cwd(), force: argv.includes("--force"), purgeMemory: argv.includes("--purge-memory") });',
    '  process.stdout.write(result.log.map((entry) => `${entry.level.padEnd(8)} ${entry.text}`).join("\\n") + "\\n");',
    "  return 0;",
    "};",
  ].join("\n"));
  const fakeHome = path.join(sandbox, "self-delete-home");
  const r = spawnSync(
    process.execPath,
    [path.join(repo, "scripts", "alp.cjs"), "uninstall", "--force", "--purge-memory"],
    {
      cwd: sandbox,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        LOCALAPPDATA: path.join(fakeHome, "AppData", "Local"),
        ALP_SKIP_UPDATE_CHECK: "1",
      },
    }
  );
  check("process alp thật tự xoá được repo đang chứa code của nó", () => {
    assert.strictEqual(r.status, 0, (r.stdout || "") + (r.stderr || ""));
    assert(!fs.existsSync(repo));
    assert((r.stdout || "").includes("REMOVED"));
  });
}

function testCliWiring() {
  const repoRoot = path.resolve(__dirname, "..");
  const r = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "alp.cjs"), "help"], {
    cwd: repoRoot,
    encoding: "utf8",
    // ALP_STATE_HOME: `alp.cjs` dựng state ở lần chạy đầu, và không ghim thì nó ghi đè
    // install record thật của máy đang chạy test — xem ghi chú trong test-delegation.cjs.
    env: { ...process.env, ALP_SKIP_UPDATE_CHECK: "1", ALP_STATE_HOME: path.join(sandbox, "cli-wiring-state") },
  });
  check("alp help công bố code-native maintenance commands", () => {
    assert.strictEqual(r.status, 0, (r.stdout || "") + (r.stderr || ""));
    assert((r.stdout || "").includes("alp update"));
    assert((r.stdout || "").includes("alp doctor"));
    assert((r.stdout || "").includes("alp uninstall"));
    assert((r.stdout || "").includes("--purge-memory"));
  });
  check("uninstall giữ memory trừ khi explicit purge", () => {
    const source = fs.readFileSync(path.join(__dirname, "lib", "uninstall.cjs"), "utf8");
    assert(source.includes("purgeMemory"));
    assert(source.includes("memoryBackup"));
  });
}

function makeRepo(name) {
  return makeInstallAt(path.join(sandbox, name));
}

function makeInstallAt(root) {
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), "{}\n");
  fs.writeFileSync(path.join(root, "scripts", "alp.cjs"), "// fixture\n");
  return root;
}

function makeGeneratedProjectConfig(project) {
  fs.mkdirSync(path.join(project, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(project, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(project, ".claude", "settings.local.json"), '{"$generatedBy":"alp init"}\n');
  fs.writeFileSync(path.join(project, ".codex", "config.toml"), "# GENERATED bởi `alp init`\n");
}

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error((r.stderr || "").trim() || `git ${args[0]} failed`);
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

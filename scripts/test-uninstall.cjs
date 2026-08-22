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
  testPurgeMemory();
  testRefusesCwdInsideRepo();
  testRefusesDirtyRepo();
  testDeletesOwnRunningRepo();
  testCliWiring();
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log("OK               uninstall: 6 nhóm ca đều xanh");

function testKeepsMemoryAndCleansIntegration() {
  const repo = makeRepo("keep-memory");
  const project = path.join(sandbox, "project");
  const localAppData = path.join(sandbox, "local-app-data-keep");
  const bin = path.join(localAppData, "alp", "bin");
  const env = { HOME: sandbox, USERPROFILE: sandbox, LOCALAPPDATA: localAppData, Path: `C:\\Windows;${bin}` };
  const memoryFile = path.join(repo, "memory", "projects", "demo.md");
  fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
  fs.writeFileSync(memoryFile, "important memory\n");
  makeGeneratedProjectConfig(project);
  CLI.installCli(repo, { env, platform: "win32" });

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

  check("uninstall xoá repo, CLI/PATH và config project", () => {
    assert(!fs.existsSync(repo));
    assert(!fs.existsSync(path.join(bin, "alp.cmd")));
    assert.strictEqual(removedPath, bin);
    assert(!fs.existsSync(path.join(project, ".claude", "settings.local.json")));
    assert(!fs.existsSync(path.join(project, ".codex", "config.toml")));
  });
  check("uninstall mặc định chuyển memory ra backup", () => {
    assert(result.memoryBackup);
    assert.strictEqual(fs.readFileSync(path.join(result.memoryBackup, "projects", "demo.md"), "utf8"), "important memory\n");
    assert(result.memoryBackup.endsWith(".memory-backup-20260822T010203Z"));
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

function testPurgeMemory() {
  const repo = makeRepo("purge-memory");
  const memoryFile = path.join(repo, "memory", "private", "fact.md");
  fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
  fs.writeFileSync(memoryFile, "delete me\n");

  const result = U.uninstall(repo, {
    env: { HOME: sandbox, USERPROFILE: sandbox, LOCALAPPDATA: path.join(sandbox, "local-app-data-purge"), Path: "C:\\Windows" },
    platform: "win32",
    cwd: sandbox,
    force: true,
    purgeMemory: true,
    projectPaths: [],
    removeWindowsPath() { return "absent"; },
  });
  check("--purge-memory xoá memory cùng repo và không tạo backup", () => {
    assert(!fs.existsSync(repo));
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
  fs.appendFileSync(path.join(repo, "CHARTER.md"), "dirty\n");
  check("uninstall chặn repo còn thay đổi chưa commit", () => {
    assert.throws(() => U.assertGitSafe(repo), /còn thay đổi chưa commit/);
    assert(fs.existsSync(repo));
  });
}

function testDeletesOwnRunningRepo() {
  const sourceRoot = path.resolve(__dirname, "..");
  const repo = path.join(sandbox, "self-delete");
  fs.mkdirSync(repo, { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, "CHARTER.md"), path.join(repo, "CHARTER.md"));
  fs.cpSync(path.join(sourceRoot, "scripts"), path.join(repo, "scripts"), { recursive: true });
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
      },
    }
  );
  check("process alp thật tự xoá được repo đang chứa code của nó", () => {
    assert.strictEqual(r.status, 0, (r.stdout || "") + (r.stderr || ""));
    assert(!fs.existsSync(repo));
    assert((r.stdout || "").includes("REMOVED  alp-code"));
  });
}

function testCliWiring() {
  const repoRoot = path.resolve(__dirname, "..");
  const r = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "alp.cjs"), "help"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  check("alp help công bố uninstall và cờ purge", () => {
    assert.strictEqual(r.status, 0, (r.stdout || "") + (r.stderr || ""));
    assert((r.stdout || "").includes("alp uninstall"));
    assert((r.stdout || "").includes("--purge-memory"));
  });
}

function makeRepo(name) {
  const repo = path.join(sandbox, name);
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(repo, "CHARTER.md"), "# fixture\n");
  fs.writeFileSync(path.join(repo, "scripts", "alp.cjs"), "// fixture\n");
  return repo;
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

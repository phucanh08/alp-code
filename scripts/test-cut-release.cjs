#!/usr/bin/env node
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const script = path.join(__dirname, "cut-release.cjs");
const sandbox = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "alp-cut-release-"));
const SLUG = "https://github.com/phucanh08/alp-code";

let failed = 0;
try {
  testBumpsAndTags();
  testRejectsEmptyUnreleased();
  testRejectsExistingTag();
  testDryRunTouchesNothing();
  testRejectsDirtyTree();
  if (failed) process.exitCode = 1;
  else console.log("OK               cut-release: bump/changelog/commit/tag + các cổng chặn");
} finally { fs.rmSync(sandbox, { recursive: true, force: true }); }

function testBumpsAndTags() {
  const repo = makeRepo("bump", "0.1.0", ["### Thêm", "", "- `alp --version`"]);
  const run = cutRelease(repo, ["minor"]);
  check("minor bump chạy xanh", () => assert.strictEqual(run.status, 0, run.stderr || run.stdout));
  check("package.json lên 0.2.0 và giữ nguyên format", () => {
    const text = fs.readFileSync(path.join(repo, "package.json"), "utf8");
    assert.strictEqual(JSON.parse(text).version, "0.2.0");
    assert(text.startsWith('{\n  "name"'), "không được stringify lại cả file");
  });
  check("package-lock.json bump theo, không đụng version của dependency", () => {
    const lock = JSON.parse(fs.readFileSync(path.join(repo, "package-lock.json"), "utf8"));
    assert.strictEqual(lock.version, "0.2.0");
    assert.strictEqual(lock.packages[""].version, "0.2.0");
    assert.strictEqual(lock.packages["node_modules/zod"].version, "0.1.0", "dep trùng version cũ phải giữ nguyên");
  });
  check("CHANGELOG mở mục rỗng mới và đóng mục cũ theo ngày", () => {
    const text = fs.readFileSync(path.join(repo, "CHANGELOG.md"), "utf8");
    const today = new Date().toISOString().slice(0, 10);
    assert(text.includes(`## [0.2.0] - ${today}`), text);
    assert(text.includes("- `alp --version`"), "nội dung cũ phải theo sang mục đã phát hành");
    assert.match(text, /## \[Chưa phát hành\]\n\n## \[0\.2\.0\]/, "mục Chưa phát hành mới phải rỗng");
  });
  check("link compare được nối đúng chuỗi version", () => {
    const text = fs.readFileSync(path.join(repo, "CHANGELOG.md"), "utf8");
    assert(text.includes(`[Chưa phát hành]: ${SLUG}/compare/v0.2.0...HEAD`), text);
    assert(text.includes(`[0.2.0]: ${SLUG}/compare/v0.1.0...v0.2.0`), text);
    assert(text.includes(`[0.1.0]: ${SLUG}/releases/tag/v0.1.0`), "link cũ phải còn nguyên");
  });
  check("tạo commit và tag nhưng KHÔNG push", () => {
    assert.strictEqual(git(repo, ["tag", "-l"]).trim(), "v0.2.0");
    assert.match(git(repo, ["log", "-1", "--pretty=%s"]).trim(), /^chore\(release\): v0\.2\.0$/);
    assert.strictEqual(git(repo, ["status", "--porcelain"]).trim(), "");
    assert(run.stdout.includes("Chưa push"), run.stdout);
  });
}

function testRejectsEmptyUnreleased() {
  const repo = makeRepo("empty", "0.1.0", []);
  const run = cutRelease(repo, ["patch"]);
  check("mục Chưa phát hành rỗng bị chặn", () => {
    assert.strictEqual(run.status, 1);
    assert.match(run.stderr, /rỗng/);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version, "0.1.0");
  });
  const forced = cutRelease(repo, ["patch", "--allow-empty"]);
  check("--allow-empty mở khoá đúng trường hợp đó", () => {
    assert.strictEqual(forced.status, 0, forced.stderr || forced.stdout);
    assert.strictEqual(git(repo, ["tag", "-l"]).trim(), "v0.1.1");
  });
}

function testRejectsExistingTag() {
  const repo = makeRepo("existing-tag", "0.1.0", ["- thay đổi"]);
  git(repo, ["tag", "v0.1.1"]);
  const run = cutRelease(repo, ["patch"]);
  check("tag đã tồn tại thì dừng, không ghi đè", () => {
    assert.strictEqual(run.status, 1);
    assert.match(run.stderr, /đã tồn tại/);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version, "0.1.0");
  });
}

function testDryRunTouchesNothing() {
  const repo = makeRepo("dry-run", "0.1.0", ["- thay đổi"]);
  const before = fs.readFileSync(path.join(repo, "CHANGELOG.md"), "utf8");
  const run = cutRelease(repo, ["major", "--dry-run"]);
  check("--dry-run báo cáo nhưng không ghi file/tag", () => {
    assert.strictEqual(run.status, 0, run.stderr || run.stdout);
    assert(run.stdout.includes("0.1.0 → 1.0.0"), run.stdout);
    assert.strictEqual(fs.readFileSync(path.join(repo, "CHANGELOG.md"), "utf8"), before);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version, "0.1.0");
    assert.strictEqual(git(repo, ["tag", "-l"]).trim(), "");
  });
}

function testRejectsDirtyTree() {
  const repo = makeRepo("dirty", "0.1.0", ["- thay đổi"]);
  fs.writeFileSync(path.join(repo, "src.txt"), "đang dở việc\n");
  git(repo, ["add", "src.txt"]);
  const run = cutRelease(repo, ["patch"]);
  check("tree bẩn thì không cắt release", () => {
    assert.strictEqual(run.status, 1);
    assert.match(run.stderr, /staged changes/);
    assert.strictEqual(git(repo, ["tag", "-l"]).trim(), "");
  });
}

function makeRepo(name, version, unreleased) {
  const repo = path.join(sandbox, name);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "package.json"), `{\n  "name": "alp-code",\n  "version": "${version}",\n  "private": true\n}\n`);
  // Dependency cố ý mang đúng version cũ: chứng minh script không sửa nhầm bằng regex.
  fs.writeFileSync(path.join(repo, "package-lock.json"), `${JSON.stringify({
    name: "alp-code",
    version,
    lockfileVersion: 3,
    packages: {
      "": { name: "alp-code", version, dependencies: { zod: "^4.0.0" } },
      "node_modules/zod": { version, resolved: "https://registry.npmjs.org/zod/-/zod-0.1.0.tgz" },
    },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(repo, "CHANGELOG.md"), [
    "# Changelog", "",
    "## [Chưa phát hành]", "",
    ...(unreleased.length ? [...unreleased, ""] : []),
    `## [${version}] - 2026-08-27`, "",
    "- bản đầu", "",
    `[Chưa phát hành]: ${SLUG}/compare/v${version}...HEAD`,
    `[${version}]: ${SLUG}/releases/tag/v${version}`, "",
  ].join("\n"));
  git(repo, ["init", "-q"]);
  git(repo, ["branch", "-M", "main"]);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=ALP Test", "-c", "user.email=test@alp.local", "commit", "-qm", "seed"]);
  return repo;
}

function cutRelease(repo, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ALP_REPO_ROOT: repo, GIT_AUTHOR_NAME: "ALP Test", GIT_AUTHOR_EMAIL: "test@alp.local", GIT_COMMITTER_NAME: "ALP Test", GIT_COMMITTER_EMAIL: "test@alp.local" },
  });
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function check(label, assertion) {
  try { assertion(); console.log(`PASS             ${label}`); }
  catch (error) { failed += 1; console.log(`FAIL             ${label}\n                 ${error.message}`); }
}

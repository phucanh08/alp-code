#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const L = require("./lib/loadout.cjs");
const { pullPreservingWorkspaces } = require("./lib/update.cjs");

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "alp-update-"));
const remote = path.join(root, "remote.git");
const seed = path.join(root, "seed");
const local = path.join(root, "local");
const upstream = path.join(root, "upstream");
const project = path.join(root, "project-local");

let failed = 0;
try {
  setup();
  testFastForwardPreservesWorkspace();
  testUnrelatedEditStopsBeforeStash();
  testFailedPullRestoresWorkspace();
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log("OK               alp update preserves machine-local workspaces safely");

function setup() {
  git(root, ["init", "--bare", "-q", remote]);
  fs.mkdirSync(seed);
  git(seed, ["init", "-q"]);
  git(seed, ["branch", "-M", "main"]);
  fs.mkdirSync(path.join(seed, "identity", "main"), { recursive: true });
  fs.writeFileSync(path.join(seed, "identity", "main", "loadout.yaml"), loadout("old-skill"));
  fs.writeFileSync(path.join(seed, "README.md"), "# test\n");
  commitAll(seed, "initial");
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "-q", "-u", "origin", "main"]);
  git(root, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  git(root, ["clone", "-q", remote, local]);
  git(root, ["clone", "-q", remote, upstream]);
  fs.mkdirSync(project);
}

function testFastForwardPreservesWorkspace() {
  L.writeWorkspaces(local, "main", [project], [project]);
  const upstreamLoadout = path.join(upstream, "identity", "main", "loadout.yaml");
  fs.writeFileSync(upstreamLoadout, fs.readFileSync(upstreamLoadout, "utf8").replace("old-skill", "new-skill"));
  commitAll(upstream, "upstream changes same loadout");
  git(upstream, ["push", "-q"]);

  const result = update(local);
  check("upstream sửa cùng loadout vẫn fast-forward", () => {
    assert.strictEqual(result.ok, true, result.message);
    assert.strictEqual(head(local), head(upstream));
    assert.match(fs.readFileSync(upstreamLoadout.replace(upstream, local), "utf8"), /skills: \[new-skill\]/);
  });
  check("workspace local được áp lại sau pull", () => {
    const workspace = L.effectiveWorkspaces(L.loadLoadout(local, "main"));
    assert.deepStrictEqual(workspace.read, [project]);
    assert.deepStrictEqual(workspace.write, [project]);
    assert.match(status(local), /^M identity\/main\/loadout\.yaml$/);
    assert.strictEqual(stashes(local), "");
  });
}

function testUnrelatedEditStopsBeforeStash() {
  const readme = path.join(local, "README.md");
  const before = fs.readFileSync(readme, "utf8");
  fs.writeFileSync(readme, before + "local source edit\n");
  const result = update(local);
  check("source edit khác vẫn chặn update", () => {
    assert.strictEqual(result.ok, false);
    assert.match(result.message, /ngoài workspace config: README\.md/);
    assert.match(fs.readFileSync(readme, "utf8"), /local source edit/);
    assert.strictEqual(stashes(local), "");
  });
  fs.writeFileSync(readme, before);
}

function testFailedPullRestoresWorkspace() {
  fs.writeFileSync(path.join(local, "LOCAL.md"), "local commit\n");
  git(local, ["add", "LOCAL.md"]);
  commit(local, "local divergence");

  fs.writeFileSync(path.join(upstream, "REMOTE.md"), "remote commit\n");
  commitAll(upstream, "remote divergence");
  git(upstream, ["push", "-q"]);

  const beforeHead = head(local);
  const result = update(local);
  check("pull không fast-forward → trả workspace về nguyên trạng", () => {
    assert.strictEqual(result.ok, false);
    assert.match(result.message, /workspace local đã được khôi phục/);
    assert.strictEqual(head(local), beforeHead);
    const workspace = L.effectiveWorkspaces(L.loadLoadout(local, "main"));
    assert.deepStrictEqual(workspace.write, [project]);
    assert.strictEqual(stashes(local), "");
  });
}

function update(repo) {
  return pullPreservingWorkspaces(repo, {
    stdio: ["ignore", "pipe", "pipe"],
    log() {},
  });
}

function loadout(skill) {
  return [
    "role: main",
    "name: Test",
    "memory:",
    "  read:  [shared/**]",
    "  write: [shared/**]",
    "workspaces:",
    "  read:  []",
    "  write: []",
    `skills: [${skill}]`,
    "",
  ].join("\n");
}

function commitAll(repo, message) {
  git(repo, ["add", "-A"]);
  commit(repo, message);
}

function commit(repo, message) {
  git(repo, ["-c", "user.name=ALP Test", "-c", "user.email=test@alp.local", "commit", "-qm", message]);
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function head(repo) { return git(repo, ["rev-parse", "HEAD"]); }
function status(repo) { return git(repo, ["status", "--short"]); }
function stashes(repo) { return git(repo, ["stash", "list", "--format=%s"]); }

function check(name, fn) {
  try {
    fn();
    console.log(`PASS             ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL             ${name}\n                 ${error.message.split("\n").join("\n                 ")}`);
  }
}

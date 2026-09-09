#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const targets = require("./lib/binary-targets.cjs");

if (process.platform === "win32") {
  console.log("SKIP             migration fixture currently uses POSIX symlinks; Windows matrix runs installer migration separately");
  process.exit(0);
}

const repoRoot = path.resolve(__dirname, "..");
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "alp-native-migration-"));
try {
  const version = require("../package.json").version;
  const target = targets.hostTarget();
  const out = path.join(root, "out");
  ok(spawnSync(process.execPath, [path.join(__dirname, "build-binary.cjs"), "--target", target.id, "--out", out], {
    cwd: repoRoot, encoding: "utf8", env: { ...process.env, ALP_SKIP_GIT_CHECK: "1" },
  }));
  const installHome = path.join(root, "install");
  const versionRoot = path.join(installHome, "versions", `v${version}`);
  fs.mkdirSync(versionRoot, { recursive: true });
  ok(spawnSync("tar", ["-xzf", path.join(out, targets.archiveName(version, target.id)), "-C", versionRoot], { encoding: "utf8" }));
  fs.symlinkSync(path.join("versions", `v${version}`), path.join(installHome, "current"));
  fs.mkdirSync(path.join(installHome, "bin"));
  fs.symlinkSync(path.join("..", "current", "bin", "alp"), path.join(installHome, "bin", "alp"));

  const state = path.join(root, "state");
  const project = path.join(root, "project");
  fs.mkdirSync(path.join(state, "memory"), { recursive: true });
  fs.mkdirSync(path.join(project, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(state, "memory", "user.md"), "principal memory\n");
  fs.writeFileSync(path.join(state, "mode.json"), '{"mode":"high"}\n');
  fs.writeFileSync(path.join(state, "install.json"), JSON.stringify({ root: "/old/npm/alp-code", version: "0.9.0", channel: "npm", assetRoot: "/old/npm/alp-code" }));
  fs.writeFileSync(path.join(state, "projects.json"), JSON.stringify({ version: 1, projects: [{ path: project }] }));
  const settings = path.join(project, ".claude", "settings.local.json");
  fs.writeFileSync(settings, `${JSON.stringify({
    $generatedBy: "alp init", custom: { keep: true },
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: 'node "/old/npm/alp-code/hooks/session-boot.cjs"' }] }] },
  }, null, 2)}\n`);
  const beforeMemory = digest(path.join(state, "memory", "user.md"));
  const beforeMode = digest(path.join(state, "mode.json"));
  const executable = path.join(versionRoot, "bin", "alp");
  const env = { HOME: path.join(root, "user"), ALP_STATE_HOME: state, PATH: "/usr/bin:/bin", ALP_SKIP_UPDATE_CHECK: "1" };
  ok(spawnSync(executable, ["__internal", "ensure-state"], { encoding: "utf8", cwd: root, env }));
  const once = fs.readFileSync(settings, "utf8");
  ok(spawnSync(executable, ["__internal", "ensure-state"], { encoding: "utf8", cwd: root, env }));
  assert.equal(fs.readFileSync(settings, "utf8"), once, "migration is not idempotent");
  assert.equal(digest(path.join(state, "memory", "user.md")), beforeMemory);
  assert.equal(digest(path.join(state, "mode.json")), beforeMode);
  const migrated = JSON.parse(once);
  assert.equal(migrated.custom.keep, true);
  assert.match(migrated.hooks.SessionStart[0].hooks[0].command, /hook.*session-boot/);
  console.log("PASS             v0.9 state/project hook migration is idempotent and preserves user state");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function digest(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function ok(result) { assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message); }

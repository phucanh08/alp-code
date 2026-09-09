#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const targets = require("./lib/binary-targets.cjs");

const repoRoot = path.resolve(__dirname, "..");
const version = require("../package.json").version;
const target = targets.hostTarget();
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "alp-native-blackbox-"));
try {
  const artifacts = path.join(root, "artifacts");
  run(process.execPath, [path.join(__dirname, "build-binary.cjs"), "--target", target.id, "--out", artifacts], {
    cwd: repoRoot, env: { ...process.env, ALP_SKIP_GIT_CHECK: "1" },
  });
  const installHome = path.join(root, "install");
  const versionRoot = path.join(installHome, "versions", `v${version}`);
  fs.mkdirSync(versionRoot, { recursive: true });
  run("tar", ["-xzf", path.join(artifacts, targets.archiveName(version, target.id)), "-C", versionRoot]);
  fs.symlinkSync(versionRoot, path.join(installHome, "current"), process.platform === "win32" ? "junction" : "dir");
  if (process.platform !== "win32") {
    fs.mkdirSync(path.join(installHome, "bin"));
    fs.symlinkSync(path.join("..", "current", "bin", "alp"), path.join(installHome, "bin", "alp"));
  }
  const executable = path.join(versionRoot, "bin", target.executable);
  const state = path.join(root, "state");
  const env = {
    HOME: path.join(root, "user"),
    ALP_STATE_HOME: state,
    ALP_SKIP_UPDATE_CHECK: "1",
    PATH: process.platform === "win32" ? (process.env.SystemRoot || "C:\\Windows") + "\\System32" : "/usr/bin:/bin",
  };

  const versionResult = run(executable, ["--version"], { cwd: root, env, capture: true });
  assert.equal(versionResult.stdout, `alp ${version}\n`);
  assert.equal(fs.existsSync(state), false, "--version must not initialize state");

  run(executable, ["__internal", "ensure-state"], { cwd: root, env });
  assert(fs.existsSync(path.join(state, "install.json")));
  const help = run(executable, ["help"], { cwd: root, env, capture: true });
  assert.match(help.stdout, /code-native agent launcher/);
  const hook = run(executable, ["hook", "session-boot"], { cwd: root, env, capture: true });
  assert.equal(JSON.parse(hook.stdout).hookSpecificOutput.hookEventName, "SessionStart");
  const doctor = run(executable, ["doctor"], { cwd: root, env, capture: true, expectedStatus: 1 });
  assert.match(doctor.stdout, /RUNTIME-CLAUDE/);
  assert.match(doctor.stdout, /RUNTIME-CODEX/);
  console.log(`PASS             native ${target.id}: version/state/help/hook/doctor without Node on PATH`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, options.expectedStatus ?? 0, `${command} ${args.join(" ")}\n${result.stdout || ""}\n${result.stderr || result.error?.message || ""}`);
  return result;
}

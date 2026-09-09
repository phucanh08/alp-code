#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const targets = require("./lib/binary-targets.cjs");

const repoRoot = path.resolve(__dirname, "..");
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "alp-native-perf-"));
try {
  const target = targets.hostTarget();
  const version = require("../package.json").version;
  const out = path.join(root, "out");
  const built = spawnSync(process.execPath, [path.join(__dirname, "build-binary.cjs"), "--target", target.id, "--out", out], {
    cwd: repoRoot, encoding: "utf8", env: { ...process.env, ALP_SKIP_GIT_CHECK: "1" },
  });
  assert.equal(built.status, 0, built.stderr || built.stdout);
  const extracted = path.join(root, "payload");
  fs.mkdirSync(extracted);
  const unpacked = spawnSync("tar", ["-xzf", path.join(out, targets.archiveName(version, target.id)), "-C", extracted], { encoding: "utf8" });
  assert.equal(unpacked.status, 0, unpacked.stderr);
  const executable = path.join(extracted, "bin", target.executable);
  const state = path.join(root, "state");
  const env = { HOME: path.join(root, "user"), ALP_STATE_HOME: state, PATH: "/usr/bin:/bin" };
  const samples = [];
  for (let index = 0; index < 35; index += 1) {
    const started = process.hrtime.bigint();
    const result = spawnSync(executable, ["--version"], { encoding: "utf8", env });
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `alp ${version}\n`);
    if (index >= 5) samples.push(elapsed);
  }
  samples.sort((a, b) => a - b);
  const percentile = (p) => samples[Math.ceil(samples.length * p) - 1];
  const p50 = percentile(0.5);
  const p95 = percentile(0.95);
  assert(p95 < 40, `alp --version p95 ${p95.toFixed(2)} ms exceeds 40 ms`);
  assert.equal(fs.existsSync(state), false, "performance path mutated state");
  console.log(`PASS             --version ${target.id} p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms n=${samples.length} (${os.cpus()[0]?.model || "unknown CPU"})`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

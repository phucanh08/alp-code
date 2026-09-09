#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "alp-bun-compat-test-"));

try {
  const isolatedEnv = {
    ...process.env,
    HOME: sandbox,
    USERPROFILE: sandbox,
    ALP_STATE_HOME: path.join(sandbox, "state"),
  };
  const help = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "spike-bun-compat.cjs"), "--help"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: isolatedEnv,
  });
  assert.equal(help.status, 0, help.stderr || help.stdout);
  assert.match(help.stdout, /^Usage:/);

  const wrongVersion = spawnSync(
    process.execPath,
    [path.join(repoRoot, "scripts", "spike-bun-compat.cjs"), "--json", "--out", path.join(sandbox, "wrong")],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...isolatedEnv, BUN_BINARY: process.execPath },
    },
  );
  assert.notEqual(wrongVersion.status, 0, "probe must reject a compiler with the wrong version");
  assert.match(wrongVersion.stderr, /Bun version mismatch: expected 1\.4\.2/);

  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, "scripts", "spike-bun-compat.cjs"), "--json", "--out", path.join(sandbox, "build")],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: isolatedEnv,
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);

  assert.equal(report.compiler.expectedVersion, "1.4.2");
  assert.equal(report.compiler.actualVersion, report.compiler.expectedVersion);
  assert.match(report.compiler.revision, /^1\.4\.2\+/);
  assert.equal(report.compile.ok, true);
  assert.equal(typeof report.host.filesystemType, "number");

  for (const name of ["spawnSync", "spawn", "execFile", "stdin", "stdioInherit", "detached", "sigint", "sigterm"])
    assert.equal(report.process[name].ok, true, `${name}: ${JSON.stringify(report.process[name])}`);
  assert.equal(report.process.spawnSync.explicitExitCode, 23);

  for (const name of ["atomicRename", "privateModes", "symlinkReplace", "symlinkInvocation", "runningExecutable"])
    assert.equal(report.filesystem[name].ok, true, `${name}: ${JSON.stringify(report.filesystem[name])}`);

  assert.equal(fs.existsSync(path.join(sandbox, ".alp")), false, "probe must not touch real/default ALP state");
  console.log("PASS bun compatibility probe harness");
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

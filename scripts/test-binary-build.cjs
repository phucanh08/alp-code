#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const targets = require("./lib/binary-targets.cjs");
const manifest = require("./lib/release-manifest.cjs");

assert.deepEqual(targets.TARGETS.map((target) => target.id), [
  "darwin-arm64", "darwin-x64", "linux-x64-gnu", "linux-arm64-gnu", "windows-x64",
]);
assert.equal(targets.resolveTarget("darwin", "arm64").id, "darwin-arm64");
assert.equal(targets.resolveTarget("linux", "x64", "glibc").id, "linux-x64-gnu");
assert.equal(targets.resolveTarget("win32", "x64").id, "windows-x64");
assert.throws(() => targets.resolveTarget("linux", "x64", "musl"), /unsupported/);
assert.throws(() => targets.resolveTarget("win32", "arm64"), /unsupported/);
assert.equal(targets.archiveName("0.10.0", "windows-x64"), "alp-code-v0.10.0-windows-x64.tar.gz");

const document = manifest.createInstallManifest({ version: "0.10.0", target: "darwin-arm64", compilerVersion: "1.4.2" });
assert.deepEqual(manifest.validateInstallManifest(document, { version: "0.10.0", target: "darwin-arm64" }), document);
assert.throws(() => manifest.validateInstallManifest({ ...document, target: "darwin-x64" }, { target: "darwin-arm64" }), /target/);
assert.throws(() => manifest.validateArchiveEntries(["bin/alp", "../escape"]), /unsafe archive entry/);
assert.throws(() => manifest.validateArchiveEntries(["/absolute", "skills/x"]), /unsafe archive entry/);
manifest.validateArchiveEntries(["bin/alp", "skills/search/SKILL.md", "scaffold/memory/INDEX.md"]);

if (process.argv.includes("--contracts-only")) {
  console.log("PASS binary build contracts");
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alp-binary-build-test-"));
try {
  const result = spawnSync(process.execPath, [path.join(__dirname, "build-binary.cjs"), "--target", targets.hostTarget().id, "--out", root], {
    cwd: path.resolve(__dirname, ".."), encoding: "utf8", env: { ...process.env, ALP_SKIP_GIT_CHECK: "1" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const archive = path.join(root, targets.archiveName(require("../package.json").version, targets.hostTarget().id));
  assert.equal(fs.existsSync(archive), true);
  const listed = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  const entries = listed.stdout.trim().split("\n").map((entry) => entry.replace(/^\.\//, "").replace(/\/$/, ""));
  for (const required of ["bin/alp", "skills", "scaffold", "LICENSE", "install-manifest.json"])
    assert.equal(entries.some((entry) => entry === required || entry.startsWith(`${required}/`)), true, `missing ${required}`);
  manifest.validateArchiveEntries(entries);

  const checksums = fs.readFileSync(path.join(root, "SHA256SUMS"), "utf8").trim().split(/\s+/);
  assert.equal(checksums[1], path.basename(archive));
  assert.equal(checksums[0], crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex"));
  const repeated = path.join(root, "repeated");
  const rebuilt = spawnSync(process.execPath, [path.join(__dirname, "build-binary.cjs"), "--target", targets.hostTarget().id, "--out", repeated], {
    cwd: path.resolve(__dirname, ".."), encoding: "utf8", env: { ...process.env, ALP_SKIP_GIT_CHECK: "1" },
  });
  assert.equal(rebuilt.status, 0, rebuilt.stderr || rebuilt.stdout);
  assert.equal(
    crypto.createHash("sha256").update(fs.readFileSync(path.join(repeated, path.basename(archive)))).digest("hex"),
    checksums[0],
    "same source/compiler/target must produce a byte-identical archive",
  );
  console.log("PASS binary build host archive");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

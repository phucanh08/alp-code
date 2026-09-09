#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { NPM_WRAPPER_REQUIRED, NPM_WRAPPER_FORBIDDEN } = require("./lib/release-manifest.cjs");

const repoRoot = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "alp-pack-wrapper-"));
try {
  const packed = spawnSync(process.execPath, [path.join(__dirname, "pack-release.cjs"), "--npm-only", "--out", out], {
    cwd: repoRoot, encoding: "utf8",
  });
  assert.equal(packed.status, 0, `${packed.stdout}\n${packed.stderr}`);
  const tarball = fs.readdirSync(out).find((name) => name.endsWith(".tgz"));
  assert(tarball, "npm wrapper tarball missing");
  const entries = execFileSync("tar", ["-tzf", path.join(out, tarball)], { encoding: "utf8" })
    .split(/\r?\n/).filter(Boolean).map((entry) => entry.replace(/^package\//, "").replace(/\/$/, ""));
  for (const required of NPM_WRAPPER_REQUIRED) assert(entries.includes(required), `missing ${required}`);
  assert.deepEqual(entries.filter((entry) => NPM_WRAPPER_FORBIDDEN.some((pattern) => pattern.test(entry))), []);
  const staging = path.join(out, "unpacked");
  fs.mkdirSync(staging);
  execFileSync("tar", ["-xzf", path.join(out, tarball), "-C", staging]);
  const packageDocument = JSON.parse(fs.readFileSync(path.join(staging, "package", "package.json"), "utf8"));
  const rootPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageDocument.version, rootPackage.version);
  assert.equal(packageDocument.bin.alp, "bin/alp.cjs");
  assert.notEqual(packageDocument.private, true, "packed wrapper must be publishable");
  assert.equal(rootPackage.private, true, "development root must not be publishable by mistake");
  console.log("PASS             release pack is exact-version wrapper only");
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}

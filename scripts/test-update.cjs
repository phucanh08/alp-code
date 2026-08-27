#!/usr/bin/env node
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { preserveMaintenanceState, checkoutLatestRelease, updateInstallation } = require("./lib/update.cjs");

const fakeResolve = async () => ({ ok: true, tag: "v1.0.0", source: "test" });

(async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "alp-update-"));
  try {
    const remote = path.join(root, "remote.git");
    const seed = path.join(root, "seed");
    const local = path.join(root, "local");
    fs.mkdirSync(seed);
    git(root, ["init", "--bare", "-q", remote]);
    git(seed, ["init", "-q"]); git(seed, ["branch", "-M", "main"]);
    fs.writeFileSync(path.join(seed, "package.json"), '{"version":"1.0.0"}\n');
    commit(seed, "initial");
    git(seed, ["remote", "add", "origin", remote]);
    git(seed, ["push", "-q", "-u", "origin", "main"]);
    git(seed, ["tag", "v1.0.0"]);
    git(seed, ["push", "-q", "origin", "--tags"]);
    git(root, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
    git(root, ["clone", "-q", remote, local]);

    const checkedOut = await checkoutLatestRelease(local, { stdio: ["ignore", "pipe", "pipe"], resolveLatestReleaseTag: fakeResolve });
    assert.strictEqual(checkedOut.ok, true, checkedOut.message);
    assert.strictEqual(checkedOut.tag, "v1.0.0");

    fs.writeFileSync(path.join(local, "package.json"), '{"dirty":true}\n');
    const dirty = await checkoutLatestRelease(local, { stdio: ["ignore", "pipe", "pipe"], resolveLatestReleaseTag: fakeResolve });
    assert.match(dirty.message, /tracked changes/);
    git(local, ["checkout", "--", "package.json"]);

    const home = path.join(root, "home");
    const maintenance = path.join(root, "maintenance");
    fs.mkdirSync(path.join(maintenance, "memory"), { recursive: true });
    fs.writeFileSync(path.join(maintenance, "memory", "keep.md"), "memory\n");
    for (const [relative, body] of [["runtime.json", "codex\n"], ["projects.json", '{"version":1,"projects":[]}\n'], [path.join("delegation", "x", "backend"), "paseo\n"]]) {
      const file = path.join(home, ".alp", relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body);
    }
    const protectedPaths = preserveMaintenanceState(maintenance, { env: { HOME: home } }).map((entry) => entry.file);
    assert(protectedPaths.some((file) => file.endsWith("projects.json")));
    const result = await updateInstallation(local, {
      env: { ...process.env, HOME: home }, stdio: ["ignore", "pipe", "pipe"],
      resolveLatestReleaseTag: fakeResolve,
      spawnProcess() { return { status: 0, error: null, stdout: "", stderr: "" }; },
    });
    assert.strictEqual(result.ok, true, result.message);
    console.log("OK               alp update preserves code-native machine-local state");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });

function git(cwd, args) { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function commit(repo, message) { git(repo, ["add", "-A"]); git(repo, ["-c", "user.name=ALP Test", "-c", "user.email=test@alp.local", "commit", "-qm", message]); }

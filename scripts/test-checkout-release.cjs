#!/usr/bin/env node
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { resolveLatestReleaseTag, checkoutLatestRelease } = require("./lib/update.cjs");

const offlineFetch = async () => { throw new Error("offline"); };

(async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "alp-checkout-release-"));
  try {
    const remote = path.join(root, "remote.git");
    const seed = path.join(root, "seed");
    const local = path.join(root, "local");
    fs.mkdirSync(seed);
    git(root, ["init", "--bare", "-q", remote]);
    git(seed, ["init", "-q"]); git(seed, ["branch", "-M", "main"]);
    fs.writeFileSync(path.join(seed, "package.json"), '{"version":"1.0.0"}\n');
    commit(seed, "v1.0.0");
    git(seed, ["remote", "add", "origin", remote]);
    git(seed, ["push", "-q", "-u", "origin", "main"]);
    git(seed, ["tag", "v1.0.0"]);
    fs.writeFileSync(path.join(seed, "package.json"), '{"version":"1.1.0"}\n');
    commit(seed, "v1.1.0");
    git(seed, ["push", "-q", "origin", "main"]);
    git(seed, ["tag", "v1.1.0"]);
    git(seed, ["push", "-q", "origin", "--tags"]);
    git(root, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
    git(root, ["clone", "-q", remote, local]);

    const resolved = await resolveLatestReleaseTag(local, { fetch: offlineFetch });
    assert.strictEqual(resolved.ok, true, resolved.message);
    assert.strictEqual(resolved.tag, "v1.1.0");
    assert.strictEqual(resolved.source, "git-ls-remote");

    const checkedOut = await checkoutLatestRelease(local, { stdio: ["ignore", "pipe", "pipe"], fetch: offlineFetch });
    assert.strictEqual(checkedOut.ok, true, checkedOut.message);
    assert.strictEqual(checkedOut.tag, "v1.1.0");
    assert.strictEqual(git(local, ["rev-parse", "HEAD"]), git(seed, ["rev-parse", "v1.1.0"]));

    fs.writeFileSync(path.join(local, "package.json"), '{"dirty":true}\n');
    const refused = await checkoutLatestRelease(local, { stdio: ["ignore", "pipe", "pipe"], fetch: offlineFetch });
    assert.match(refused.message, /tracked changes/);
    git(local, ["checkout", "--", "package.json"]);

    const pinned = await checkoutLatestRelease(local, { stdio: ["ignore", "pipe", "pipe"], pinTag: "v1.0.0" });
    assert.strictEqual(pinned.ok, true, pinned.message);
    assert.strictEqual(pinned.tag, "v1.0.0");
    assert.strictEqual(git(local, ["rev-parse", "HEAD"]), git(seed, ["rev-parse", "v1.0.0"]));

    console.log("OK               checkout-release resolves and checks out release tags");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });

function git(cwd, args) { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function commit(repo, message) { git(repo, ["add", "-A"]); git(repo, ["-c", "user.name=ALP Test", "-c", "user.email=test@alp.local", "commit", "-qm", message]); }

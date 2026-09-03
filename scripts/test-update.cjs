#!/usr/bin/env node
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
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
    for (const [relative, body] of [["runtime.json", "codex\n"], ["projects.json", '{"version":1,"projects":[]}\n'], [path.join("delegation", "x", "local.json"), '{"executions":{}}\n']]) {
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
    testAlpCjsAwaitsUpdate(root);
    console.log("OK               alp update preserves code-native machine-local state");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });

/**
 * `alp.cjs update` chạy thẳng, không qua dist/. v0.1.0 và v0.1.1 gọi updateInstallation đồng
 * bộ trong khi hàm này là async, nên đọc `result.ok` trên Promise luôn ra undefined: lệnh in
 * "ERROR undefined", exit 1 và không update gì. Test này khoá lại hợp đồng async đó.
 */
function testAlpCjsAwaitsUpdate(root) {
  const sourceRoot = path.resolve(__dirname, "..");
  for (const [name, stub, wantStatus, wantText] of [
    ["thành công", 'async () => ({ ok: true, tag: "v9.9.9" })', 0, "v9.9.9"],
    ["thất bại", 'async () => ({ ok: false, message: "tree bẩn" })', 1, "tree bẩn"],
  ]) {
    const repo = path.join(root, `alp-cjs-${wantStatus}`);
    // `alp.cjs` loads the command runner at require time, so the fixture has to carry it
    // even though this test never spawns anything through it.
    const commandRunner = path.join("scripts", "lib", "delegation", "command-runner.cjs");
    fs.mkdirSync(path.join(repo, path.dirname(commandRunner)), { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, "scripts", "alp.cjs"), path.join(repo, "scripts", "alp.cjs"));
    fs.copyFileSync(path.join(sourceRoot, commandRunner), path.join(repo, commandRunner));
    fs.writeFileSync(path.join(repo, "scripts", "lib", "update.cjs"), `exports.updateInstallation = ${stub};\n`);
    fs.writeFileSync(path.join(repo, "package.json"), '{"name":"alp-code","version":"0.0.0"}\n');

    const run = spawnSync(process.execPath, [path.join(repo, "scripts", "alp.cjs"), "update"], { encoding: "utf8" });
    const output = (run.stdout || "") + (run.stderr || "");
    assert.strictEqual(run.status, wantStatus, `alp update (${name}) exit ${run.status}: ${output}`);
    assert(output.includes(wantText), `alp update (${name}) thiếu "${wantText}": ${output}`);
    assert(!output.includes("undefined"), `alp update (${name}) rò undefined: ${output}`);
  }
  console.log("OK               alp.cjs update await Promise thay vì đọc .ok trên nó");
}

function git(cwd, args) { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function commit(repo, message) { git(repo, ["add", "-A"]); git(repo, ["-c", "user.name=ALP Test", "-c", "user.email=test@alp.local", "commit", "-qm", message]); }

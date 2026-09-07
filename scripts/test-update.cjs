#!/usr/bin/env node
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const {
  checkoutLatestRelease,
  updateInstallation,
  tarballHomeFor,
  bundleUrl,
} = require("./lib/update.cjs");

const fakeResolve = async () => ({ ok: true, tag: "v1.0.0", source: "test" });
const quiet = ["ignore", "pipe", "pipe"];

(async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "alp-update-"));
  try {
    await testDevClone(root);
    testNpmInstall(root);
    await testTarballInstall(root);
    testAlpCjsAwaitsUpdate(root);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });

/**
 * Dev clone là đường duy nhất còn build tại máy, nên nó cũng là đường duy nhất còn đòi working
 * tree sạch: checkout đè lên thay đổi chưa commit của chính người đang sửa repo.
 */
async function testDevClone(root) {
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

  const checkedOut = await checkoutLatestRelease(local, { stdio: quiet, resolveLatestReleaseTag: fakeResolve });
  assert.strictEqual(checkedOut.ok, true, checkedOut.message);
  assert.strictEqual(checkedOut.tag, "v1.0.0");

  fs.writeFileSync(path.join(local, "package.json"), '{"dirty":true}\n');
  const dirty = await checkoutLatestRelease(local, { stdio: quiet, resolveLatestReleaseTag: fakeResolve });
  assert.match(dirty.message, /tracked changes/);
  git(local, ["checkout", "--", "package.json"]);

  const spawned = [];
  const result = await updateInstallation(local, {
    channel: "dev", stdio: quiet, resolveLatestReleaseTag: fakeResolve,
    spawnProcess(_bin, args) { spawned.push(args[0]); return { status: 0, error: null, stdout: "", stderr: "" }; },
  });
  assert.strictEqual(result.ok, true, result.message);
  assert.strictEqual(result.channel, "dev");
  assert(spawned.some((arg) => arg.endsWith("bootstrap.cjs")), `dev clone phải build lại: ${spawned}`);
  console.log("OK               dev clone: checkout tag rồi build, chặn khi tracked tree bẩn");
}

/**
 * Bản npm không tự sờ vào thư mục cài của mình — nó gọi npm rồi để npm thay. Việc còn lại là
 * chạy ensure-state bằng tiến trình mới, vì code đang chạy đến từ thư mục vừa bị thay.
 */
function testNpmInstall(root) {
  const install = path.join(root, "npm-install");
  fs.mkdirSync(install, { recursive: true });
  fs.writeFileSync(path.join(install, "package.json"), '{"version":"1.0.0"}\n');

  return Promise.resolve().then(async () => {
    const commands = []; const spawned = [];
    const options = () => ({
      channel: "npm", stdio: quiet, resolveLatestReleaseTag: async () => ({ ok: true, tag: "v1.2.0", source: "test" }),
      runCommand(command, args) { commands.push([command, ...args].join(" ")); return { status: 0, error: null, stdout: "", stderr: "" }; },
      spawnProcess(_bin, args) { spawned.push(args[0]); return { status: 0, error: null, stdout: "", stderr: "" }; },
    });

    const result = await updateInstallation(install, options());
    assert.strictEqual(result.ok, true, result.message);
    assert.deepStrictEqual(commands, ["npm install --global alp-code@1.2.0"]);
    assert(spawned.some((arg) => arg.endsWith("ensure-state.cjs")), `npm update phải chạy ensure-state: ${spawned}`);

    // Bản đã ở đúng version thì không gọi npm lần nữa: `alp update` chạy được nhiều lần liền.
    const unchanged = await updateInstallation(install, { ...options(), resolveLatestReleaseTag: fakeResolve });
    assert.strictEqual(unchanged.unchanged, true);

    // npm global hỏng quyền là lỗi hay gặp nhất của channel này, và thông báo thô của npm
    // không nói cho người dùng biết phải làm gì.
    const denied = await updateInstallation(install, {
      ...options(),
      runCommand() { return { status: 1, error: null, stdout: "", stderr: "EACCES: permission denied, mkdir '/usr/lib/node_modules'" }; },
    });
    assert.strictEqual(denied.ok, false);
    assert.match(denied.message, /npm config set prefix|installer tarball/);
    console.log("OK               npm: cài qua npm -g, chạy ensure-state, chỉ lối khi EACCES");
  });
}

/**
 * Đường tarball là đường tự tay làm mọi thứ, nên test này chạy thật: nén một bundle, cho
 * `fetch` giả trả về đúng bytes đó, rồi soi đĩa. Điều cần khoá lại là bản mới nằm ở thư mục
 * riêng và `current` chỉ đổi sau khi nó đã đầy đủ.
 */
async function testTarballInstall(root) {
  const home = path.join(root, "tarball-home");
  const previous = path.join(home, "versions", "v0.9.0");
  const stale = path.join(home, "versions", "v0.8.0");
  for (const dir of [previous, stale]) {
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "scripts", "alp.cjs"), "// cũ\n");
    fs.writeFileSync(path.join(dir, "package.json"), `{"version":"${path.basename(dir).slice(1)}"}\n`);
  }

  const payload = path.join(root, "bundle-src");
  fs.mkdirSync(path.join(payload, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(payload, "scripts", "alp.cjs"), "// mới\n");
  fs.writeFileSync(path.join(payload, "package.json"), '{"version":"1.0.0"}\n');
  const archive = path.join(root, "bundle.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", payload, "."]);
  const bytes = fs.readFileSync(archive);

  const requested = []; const spawned = [];
  const result = await updateInstallation(previous, {
    channel: "tarball", stdio: quiet, tarballHome: home,
    resolveLatestReleaseTag: fakeResolve,
    async fetch(url) { requested.push(url); return { ok: true, async arrayBuffer() { return bytes; } }; },
    spawnProcess(_bin, args) { spawned.push(args[0]); return { status: 0, error: null, stdout: "", stderr: "" }; },
  });

  assert.strictEqual(result.ok, true, result.message);
  assert.deepStrictEqual(requested, [bundleUrl("v1.0.0")]);
  const installed = path.join(home, "versions", "v1.0.0");
  assert.strictEqual(fs.readFileSync(path.join(installed, "scripts", "alp.cjs"), "utf8"), "// mới\n");
  assert.strictEqual(fs.realpathSync(path.join(home, "current")), fs.realpathSync(installed));
  assert(spawned.some((arg) => arg === path.join(installed, "scripts", "ensure-state.cjs")),
    `ensure-state phải chạy từ thư mục MỚI: ${spawned}`);
  // Bản đang chạy còn đó để lùi lại được; bản cũ hơn nữa thì dọn.
  assert(fs.existsSync(previous), "bản đang chạy phải còn nguyên sau update");
  assert(!fs.existsSync(stale), "bản cũ hơn phải bị dọn");

  // Tải hỏng thì không được để lại nửa vời: `current` vẫn phải là bản cũ.
  const failed = await updateInstallation(previous, {
    channel: "tarball", stdio: quiet, tarballHome: home,
    resolveLatestReleaseTag: async () => ({ ok: true, tag: "v2.0.0", source: "test" }),
    async fetch() { return { ok: false, status: 404 }; },
  });
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(fs.realpathSync(path.join(home, "current")), fs.realpathSync(installed));
  assert(!fs.existsSync(path.join(home, "versions", "v2.0.0")));

  assert.strictEqual(tarballHomeFor(installed), home);
  console.log("OK               tarball: giải nén sang versions/<tag> rồi mới đổi current");
}

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

#!/usr/bin/env node
// test-state.cjs — nghiệm thu `~/.alp`: chỗ duy nhất còn giữ dữ liệu người dùng sau khi thư
// mục cài trở thành artifact thay được.
//
// Ba thứ được khoá ở đây, và cả ba đều là chuyện mất dữ liệu nếu sai: memory di trú đúng một
// lần và không bao giờ bị ghi đè; hook forwarder trỏ vào bản cài hiện hành; và project đã
// `alp init` từ trước được sửa lại đường dẫn hook thay vì hỏng câm.

"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { ensureState } = require("./lib/state.cjs");
const P = require("./lib/install-paths.cjs");

const sourceRoot = path.resolve(__dirname, "..");
const sandbox = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "alp-state-"));
let failed = 0;
try {
  testMigratesLegacyMemory();
  testMigratesPastIndexOnlyDirectory();
  testNeverOverwritesExistingMemory();
  testHookForwarderFollowsInstall();
  testRepairsProjectHooks();
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
if (failed) process.exit(1);
console.log("OK               state: 5 nhóm ca đều xanh");

/** Bản < v0.9.0 để memory trong thư mục cài — chỗ mà update giờ xoá nguyên khối. */
function testMigratesLegacyMemory() {
  const { root, env, home } = makeCase("migrate");
  write(path.join(root, "memory", "projects", "demo.md"), "important\n");

  const result = ensureState({ root, env });

  check("memory cũ trong thư mục cài được chuyển sang ~/.alp/memory", () => {
    assert.strictEqual(result.memoryRoot, path.join(home, ".alp", "memory"));
    assert.strictEqual(fs.readFileSync(path.join(result.memoryRoot, "projects", "demo.md"), "utf8"), "important\n");
    assert(!fs.existsSync(path.join(root, "memory")));
    assert(fs.existsSync(path.join(root, "memory.moved-to.txt")), "phải để lại dấu vết ở chỗ cũ");
  });
  check("khung scaffold được bù, install record ghi đúng channel và version", () => {
    assert(fs.existsSync(path.join(result.memoryRoot, "INDEX.md")));
    const record = P.readInstallRecord(env);
    assert.strictEqual(record.root, root);
    assert.strictEqual(record.channel, "tarball");
    assert.strictEqual(record.version, "9.9.9");
  });
}

/**
 * Ca hồi quy đắt nhất của file này.
 *
 * `alp doctor` và MarkdownFileStore tạo sẵn `~/.alp/memory` rồi ghi vào đó một index ẩn chỉ để
 * thử quyền ghi. Nếu di trú coi "thư mục đã tồn tại" là "đã có memory", người dùng lên v0.9.0
 * xong mở ra thấy trống trơn trong khi memory thật vẫn nằm nguyên chỗ cũ.
 */
function testMigratesPastIndexOnlyDirectory() {
  const { root, env, home } = makeCase("index-only");
  write(path.join(home, ".alp", "memory", ".alp-memory-index.json"), "{}\n");
  write(path.join(root, "memory", "shared", "decisions", "d1.md"), "quyết định\n");

  ensureState({ root, env });

  check("thư mục memory chỉ có index ẩn vẫn được coi là chưa có dữ liệu", () => {
    const target = path.join(home, ".alp", "memory");
    assert.strictEqual(fs.readFileSync(path.join(target, "shared", "decisions", "d1.md"), "utf8"), "quyết định\n");
    assert(!fs.existsSync(path.join(root, "memory")));
  });
}

/** Memory đã ở chỗ mới thì mọi thứ khác chỉ được đứng nhìn. */
function testNeverOverwritesExistingMemory() {
  const { root, env, home } = makeCase("no-overwrite");
  const target = path.join(home, ".alp", "memory");
  write(path.join(target, "INDEX.md"), "của tôi\n");
  write(path.join(root, "memory", "INDEX.md"), "của bản cài cũ\n");

  ensureState({ root, env });
  ensureState({ root, env }); // chạy mỗi lệnh `alp` — lần thứ hai cũng phải vô hại

  check("memory sẵn có không bị ghi đè, cũng không bị di trú đè lên", () => {
    assert.strictEqual(fs.readFileSync(path.join(target, "INDEX.md"), "utf8"), "của tôi\n");
    assert(fs.existsSync(path.join(root, "memory")), "không đụng vào thư mục cũ khi chỗ mới đã có dữ liệu");
  });
}

/**
 * Forwarder là lý do `<project>/.claude/settings.local.json` không cần sửa lại sau mỗi update:
 * nó ở một đường dẫn cố định và tự đọc bản cài hiện hành từ `install.json`.
 */
function testHookForwarderFollowsInstall() {
  const { root, env, home } = makeCase("forwarder");
  ensureState({ root, env });
  const forwarder = path.join(home, ".alp", "hooks", "session-boot.cjs");

  check("forwarder gọi được hook của bản cài hiện hành", () => {
    const r = spawnSync(process.execPath, [forwarder], { encoding: "utf8" });
    assert.strictEqual(r.status, 0, (r.stdout || "") + (r.stderr || ""));
    assert.strictEqual((r.stdout || "").trim(), `HOOK ${root}`);
  });

  // Update = thư mục cài mới hoàn toàn. Forwarder phải đi theo mà không ai sửa project nào.
  const next = makeInstall(path.join(sandbox, "forwarder-v2"));
  ensureState({ root: next, env });
  check("sau update, cùng đường dẫn forwarder trỏ sang bản cài mới", () => {
    const r = spawnSync(process.execPath, [forwarder], { encoding: "utf8" });
    assert.strictEqual((r.stdout || "").trim(), `HOOK ${next}`);
  });
}

/** Project `alp init` trước v0.9.0 trỏ thẳng vào thư mục cài cũ — chỗ sắp bị thay hoặc bị gỡ. */
function testRepairsProjectHooks() {
  const { root, env, home } = makeCase("repair");
  const mine = path.join(sandbox, "repair-project");
  const theirs = path.join(sandbox, "repair-foreign");
  const stale = `"/old/node" "${root}/hooks/session-boot.cjs"`;
  write(path.join(mine, ".claude", "settings.local.json"), JSON.stringify({
    $generatedBy: "alp init",
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: stale }] }] },
  }, null, 2));
  write(path.join(theirs, ".claude", "settings.local.json"), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: stale }] }] },
  }, null, 2));
  write(path.join(home, ".alp", "projects.json"), JSON.stringify({
    version: 1,
    projects: [{ path: mine }, { path: theirs }, { path: path.join(sandbox, "repair-gone") }],
  }));

  const result = ensureState({ root, env });
  const forwarder = P.hookForwarderPath("session-boot", env);

  check("project do alp init sinh được trỏ lại vào forwarder", () => {
    const parsed = JSON.parse(fs.readFileSync(path.join(mine, ".claude", "settings.local.json"), "utf8"));
    assert.strictEqual(
      parsed.hooks.SessionStart[0].hooks[0].command,
      `${JSON.stringify(process.execPath)} ${JSON.stringify(forwarder)}`,
    );
    assert(result.log.some((entry) => entry.level === "FIXED"));
  });
  check("file không mang marker `alp init` thì không đụng vào", () => {
    const parsed = JSON.parse(fs.readFileSync(path.join(theirs, ".claude", "settings.local.json"), "utf8"));
    assert.strictEqual(parsed.hooks.SessionStart[0].hooks[0].command, stale);
  });
}

// ------------------------------------------------------------------- tiện ích

function makeCase(name) {
  const home = path.join(sandbox, `${name}-home`);
  fs.mkdirSync(home, { recursive: true });
  return { root: makeInstall(path.join(sandbox, name)), home, env: { HOME: home, USERPROFILE: home } };
}

/** Cây file tối thiểu mà `ensureState` đòi: scaffold memory, hooks, config delegation. */
function makeInstall(root) {
  fs.mkdirSync(root, { recursive: true });
  fs.cpSync(path.join(sourceRoot, "scaffold", "memory"), path.join(root, "scaffold", "memory"), { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, "alp.config.yaml"), path.join(root, "alp.config.yaml"));
  write(path.join(root, "package.json"), '{"name":"alp-code","version":"9.9.9"}\n');
  write(path.join(root, "hooks", "session-boot.cjs"), 'console.log("HOOK " + process.env.ALP_REPO_ROOT);\n');
  return root;
}

function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function check(name, fn) {
  try {
    fn();
    console.log(`PASS             ${name}`);
  } catch (e) {
    console.log(`FAIL             ${name}\n                 ${e.message.split("\n").join("\n                 ")}`);
    failed++;
  }
}

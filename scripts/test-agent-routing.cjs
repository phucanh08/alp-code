#!/usr/bin/env node
const assert = require("assert");
const path = require("path");
const { spawnSync } = require("child_process");
const L = require("./lib/loadout.cjs");

const repoRoot = L.findRepoRoot(__dirname);
if (!repoRoot) throw new Error("không tìm thấy repo root");

const expected = {
  compaction: ["gpt-5.6-sol", "medium"],
  titling: ["gpt-5.6-luna", "low"],
  search: ["gpt-5.6-terra", "low"],
  review: ["gpt-5.5", "medium"],
};

for (const [role, [model, effort]] of Object.entries(expected)) {
  const loadout = L.loadLoadout(repoRoot, role);
  assert(loadout, `thiếu loadout của ${role}`);
  assert.strictEqual(loadout.model, model, `${role} model`);
  assert.strictEqual(loadout.reasoning_effort, effort, `${role} reasoning_effort`);
  assert.strictEqual(loadout.reports_to, "main", `${role} reports_to`);
  assert.deepStrictEqual(loadout.delegates_to, [], `${role} delegates_to`);

  const args = [role];
  if (["search", "review"].includes(role)) args.push("--project", repoRoot);
  args.push("--dry-run", "--", "routing probe");
  const probe = dryRun(args);
  assert.strictEqual(probe.model, model, `${role} dry-run model`);
  assert.strictEqual(probe.reasoningEffort, effort, `${role} dry-run effort`);
  assert.strictEqual(probe.sandbox, "read-only", `${role} phải read-only`);
  assert.deepStrictEqual(probe.delegation, {
    from: "main",
    replyTo: "main",
    principalFacing: false,
  });
}

const main = L.loadLoadout(repoRoot, "main");
assert(main.delegates_to.includes("compaction"));
assert(main.delegates_to.includes("titling"));

// main qua launcher Codex: `model:` là model Claude (runtime chính), nên launcher PHẢI
// lấy `codex_model:` — đưa `claude-opus-5` cho `codex -m` là hỏng câm.
assert.strictEqual(main.model, "claude-opus-5", "main giữ model Claude làm runtime chính");
const mainHome = dryRun(["main", "--dry-run", "--", "probe"]);
assert.strictEqual(mainHome.model, main.codex_model, "main dry-run dùng codex_model");
assert(mainHome.model.startsWith("gpt-"), "codex_model phải là model Codex");
assert.strictEqual(mainHome.sandbox, "workspace-write", "main ở nhà mình thì ghi được");
assert.deepStrictEqual(mainHome.delegation, {
  from: "principal",
  replyTo: "principal",
  principalFacing: true,
}, "main nhận việc từ principal, không bị bọc contract delegation");

// BẤT BIẾN CHARTER: cwd không nằm trong `workspaces.write` = read-only, kể cả main.
// Đây là chỗ dễ vỡ IM LẶNG nhất — không lỗi, không cảnh báo, chỉ mất bất biến.
assert.deepStrictEqual(L.effectiveWorkspaces(main).write, [], "tiền đề: main chưa khai workspace ghi");
const mainAway = dryRun(["main", "--project", "/tmp", "--dry-run", "--", "probe"]);
assert.strictEqual(mainAway.sandbox, "read-only", "main ở cwd lạ PHẢI read-only");

// `--exec` KHÔNG được nới quyền: nó chỉ đổi cách chạy (headless), không đổi vai là ai.
const execAway = dryRun(["main", "--project", "/tmp", "--exec", "--dry-run", "--", "probe"]);
assert.strictEqual(execAway.mode, "exec");
assert.strictEqual(execAway.sandbox, "read-only", "--exec ở cwd lạ vẫn phải read-only");
const execSub = dryRun(["read-thread", "--exec", "--dry-run", "--", "probe"]);
assert.strictEqual(execSub.sandbox, "read-only", "vai phụ không bao giờ ghi được");
assert.match(execSub.profile, /read-thread\.config\.toml$/, "phải trỏ tới profile của đúng vai");
assert.strictEqual(dryRun(["read-thread", "--dry-run", "--", "probe"]).mode, "interactive");

const compaction = L.loadLoadout(repoRoot, "compaction");
assert.deepStrictEqual(compaction.tools, ["Read", "Glob", "Grep"]);
assert.deepStrictEqual(compaction.skills, []);
const titling = L.loadLoadout(repoRoot, "titling");
assert.deepStrictEqual(titling.tools, []);
assert.deepStrictEqual(titling.skills, []);

console.log("OK               agent routing tests passed");

function dryRun(args) {
  const result = spawnSync(path.join(repoRoot, "scripts", "run-role.sh"), args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.strictEqual(result.status, 0, `dry-run ${args[0]}: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

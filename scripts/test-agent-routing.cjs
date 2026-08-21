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
  const result = spawnSync(path.join(repoRoot, "scripts", "run-role.sh"), args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.strictEqual(result.status, 0, `${role} dry-run: ${result.stderr || result.stdout}`);
  const dryRun = JSON.parse(result.stdout);
  assert.strictEqual(dryRun.model, model, `${role} dry-run model`);
  assert.strictEqual(dryRun.reasoningEffort, effort, `${role} dry-run effort`);
  assert.deepStrictEqual(dryRun.delegation, {
    from: "main",
    replyTo: "main",
    principalFacing: false,
  });
}

const main = L.loadLoadout(repoRoot, "main");
assert(main.delegates_to.includes("compaction"));
assert(main.delegates_to.includes("titling"));

const compaction = L.loadLoadout(repoRoot, "compaction");
assert.deepStrictEqual(compaction.tools, ["Read", "Glob", "Grep"]);
assert.deepStrictEqual(compaction.skills, []);
const titling = L.loadLoadout(repoRoot, "titling");
assert.deepStrictEqual(titling.tools, []);
assert.deepStrictEqual(titling.skills, []);

console.log("OK               agent routing tests passed");

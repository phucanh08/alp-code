#!/usr/bin/env node
const assert = require("assert");
const C = require("./lib/codex-role.cjs");

assert(C.isAllowedRole("compaction"));
assert(C.isAllowedRole("titling"));
assert(C.isAllowedRole("review"));
assert(C.isAllowedRole("oracle"));
assert(!C.isAllowedRole("main"));
assert.deepStrictEqual(C.reasoningArgs({ reasoning_effort: "medium" }), [
  "-c",
  'model_reasoning_effort="medium"',
]);
assert.deepStrictEqual(C.reasoningArgs({}), []);

console.log("OK               Codex role tests passed");

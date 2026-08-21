#!/usr/bin/env node
const assert = require("assert");
const C = require("./lib/codex-role.cjs");

assert(C.isAllowedRole("compaction"));
assert(C.isAllowedRole("titling"));
assert(C.isAllowedRole("review"));
assert(C.isAllowedRole("oracle"));
// main chạy được qua launcher Codex — nhưng Claude vẫn là runtime chính của nó.
assert(C.isAllowedRole("main"));
assert(!C.isAllowedRole("principal"));
assert(!C.isAllowedRole("_shared"));

console.log("OK               Codex role tests passed");

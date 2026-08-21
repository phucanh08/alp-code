#!/usr/bin/env node
const assert = require("assert");
const L = require("./lib/loadout.cjs");

const valid = base({ model: "gpt-5.6-sol", reasoning_effort: "medium" });
assert.deepStrictEqual(L.validate(valid, "probe", ["probe", "main"]), []);

const invalid = base({ model: "gpt-5.6-sol", reasoning_effort: "turbo" });
assert(L.validate(invalid, "probe", ["probe", "main"])
  .some((message) => message.includes("reasoning_effort")));

// `codex_model:` là khoá hợp lệ — main khai model Claude ở `model:` nên launcher Codex
// phải có chỗ khác để đọc.
assert.deepStrictEqual(
  L.validate(base({ model: "claude-opus-5", codex_model: "gpt-5.6-sol" }), "probe", ["probe", "main"]),
  []
);

// Gõ sai một khoá là hỏng IM LẶNG: `codex_modl:` không lỗi ở đâu cả, nó chỉ khiến
// launcher rơi về `model:` và đưa model Claude cho `codex`. Nên khoá lạ phải là lỗi.
assert(
  L.validate(base({ model: "m", codex_modl: "gpt-5.6-sol" }), "probe", ["probe", "main"])
    .some((message) => message.includes("codex_modl")),
  "khoá lạ phải bị bắt"
);

console.log("OK               loadout model tests passed");

function base(overrides) {
  return {
    role: "probe",
    name: "Probe",
    reports_to: "main",
    delegates_to: [],
    memory: { read: [], write: [] },
    workspaces: { read: [], write: [] },
    tools: [],
    skills: [],
    ...overrides,
  };
}

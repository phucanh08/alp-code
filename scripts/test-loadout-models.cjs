#!/usr/bin/env node
const assert = require("assert");
const L = require("./lib/loadout.cjs");

const valid = base({ model: "gpt-5.6-sol", reasoning_effort: "medium" });
assert.deepStrictEqual(L.validate(valid, "probe", ["probe", "main"]), []);

const invalid = base({ model: "gpt-5.6-sol", reasoning_effort: "turbo" });
assert(L.validate(invalid, "probe", ["probe", "main"])
  .some((message) => message.includes("reasoning_effort")));

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

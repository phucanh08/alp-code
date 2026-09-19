import { describe, expect, it } from "vitest";
import { requestFingerprint, type ChildRequest } from "../../../src/execution/graph/execution-graph-service";

const base: ChildRequest = {
  requestId: "req_1",
  agentId: "worker",
  task: "edit the parser",
  workspace: "/ws",
  workspaceMode: "workspace-write",
  mode: "medium",
  background: false,
  interactive: false,
  timeoutMs: null,
  metadata: {},
  writeScope: null,
};

/**
 * Oracle: P2 spec — "**Thêm** `writeScope` vào `requestFingerprint`": the same task confined
 * to a different set of paths is a different piece of work, and a retry with another scope
 * must not be answered with the old child.
 */
describe("requestFingerprint — writeScope", () => {
  it("separates an unscoped request from a scoped one, and two scopes from each other", () => {
    const unscoped = requestFingerprint("exec_parent", base);
    const src = requestFingerprint("exec_parent", { ...base, writeScope: ["/ws/src"] });
    const docs = requestFingerprint("exec_parent", { ...base, writeScope: ["/ws/docs"] });
    expect(new Set([unscoped, src, docs]).size).toBe(3);
  });

  it("is stable for the same scope", () => {
    expect(requestFingerprint("exec_parent", { ...base, writeScope: ["/ws/src"] }))
      .toBe(requestFingerprint("exec_parent", { ...base, writeScope: ["/ws/src"] }));
  });
});

/**
 * Oracle: master plan 2b — the assignment's boundary and wording are part of what was asked:
 * a different exclusion, objective or verification is different work; and a request that
 * names none of them fingerprints exactly as it did before they existed.
 */
describe("requestFingerprint — assignment", () => {
  it("separates requests by exclusion, objective and verification", () => {
    const plain = requestFingerprint("exec_parent", { ...base, writeScope: ["/ws/src"] });
    const excluded = requestFingerprint("exec_parent", { ...base, writeScope: ["/ws/src"], excludeScope: ["/ws/src/parser"] });
    const objective = requestFingerprint("exec_parent", { ...base, writeScope: ["/ws/src"], objective: "make it parse" });
    const verification = requestFingerprint("exec_parent", { ...base, writeScope: ["/ws/src"], verification: "npm test" });
    expect(new Set([plain, excluded, objective, verification]).size).toBe(4);
  });

  it("hashes an absent, null or empty assignment field like a request from before 2b", () => {
    const before = requestFingerprint("exec_parent", base);
    expect(requestFingerprint("exec_parent", { ...base, excludeScope: null, objective: null, verification: null })).toBe(before);
    expect(requestFingerprint("exec_parent", { ...base, excludeScope: [] })).toBe(before);
  });
});

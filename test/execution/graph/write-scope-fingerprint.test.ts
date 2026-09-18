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

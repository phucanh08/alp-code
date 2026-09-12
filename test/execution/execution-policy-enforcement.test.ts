import { describe, expect, it } from "vitest";
import { agentRegistry } from "../../src/agents/registry";
import type { AgentDefinition } from "../../src/agents/types";
import { createExecutionPolicy, type CreateExecutionPolicyInput } from "../../src/execution/execution-policy";
import { capabilitiesFor } from "../../src/runtime/capabilities";

const definition = agentRegistry.get("search") as AgentDefinition<unknown>;

const base: CreateExecutionPolicyInput = {
  executionId: "exec-enforcement",
  thread: null,
  definition,
  workspace: "/workspace",
  workspaceMode: "read-only",
  createdAt: "2026-09-12T00:00:00.000Z",
};

/**
 * `enforcement` is the row of the measured table this execution was judged against, and it
 * is **inside** the hashed snapshot: two executions of the same role on machines where the
 * runtime enforces different things are two different policies, and P3's evidence reads
 * this row rather than re-deriving it from whatever the table says later.
 */
describe("execution policy — runtime enforcement snapshot", () => {
  it("snapshots the table row for the resolved runtime on the given platform", () => {
    const policy = createExecutionPolicy({ ...base, platform: "darwin" });
    expect(policy.enforcement).toEqual(capabilitiesFor(policy.runtime, "darwin"));
    expect(Object.isFrozen(policy.enforcement)).toBe(true);
  });

  it("defaults the platform to the process it prepares on", () => {
    const policy = createExecutionPolicy(base);
    expect(policy.enforcement.measuredOn.platform).toBe(process.platform);
  });

  it("changes the policy hash when the enforcement row changes, and only then", () => {
    const darwin = createExecutionPolicy({ ...base, platform: "darwin" });
    const windows = createExecutionPolicy({ ...base, platform: "win32" });
    expect(darwin.enforcement).not.toEqual(windows.enforcement);
    expect(darwin.policyHash).not.toBe(windows.policyHash);
    // Everything that is a grant stays identical: the row records what the runtime honours,
    // it does not change what the role was given.
    expect(windows.allowedTools).toEqual(darwin.allowedTools);
    expect(windows.definitionHash).toBe(darwin.definitionHash);
    // Same platform, same hash — the row brings nothing non-deterministic into the snapshot.
    expect(createExecutionPolicy({ ...base, platform: "darwin" }).policyHash).toBe(darwin.policyHash);
  });
});

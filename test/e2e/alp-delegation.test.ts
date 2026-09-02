import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentRegistry } from "../../src/agents/registry";
import { BackendRegistry } from "../../src/delegation/backend-registry";
import { DelegationService, InMemoryDelegationExecutionStore } from "../../src/delegation/delegation-service";
import { cleanupEnvironments, createE2eEnvironment, type E2eEnvironment } from "./harness";

const SEARCH_OUTPUT = "Entrypoint located at index.ts:1 — `export const entrypoint`.";

afterEach(cleanupEnvironments);

function delegationService(environment: E2eEnvironment, ids: () => string) {
  return new DelegationService({
    registry: agentRegistry,
    policy: environment.policy,
    memory: environment.memory,
    executionService: environment.executionService,
    runtimeAdapters: environment.adapters,
    backendRegistry: new BackendRegistry().register(environment.backend),
    executionStore: new InMemoryDelegationExecutionStore(),
    config: { backend: environment.backend.name, fallbackBackend: null, defaultRuntime: "codex" },
    ids: { request: () => `req_${ids()}`, execution: ids },
  });
}

describe("e2e: specialist delegation", () => {
  it("runs main→search through policy, runtime, and backend to a validated result", async () => {
    const environment = await createE2eEnvironment({ output: SEARCH_OUTPUT });
    const service = delegationService(environment, () => "exec_search");

    const spawned = await service.delegate({
      parentRole: "main",
      targetRole: "search",
      task: "Find the entrypoint",
      workspace: environment.project,
      executionOptions: { runtime: "codex" },
    });
    const result = await service.wait(spawned.executionId);

    // Prose reaches the caller as prose — not as an escaped JSON blob.
    expect(result).toMatchObject({ status: "completed", output: SEARCH_OUTPUT });
    const capture = await environment.capture("codex");
    expect(capture.capsule).toMatchObject({
      role: "search",
      activeWorkspace: environment.project,
      outputContract: { name: agentRegistry.get("search").output.name },
    });
    // Delegated specialists are read-only, so the runtime is pinned to a read-only sandbox.
    expect(capture.argv).toContain("read-only");
    expect(capture.env.ALP_READONLY_DIRS).toBe(environment.project);
  });

  it("denies search→review before any runtime preparation or spawn", async () => {
    const environment = await createE2eEnvironment({ output: SEARCH_OUTPUT });
    const service = delegationService(environment, () => "exec_denied");

    await expect(service.delegate({
      parentRole: "search",
      targetRole: "review",
      task: "Review the entrypoint",
      workspace: environment.project,
      executionOptions: { runtime: "codex" },
    })).rejects.toThrowError(/delegation authorization failed/);

    // Nothing reached a runtime: no capture file and no execution artifacts exist.
    await expect(environment.capture("codex")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(service.status("exec_denied")).rejects.toMatchObject({ code: "EXECUTION_NOT_FOUND" });
  });

  it("keeps one execution out of another registered workspace", async () => {
    // No scripted output: the runtime leaves the execution state alone, so the hook
    // decisions below are read from a settled snapshot rather than racing the child.
    const environment = await createE2eEnvironment();
    const other = join(environment.root, "other-project");
    await mkdir(other);
    await writeFile(join(other, "secret.ts"), "export const secret = 1;\n");
    const service = delegationService(environment, () => "exec_scoped");

    const spawned = await service.delegate({
      parentRole: "main",
      targetRole: "search",
      task: "Find the entrypoint",
      workspace: environment.project,
      executionOptions: { runtime: "codex" },
    });
    await service.wait(spawned.executionId);

    // Workspace scoping is declared in the runtime's own config rather than intercepted
    // per tool call, so the assertion is on what the runtime was actually handed.
    const capture = await environment.capture("codex");
    expect(capture.cwd).toBe(environment.project);
    expect(capture.runtimeConfig).toContain(`sandbox_mode = "read-only"`);
    // Read-only means no writable root at all — not even the execution's own workspace.
    expect(capture.runtimeConfig).toContain("writable_roots = []");
    expect(capture.runtimeConfig).not.toContain(other);
  });
});

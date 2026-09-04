import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentRegistry } from "../../src/agents/registry";
import { DelegationService, FileDelegationExecutionStore, InMemoryDelegationExecutionStore } from "../../src/delegation/delegation-service";
import { DelegationError } from "../../src/delegation/types";
import type { ExecutionBackend } from "../../src/backend/execution-backend";
import type { PreparedExecution, PrepareExecutionInput } from "../../src/execution/types";
import type { RuntimeAdapter, RuntimeLaunchSpec } from "../../src/runtime/runtime-adapter";
import { removeTemporary } from "../support/temporary-root";

function prepared(executionId: string, target = "search"): PreparedExecution {
  const workspace = process.cwd();
  return {
    capsule: {
      executionId,
      definitionHash: "definition",
      policyHash: "policy",
      role: target,
      displayName: target,
      instructions: "prepared identity",
      task: "probe",
      activeWorkspace: workspace,
      memoryContext: {
        invariantContext: "invariants",
        policyContext: "policy",
        entries: [],
        diagnostics: { characterBudget: 0, charactersUsed: 0, truncated: false, omittedEntryIds: [] },
      },
      workflowState: { workflowId: "flow", currentState: "work", status: "running", repairAttempts: 0 },
      allowedTools: ["Read"],
      outputContract: { name: "result", schema: { type: "object" } },
    },
    policy: {
      executionId,
      role: target,
      workspace,
      workspaceMode: "read-only",
      allowedTools: ["Read"],
      memory: { read: [], write: [] },
      delegatesTo: [],
      createdAt: "2026-08-26T00:00:00.000Z",
      definitionHash: "definition",
      policyHash: "policy",
    },
    state: {
      executionId,
      status: "prepared",
      workflow: { workflowId: "flow", currentState: "work", status: "running", repairAttempts: 0 },
      policyHash: "policy",
      createdAt: "2026-08-26T00:00:00.000Z",
    },
    artifacts: {
      directory: "/tmp/execution",
      stateFile: "/tmp/execution/state.json",
      policyFile: "/tmp/execution/policy.json",
      runtimeDirectory: "/tmp/execution/runtime",
    },
  };
}

class FakeRuntime implements RuntimeAdapter {
  readonly name = "codex" as const;
  readonly compact = { preCompact: true, postCompact: true, sessionStartAfterCompact: true };
  calls: unknown[] = [];
  async probe() { return { ok: true, runtime: this.name, message: "ok" } as const; }
  async prepare(input: Parameters<RuntimeAdapter["prepare"]>[0]): Promise<RuntimeLaunchSpec> {
    this.calls.push(input);
    return {
      command: "fake-codex",
      args: [input.execution.capsule.task],
      cwd: input.execution.capsule.activeWorkspace,
      env: { ALP_DELEGATION_EXECUTION_ID: input.execution.capsule.executionId },
      temporaryFiles: [],
    };
  }
}

class FakeBackend implements ExecutionBackend {
  readonly calls: string[] = [];
  readonly spawnInputs: unknown[] = [];
  constructor(readonly name: string, private readonly healthy = true, private readonly spawnError?: Error) {}
  async healthCheck() { this.calls.push("health"); return { ok: this.healthy, message: this.healthy ? "ok" : "offline" }; }
  async spawn(input: Parameters<ExecutionBackend["spawn"]>[0]) {
    this.calls.push("spawn");
    this.spawnInputs.push(input);
    if (this.spawnError) throw this.spawnError;
    return { executionId: input.executionId, status: "running" as const };
  }
  statusError: { code: string; message: string } | null = null;
  async status(executionId: string) {
    this.calls.push("status");
    return this.statusError
      ? { executionId, status: "failed" as const, error: this.statusError }
      : { executionId, status: "running" as const };
  }
  async wait(executionId: string) { this.calls.push("wait"); return { executionId, status: "completed" as const, output: `${this.name} output` }; }
  async cancel(executionId: string) { this.calls.push("cancel"); return { executionId, status: "cancelled" as const }; }
  async cleanup(_executionId: string) { this.calls.push("cleanup"); }
}

function serviceFixture(options: {
  prepare?: (input: PrepareExecutionInput) => Promise<PreparedExecution>;
  primary?: FakeBackend;
} = {}) {
  const runtime = new FakeRuntime();
  const primary = options.primary ?? new FakeBackend("primary");
  const store = new InMemoryDelegationExecutionStore();
  let sequence = 0;
  const executionService = {
    prepare: options.prepare ?? (async (input: PrepareExecutionInput) => prepared(input.executionId, input.target)),
  };
  const service = new DelegationService({
    registry: agentRegistry,
    policy: { authorize: () => ({ allowed: true as const }) },
    memory: { buildContext: async () => { throw new Error("owned by ExecutionService"); } },
    executionService,
    runtimeAdapters: new Map([["codex", runtime]]),
    backend: primary,
    executionStore: store,
    config: { defaultRuntime: "codex" },
    ids: {
      request: () => `req-${++sequence}`,
      execution: () => `exec-${sequence}`,
    },
  });
  return { service, store, runtime, primary };
}

const input = {
  requestId: "request-explicit",
  parentRole: "main",
  targetRole: "search",
  task: "find launcher",
  workspace: process.cwd(),
  executionOptions: { runtime: "codex" as const, background: true },
};

describe("DelegationService", () => {
  it("denies before runtime preparation, spawn, or execution tracking", async () => {
    const denied = new Error("delegation authorization failed: denied");
    const fixture = serviceFixture({ prepare: async () => { throw denied; } });

    await expect(fixture.service.delegate(input)).rejects.toBe(denied);
    expect(fixture.runtime.calls).toHaveLength(0);
    expect(fixture.primary.calls).toEqual([]);
    expect(fixture.store.list()).toEqual([]);
  });

  it("preserves IDs, translates through the pinned runtime, and routes lifecycle to the spawned backend", async () => {
    const fixture = serviceFixture();
    const spawned = await fixture.service.delegate(input);

    expect(spawned).toMatchObject({
      executionId: "exec-0",
      requestId: "request-explicit",
      status: "running",
      metadata: { backend: "primary", runtime: "codex" },
    });
    expect(fixture.runtime.calls[0]).toMatchObject({
      model: agentRegistry.get("search").model.codex,
      reasoningEffort: agentRegistry.get("search").reasoningEffort.codex,
    });
    expect(fixture.store.get("exec-0")).toMatchObject({ backend: "primary", requestId: "request-explicit" });
    expect(fixture.primary.spawnInputs[0]).toMatchObject({
      lifecycle: {
        requestId: "request-explicit",
        parentExecutionId: null,
        background: true,
        interactive: false,
        timeoutMs: null,
      },
    });

    await expect(fixture.service.status("exec-0")).resolves.toMatchObject({ metadata: { backend: "primary" } });
    await expect(fixture.service.wait("exec-0")).resolves.toMatchObject({ status: "completed", output: "primary output" });
    await fixture.service.cancel("exec-0");
    await fixture.service.cleanup("exec-0");
    expect(fixture.primary.calls).toEqual(["health", "spawn", "status", "wait", "cancel", "cleanup"]);
  });

  /**
   * A `failed` execution that will not say why is barely more useful than a hung one. The
   * reason was produced by the backend and dropped here, because the result type had no
   * field for it — including the message that names the grant to fix.
   */
  it("carries the backend's failure reason through to the caller", async () => {
    const fixture = serviceFixture();
    await fixture.service.delegate(input);
    fixture.primary.statusError = { code: "ExecutionFailed", message: "dừng ở permission prompt" };

    await expect(fixture.service.status("exec-0")).resolves.toMatchObject({
      status: "failed",
      error: { code: "ExecutionFailed", message: "dừng ở permission prompt" },
    });
  });

  it("routes validated structured output from execution state when backend capture is empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-delegation-result-"));
    try {
      const stateFile = join(root, "state.json");
      const fixture = serviceFixture({
        prepare: async (request) => {
          const value = prepared(request.executionId, request.target);
          await writeFile(stateFile, JSON.stringify({ status: "completed", output: { status: "clear", findings: [] } }));
          return { ...value, artifacts: { ...value.artifacts, stateFile } };
        },
      });
      const spawned = await fixture.service.delegate(input);
      const result = await fixture.service.wait(spawned.executionId);
      expect(result).toMatchObject({
        status: "completed",
        output: JSON.stringify({ status: "clear", findings: [] }),
      });
    } finally {
      await removeTemporary(root);
    }
  });

  /**
   * A spawn that fails partway must stay failed. There is nothing to retry onto — the
   * fallback that used to exist was removed with Paseo — but the record still has to say
   * `failed` rather than be left at `queued`, which reads as an execution still coming.
   */
  it("records a failed spawn instead of leaving the execution queued", async () => {
    const primary = new FakeBackend("primary", true, new Error("partial spawn failure"));
    const fixture = serviceFixture({ primary });

    await expect(fixture.service.delegate(input)).rejects.toThrowError("partial spawn failure");
    expect(primary.calls).toEqual(["health", "spawn"]);
    expect(fixture.store.list()[0]).toMatchObject({ status: "failed", backend: "primary" });
  });

  it("returns typed errors for unsupported runtime choices", async () => {
    const fixture = serviceFixture();
    await expect(fixture.service.delegate({
      ...input,
      executionOptions: { ...input.executionOptions, runtime: "claude" },
    })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" } satisfies Partial<DelegationError>);
    expect(fixture.primary.calls).toEqual([]);
  });
});

describe("FileDelegationExecutionStore", () => {
  it("persists backend pinning across CLI processes", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-delegation-store-"));
    const file = join(root, "executions.json");
    try {
      const first = new FileDelegationExecutionStore({ file });
      first.put({
        executionId: "exec-persisted",
        requestId: "req-persisted",
        parentExecutionId: null,
        parentRole: "main",
        targetRole: "search",
        workspace: "/project",
        runtime: "codex",
        backend: "local",
        createdAt: "2026-08-26T00:00:00.000Z",
        status: "running",
      });
      const second = new FileDelegationExecutionStore({ file });
      expect(second.get("exec-persisted")).toMatchObject({ backend: "local", status: "running" });
      second.update("exec-persisted", { status: "completed" });
      expect(new FileDelegationExecutionStore({ file }).get("exec-persisted")).toMatchObject({ status: "completed" });
    } finally {
      await removeTemporary(root);
    }
  });
});

import { chmod, mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAgent } from "../../src/agents/agent-definition";
import type { AgentDefinition, AgentId, AgentRegistry } from "../../src/agents/types";
import type { BuiltMemoryContext, BuildMemoryContextInput } from "../../src/memory/types";
import type { Authorization, AuthorizationRequest } from "../../src/policy/types";
import { FileExecutionStore } from "../../src/execution/execution-store";
import { ExecutionService } from "../../src/execution/execution-service";
import { defineOutputContract } from "../../src/workflow/output-validator";
import { WorkflowRunner } from "../../src/workflow/workflow-runner";
import type { WorkflowDefinition, WorkflowExecutionState } from "../../src/workflow/types";
import { expectPosixMode } from "../support/file-mode";
import { removeTemporary } from "../support/temporary-root";

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await chmod(root, 0o700).catch(() => undefined);
    await import("node:fs/promises").then(({ rm }) => removeTemporary(root));
  }
});

function role(
  id: AgentId,
  events: string[],
  tools: AgentDefinition<unknown>["capabilities"]["tools"],
): AgentDefinition<unknown> {
  return defineAgent({
    id,
    displayName: id,
    model: { claude: `claude-${id}`, codex: `codex-${id}` },
    reasoningEffort: { claude: "low", codex: "low" },
    reportsTo: id === "main" ? "principal" : "main",
    delegatesTo: id === "main" ? ["search"] : [],
    capabilities: {
      tools,
      memory: { read: ["shared", `private:${id}`], write: [`private:${id}`] },
      workspace: {
        readRoots: ["/workspace"],
        writeRoots: id === "main" ? ["/workspace"] : [],
      },
    },
    instructions: () => {
      events.push("capsule");
      return `${id} instructions`;
    },
    workflow: {
      id: `${id}-workflow`,
      initial: "WORK",
      states: {
        WORK: { allowedTools: tools, transitions: ["REPORT"] },
        REPORT: { allowedTools: [], transitions: [], terminal: true },
      },
    },
    output: defineOutputContract(`${id}-output`, z.object({ summary: z.string() })),
  });
}

class MutableRegistry implements AgentRegistry {
  private readonly definitions = new Map<AgentId, AgentDefinition<unknown>>();

  constructor(definitions: readonly AgentDefinition<unknown>[], private readonly events: string[]) {
    for (const definition of definitions) this.definitions.set(definition.id, definition);
  }

  replace(definition: AgentDefinition<unknown>): void {
    this.definitions.set(definition.id, definition);
  }

  get(id: AgentId): AgentDefinition<unknown> {
    this.events.push(`resolve:${id}`);
    const definition = this.definitions.get(id);
    if (!definition) throw new Error(`unknown ${id}`);
    return definition;
  }

  has(id: AgentId): boolean {
    return this.definitions.has(id);
  }

  list(): readonly AgentDefinition<unknown>[] {
    return [...this.definitions.values()];
  }
}

class RecordingRunner extends WorkflowRunner {
  constructor(private readonly events: string[]) {
    super();
  }

  override initialize(definition: WorkflowDefinition): WorkflowExecutionState {
    this.events.push("workflow");
    return super.initialize(definition);
  }
}

const context: BuiltMemoryContext = {
  invariantContext: "invariants",
  policyContext: "policy",
  entries: [{
    id: "shared:voice",
    scope: "shared",
    kind: "fact",
    content: "direct",
    version: 1,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
  }],
  diagnostics: {
    characterBudget: 100,
    charactersUsed: 6,
    truncated: false,
    omittedEntryIds: [],
  },
};

describe("ExecutionService", () => {
  it("prepares in deny-first order and persists immutable restrictive snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-execution-"));
    temporaryRoots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const events: string[] = [];
    const main = role("main", events, ["Read", "Write"]);
    const search = role("search", events, ["Read"]);
    const registry = new MutableRegistry([main, search], events);
    const policy = {
      authorize(request: AuthorizationRequest): Authorization {
        events.push(`authorize:${request.type}`);
        return { allowed: true };
      },
    };
    const memory = {
      async buildContext(_input: BuildMemoryContextInput): Promise<BuiltMemoryContext> {
        events.push("memory");
        return context;
      },
    };
    const store = new FileExecutionStore({ root: join(root, "executions") });
    const service = new ExecutionService({
      registry,
      policy,
      memory,
      workflowRunner: new RecordingRunner(events),
      store,
      resolveWorkspace: async (value) => {
        events.push("workspace");
        return value;
      },
      now: () => new Date("2026-08-26T00:00:00.000Z"),
    });

    const prepared = await service.prepare({
      executionId: "exec_immutable",
      parent: "main",
      target: "search",
      task: "find the entrypoint",
      workspace,
      workspaceMode: "read-only",
      memoryQueries: [{ scope: "shared" }],
      characterBudget: 100,
      invariantContext: "invariants",
      policyContext: "policy",
    });

    expect(events).toEqual([
      "resolve:main",
      "resolve:search",
      "authorize:delegation",
      "workspace",
      "authorize:workspace",
      "memory",
      "workflow",
      "capsule",
    ]);
    expect(prepared.policy).toMatchObject({
      executionId: "exec_immutable",
      role: "search",
      workspace,
      workspaceMode: "read-only",
      allowedTools: ["Read"],
      memory: { read: ["shared", "private:search"], write: ["private:search"] },
    });

    registry.replace(role("search", events, ["Read", "Grep"]));
    expect(prepared.policy.allowedTools).toEqual(["Read"]);
    const policyPath = join(root, "executions", "exec_immutable", "policy.json");
    const statePath = join(root, "executions", "exec_immutable", "state.json");
    const persistedPolicy = JSON.parse(await readFile(policyPath, "utf8"));
    expect(persistedPolicy.allowedTools).toEqual(["Read"]);
    expect(persistedPolicy.policyHash).toBe(prepared.policy.policyHash);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      executionId: "exec_immutable",
      status: "prepared",
      policyHash: prepared.policy.policyHash,
    });
    await expectPosixMode(join(root, "executions", "exec_immutable"), 0o700);
    await expectPosixMode(policyPath, 0o600);
    await expectPosixMode(statePath, 0o600);
    await expect((await import("node:fs/promises")).readdir(join(root, "executions", "exec_immutable"))).resolves.toEqual([
      "context",
      "policy.json",
      "runtime",
      "state.json",
    ]);

    const contextDirectory = join(root, "executions", "exec_immutable", "context");
    await expectPosixMode(contextDirectory, 0o700);
    const checkpointPath = join(contextDirectory, "checkpoint.json");
    const continuityPath = join(contextDirectory, "continuity.md");
    await expectPosixMode(checkpointPath, 0o600);
    await expectPosixMode(continuityPath, 0o600);
    expect(prepared.artifacts).toMatchObject({
      contextDirectory,
      checkpointFile: checkpointPath,
      continuityFile: continuityPath,
      compactEventsFile: join(contextDirectory, "compact-events.jsonl"),
    });
    expect(JSON.parse(await readFile(checkpointPath, "utf8"))).toMatchObject({
      version: 1,
      executionId: "exec_immutable",
      policyHash: prepared.policy.policyHash,
      objective: "find the entrypoint",
      decisions: [], constraints: [], openItems: [], nextActions: [],
    });
    expect(await readFile(continuityPath, "utf8")).toContain("find the entrypoint");
  });

  it("does not create a context/ directory for a denied execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-execution-context-denied-"));
    temporaryRoots.push(root);
    const events: string[] = [];
    const registry = new MutableRegistry([
      role("main", events, ["Read"]),
      role("search", events, ["Read"]),
    ], events);
    const service = new ExecutionService({
      registry,
      policy: {
        authorize(request: AuthorizationRequest): Authorization {
          return { allowed: false, code: "DELEGATION_NOT_ALLOWED", reason: "denied" };
        },
      },
      memory: { async buildContext(): Promise<BuiltMemoryContext> { return context; } },
      workflowRunner: new RecordingRunner(events),
      store: new FileExecutionStore({ root: join(root, "executions") }),
    });

    await expect(service.prepare({
      executionId: "exec-context-denied",
      parent: "main",
      target: "search",
      task: "denied",
      workspace: join(root, "workspace"),
      workspaceMode: "read-only",
      memoryQueries: [],
      characterBudget: 0,
      invariantContext: "",
      policyContext: "",
    })).rejects.toThrow();
    await expect((await import("node:fs/promises")).access(join(root, "executions", "exec-context-denied"))).rejects.toThrow();
  });

  it("stops before workspace, memory, workflow, and storage when authorization fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-execution-denied-"));
    temporaryRoots.push(root);
    const events: string[] = [];
    const registry = new MutableRegistry([
      role("main", events, ["Read"]),
      role("search", events, ["Read"]),
    ], events);
    const service = new ExecutionService({
      registry,
      policy: {
        authorize(request: AuthorizationRequest): Authorization {
          events.push(`authorize:${request.type}`);
          return { allowed: false, code: "DELEGATION_NOT_ALLOWED", reason: "denied" };
        },
      },
      memory: {
        async buildContext(): Promise<BuiltMemoryContext> {
          events.push("memory");
          return context;
        },
      },
      workflowRunner: new RecordingRunner(events),
      store: new FileExecutionStore({ root: join(root, "executions") }),
      resolveWorkspace: async (value) => {
        events.push("workspace");
        return value;
      },
    });

    await expect(service.prepare({
      executionId: "exec-denied",
      parent: "main",
      target: "search",
      task: "denied",
      workspace: join(root, "workspace"),
      workspaceMode: "read-only",
      memoryQueries: [],
      characterBudget: 0,
      invariantContext: "",
      policyContext: "",
    })).rejects.toThrowError(/delegation authorization failed.*denied/);
    expect(events).toEqual(["resolve:main", "resolve:search", "authorize:delegation"]);
  });
});

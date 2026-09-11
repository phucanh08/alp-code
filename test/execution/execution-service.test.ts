import { chmod, mkdtemp, mkdir, readdir, readFile } from "node:fs/promises";
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
      skills: [],
      subagents: [],
      mcpServers: [],
      memory: { read: ["shared", `private:${id}`], write: [`private:${id}`] },
      workspace: {
        readRoots: ["/workspace"],
        writeRoots: id === "main" ? ["/workspace"] : [],
      },
    },
    instructions: { role: id, purpose: `${id} instructions`, rules: [] },
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

interface Harness {
  readonly events: string[];
  readonly registry: MutableRegistry;
  readonly service: ExecutionService;
  readonly root: string;
}

async function setup(label: string): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), `alp-execution-${label}-`));
  temporaryRoots.push(root);
  await mkdir(join(root, "workspace"));
  const events: string[] = [];
  const registry = new MutableRegistry(
    [role("main", events, ["Read", "Write"]), role("search", events, ["Read"])],
    events,
  );
  const service = new ExecutionService({
    registry,
    policy: {
      authorize(request: AuthorizationRequest): Authorization {
        events.push(`authorize:${request.type}`);
        return { allowed: true };
      },
    },
    memory: {
      async buildContext(_input: BuildMemoryContextInput): Promise<BuiltMemoryContext> {
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
    now: () => new Date("2026-08-26T00:00:00.000Z"),
  });
  return { events, registry, service, root };
}

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
      thread: null,
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
    ]);
    // Identity is data now, so building the capsule no longer calls back into the
    // definition and there is nothing left to observe in `events`. What the capsule was
    // built from is asserted directly instead.
    expect(prepared.capsule.instructions).toContain("search instructions");
    expect(prepared.policy).toMatchObject({
      executionId: "exec_immutable",
      role: "search",
      workspace,
      workspaceMode: "read-only",
      allowedTools: ["Read"],
      skills: [],
      subagents: [],
      mcpServers: [],
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

  /**
   * The split exists so that nothing durable is created while the answer to "is this allowed"
   * is still open. A test that only checked the return value would pass on a service that
   * wrote `policy.json` first and handed back a ticket afterwards, so what is asserted here is
   * the absence: no memory built, no workflow initialised, no execution directory on disk.
   */
  it("authorizes without building memory, workflow, or anything on disk", async () => {
    const { events, service, root } = await setup("authorize-only");

    const authorization = await service.authorize({
      executionId: "exec_authorize",
      parent: "main",
      target: "search",
      workspace: join(root, "workspace"),
      workspaceMode: "read-only",
    });

    expect(events).toEqual([
      "resolve:main",
      "resolve:search",
      "authorize:delegation",
      "workspace",
      "authorize:workspace",
    ]);
    expect(authorization).toMatchObject({
      executionId: "exec_authorize",
      parent: "main",
      target: "search",
      workspace: join(root, "workspace"),
      workspaceMode: "read-only",
    });
    expect(Object.isFrozen(authorization)).toBe(true);
    await expect(readdir(join(root, "executions"))).rejects.toThrow();
  });

  /**
   * The ticket carries no secret and its fields are all readable, so an object of the same
   * shape is trivial to build. What makes it a ticket is that this service instance issued it:
   * a forgery, or a genuine ticket from a service wired to a different registry and policy,
   * would otherwise let `materialize()` write a policy snapshot nobody ever authorized.
   */
  it("materializes only an authorization it issued itself", async () => {
    const mine = await setup("materialize-mine");
    const other = await setup("materialize-other");

    const authorization = await mine.service.authorize({
      executionId: "exec_materialize",
      parent: "main",
      target: "search",
      workspace: join(mine.root, "workspace"),
      workspaceMode: "read-only",
    });
    const work = {
      task: "find the entrypoint",
      thread: null,
      memoryQueries: [],
      characterBudget: 100,
      invariantContext: "invariants",
      policyContext: "policy",
    } as const;

    await expect(mine.service.materialize({ ...authorization }, work)).rejects.toThrowError(
      /authorization was not issued by this service/,
    );
    const elsewhere = await other.service.authorize({
      executionId: "exec_materialize",
      parent: "main",
      target: "search",
      workspace: join(other.root, "workspace"),
      workspaceMode: "read-only",
    });
    await expect(mine.service.materialize(elsewhere, work)).rejects.toThrowError(
      /authorization was not issued by this service/,
    );
    await expect(readdir(join(mine.root, "executions"))).rejects.toThrow();

    const prepared = await mine.service.materialize(authorization, work);
    expect(prepared.policy).toMatchObject({
      executionId: "exec_materialize",
      role: "search",
      workspace: join(mine.root, "workspace"),
    });
    expect(mine.events.slice(-2)).toEqual(["memory", "workflow"]);
    expect(await readdir(join(mine.root, "executions"))).toEqual(["exec_materialize"]);
  });

  /**
   * Registry sửa được lúc chạy, nên hai lần tra cùng một tên không hứa hẹn cùng một câu trả
   * lời. Nếu `materialize()` tra lại thì nó vừa mở đúng cửa sổ mà việc kiểm quyền trước đó
   * vừa đóng: policy duyệt một definition, `policy.json` lại sinh ra từ một definition khác.
   */
  it("materializes the definition that was authorized, not the one the registry holds later", async () => {
    const { events, registry, service, root } = await setup("materialize-pinned");

    const authorization = await service.authorize({
      executionId: "exec_pinned",
      parent: "main",
      target: "search",
      workspace: join(root, "workspace"),
      workspaceMode: "read-only",
    });
    registry.replace(role("search", events, ["Read", "Write", "Bash"]));

    const prepared = await service.materialize(authorization, {
      task: "find the entrypoint",
      thread: null,
      memoryQueries: [],
      characterBudget: 100,
      invariantContext: "invariants",
      policyContext: "policy",
    });
    expect(prepared.policy.allowedTools).toEqual(["Read"]);
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
      thread: null,
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
      thread: null,
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

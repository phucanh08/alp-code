import { realpath } from "node:fs/promises";
import type { AgentId, AgentRegistry } from "../agents/types";
import { seedCheckpoint, writeCheckpoint } from "../context/checkpoint";
import { renderContinuity } from "../context/continuity";
import { atomicRuntimeFile } from "../runtime/adapter-files";
import type { MemoryService } from "../memory/memory-service";
import type { BuildMemoryContextInput, BuiltMemoryContext } from "../memory/types";
import type { Authorization, AuthorizationRequest } from "../policy/types";
import type { WorkflowRunner } from "../workflow/workflow-runner";
import { createExecutionPolicy } from "./execution-policy";
import type { ExecutionStore } from "./execution-store";
import { createIdentityCapsule } from "./identity-capsule";
import {
  deepFreezeExecutionValue,
  type PrepareExecutionInput,
  type PreparedExecution,
  type StoredExecutionState,
} from "./types";

export interface ExecutionAuthorizer {
  authorize(request: AuthorizationRequest): Authorization;
}

export interface ExecutionMemoryService {
  buildContext(input: BuildMemoryContextInput): Promise<BuiltMemoryContext>;
}

export interface ExecutionServiceOptions {
  readonly registry: AgentRegistry;
  readonly policy: ExecutionAuthorizer;
  readonly memory: ExecutionMemoryService | Pick<MemoryService, "buildContext">;
  readonly workflowRunner: Pick<WorkflowRunner, "initialize">;
  readonly store: ExecutionStore;
  readonly resolveWorkspace?: (workspace: string) => Promise<string>;
  readonly now?: () => Date;
}

function requireAuthorization(
  kind: "delegation" | "workspace",
  authorization: Authorization,
): void {
  if (!authorization.allowed) {
    throw new Error(
      `${kind} authorization failed (${authorization.code}): ${authorization.reason}`,
    );
  }
}

export class ExecutionService {
  private readonly registry: AgentRegistry;
  private readonly policy: ExecutionAuthorizer;
  private readonly memory: ExecutionMemoryService;
  private readonly workflowRunner: Pick<WorkflowRunner, "initialize">;
  private readonly store: ExecutionStore;
  private readonly resolveWorkspace: (workspace: string) => Promise<string>;
  private readonly now: () => Date;

  constructor(options: ExecutionServiceOptions) {
    this.registry = options.registry;
    this.policy = options.policy;
    this.memory = options.memory;
    this.workflowRunner = options.workflowRunner;
    this.store = options.store;
    this.resolveWorkspace = options.resolveWorkspace ?? realpath;
    this.now = options.now ?? (() => new Date());
  }

  async prepare(input: PrepareExecutionInput): Promise<PreparedExecution> {
    let parent: AgentId | "principal" = input.parent;
    if (parent !== "principal") {
      parent = this.registry.get(parent).id;
    }
    const definition = this.registry.get(input.target);

    if (parent === "principal") {
      if (definition.reportsTo !== "principal") {
        throw new Error(
          `delegation authorization failed: \`${definition.id}\` does not report to principal`,
        );
      }
    } else {
      requireAuthorization(
        "delegation",
        this.policy.authorize({
          type: "delegation",
          actor: parent,
          target: definition.id,
        }),
      );
    }

    const workspace = await this.resolveWorkspace(input.workspace);
    requireAuthorization(
      "workspace",
      this.policy.authorize({
        type: "workspace",
        actor: definition.id,
        operation: input.workspaceMode === "workspace-write" ? "write" : "read",
        path: workspace,
        execution: {
          activeWorkspace: workspace,
          workspaceMode: input.workspaceMode,
          delegated: parent !== "principal",
        },
      }),
    );

    const memoryContext = await this.memory.buildContext({
      actor: definition.id,
      queries: input.memoryQueries,
      characterBudget: input.characterBudget,
      invariantContext: input.invariantContext,
      policyContext: input.policyContext,
    });
    const workflowState = this.workflowRunner.initialize(definition.workflow);
    const createdAt = this.now().toISOString();
    const policy = createExecutionPolicy({
      executionId: input.executionId,
      definition,
      workspace,
      workspaceMode: input.workspaceMode,
      createdAt,
    });
    const capsule = createIdentityCapsule({
      definition,
      policy,
      task: input.task,
      memoryContext,
      workflowState,
    });
    const state: StoredExecutionState = deepFreezeExecutionValue({
      executionId: input.executionId,
      status: "prepared",
      workflow: { ...workflowState },
      policyHash: policy.policyHash,
      createdAt,
    });
    const artifacts = await this.store.create({ policy, state });

    // §8.1: seed the checkpoint here, not lazily on first pin, so a fresh execution's
    // continuity is never empty by omission — the objective alone is worth reinjecting.
    const checkpoint = await writeCheckpoint(artifacts.checkpointFile, seedCheckpoint({
      executionId: input.executionId,
      policyHash: policy.policyHash,
      objective: capsule.task,
      now: () => createdAt,
    }));
    await atomicRuntimeFile(artifacts.continuityFile, renderContinuity(checkpoint));

    return deepFreezeExecutionValue({ capsule, policy, state, artifacts });
  }
}

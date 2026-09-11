import { realpath } from "node:fs/promises";
import type { AgentDefinition, AgentId, AgentRegistry } from "../agents/types";
import { seedCheckpoint, writeCheckpoint } from "../context/checkpoint";
import { seedPinsFromSnapshot } from "../thread/context-types";
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
  type AuthorizeExecutionInput,
  type ExecutionAuthorization,
  type MaterializeExecutionInput,
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
  /**
   * Những vé chính instance này đã phát, và definition đã được duyệt cùng mỗi vé.
   *
   * Khoá là object chứ không phải một cờ bên trong nó: cờ nào cũng sao chép được, còn danh
   * tính của một object thì không. Definition đi kèm vì registry sửa được lúc chạy — tra lại
   * `target` ở `materialize()` là mở đúng cửa sổ mà việc kiểm quyền trước vừa đóng: policy
   * duyệt một definition, artifact lại sinh ra từ một definition khác. Vé chết cùng người
   * cầm nó, nên bảng này không lớn lên theo số execution đã chạy.
   */
  private readonly issued = new WeakMap<ExecutionAuthorization, AgentDefinition<unknown>>();

  constructor(options: ExecutionServiceOptions) {
    this.registry = options.registry;
    this.policy = options.policy;
    this.memory = options.memory;
    this.workflowRunner = options.workflowRunner;
    this.store = options.store;
    this.resolveWorkspace = options.resolveWorkspace ?? realpath;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Deny-first, và chỉ có thế: không memory, không workflow, không một byte nào chạm đĩa.
   *
   * Khoảng lặng giữa `authorize()` và `materialize()` là chỗ `runMainSession` ghi node
   * `preparing` vào graph, nên không có lúc nào một execution có thư mục trên đĩa mà cây
   * chưa biết tới nó.
   */
  async authorize(input: AuthorizeExecutionInput): Promise<ExecutionAuthorization> {
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
    // A role that declares no workspace root (read-thread, compaction, titling) reads memory,
    // not the tree: there is no path for policy to authorize, and asking about one could only
    // ever come back WORKSPACE_NOT_GRANTED — which is why those three could not be launched
    // at all. A *write* request is still asked, because that is a grant they genuinely lack;
    // the deny it returns is the right answer rather than an artefact of the question.
    const grantsWorkspace = definition.capabilities.workspace.readRoots.length > 0;
    if (grantsWorkspace || input.workspaceMode === "workspace-write") {
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
    }

    const authorization = deepFreezeExecutionValue<ExecutionAuthorization>({
      executionId: input.executionId,
      parent,
      target: definition.id,
      workspace,
      workspaceMode: input.workspaceMode,
      authorizedAt: this.now().toISOString(),
    });
    this.issued.set(authorization, definition);
    return authorization;
  }

  /**
   * Biến một vé thành artifact. Mọi trường mang quyền đều đọc từ vé, không từ `input`.
   */
  async materialize(
    authorization: ExecutionAuthorization,
    input: MaterializeExecutionInput,
  ): Promise<PreparedExecution> {
    const definition = this.issued.get(authorization);
    if (!definition) {
      throw new Error("execution authorization was not issued by this service");
    }
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
      executionId: authorization.executionId,
      thread: input.thread,
      definition,
      workspace: authorization.workspace,
      workspaceMode: authorization.workspaceMode,
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      ...(input.modeProfiles === undefined ? {} : { modeProfiles: input.modeProfiles }),
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
      executionId: authorization.executionId,
      status: "prepared",
      workflow: { ...workflowState },
      policyHash: policy.policyHash,
      createdAt,
    });
    const artifacts = await this.store.create({ policy, state });

    // §8.1: seed the checkpoint here, not lazily on first pin, so a fresh execution's
    // continuity is never empty by omission — the objective alone is worth reinjecting.
    // Root của một Thread mở đầu với đúng những dòng snapshot rev N: work state E-(n-1) để
    // lại, seed vào checkpoint như pins nguồn `execution`. Policy ở trên không nhìn thấy chúng.
    const threadContext = input.threadContext ?? null;
    const checkpoint = await writeCheckpoint(artifacts.checkpointFile, seedCheckpoint({
      executionId: authorization.executionId,
      policyHash: policy.policyHash,
      objective: threadContext?.snapshot?.objective ?? threadContext?.title ?? capsule.task,
      pins: seedPinsFromSnapshot(threadContext?.snapshot ?? null, createdAt),
      now: () => createdAt,
    }));
    await atomicRuntimeFile(artifacts.continuityFile, renderContinuity(checkpoint));

    return deepFreezeExecutionValue({ capsule, policy, state, artifacts, threadContext });
  }

  /**
   * Đường cũ, giữ nguyên chữ ký cho các call site chưa cần cửa sổ ở giữa.
   */
  async prepare(input: PrepareExecutionInput): Promise<PreparedExecution> {
    return this.materialize(await this.authorize(input), input);
  }
}

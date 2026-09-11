import type {
  McpServerCatalogEntry,
  SubagentCatalogEntry,
} from "../agents/capability-catalog";
import type {
  AgentId,
  MemoryGrants,
  ReasoningEffort,
  RuntimeId,
  ToolId,
} from "../agents/types";
import type { ModeId, ModeProfiles } from "../agents/modes";
import type {
  ContextDiagnostics,
  MemoryKind,
  MemoryQuery,
} from "../memory/types";
import type { ThreadContextHandoff } from "../thread/context-types";
import type { WorkflowExecutionState } from "../workflow/types";
import type { WorkflowRunStatus } from "../workflow/types";

export type ExecutionId = string;

/**
 * A capability grant after its name has been resolved against the catalog.
 *
 * The resolution is snapshotted rather than looked up again at launch: the policy record is
 * what an execution is judged against afterwards, and "which command did this run, reaching
 * what" is exactly the question a name alone cannot answer once the catalog has moved on.
 */
export interface McpServerAuthorization extends McpServerCatalogEntry {
  readonly name: string;
}

export interface SubagentAuthorization extends SubagentCatalogEntry {
  readonly name: string;
}

/**
 * Thread mà execution này thuộc về, chụp lúc reserve và không đổi sau đó.
 *
 * Nằm **trong** snapshot đã hash: một execution không thể bị "chuyển Thread" bằng cách sửa
 * metadata, và child kế thừa đúng bản này từ node cha chứ không đọc Thread mutable. Chỉ là
 * provenance — không field nào ở đây cấp quyền; PolicyEngine không đọc Thread.
 */
export interface ExecutionThreadBinding {
  readonly id: string;
  /** Revision context Thread mà execution này nhìn thấy lúc reserve; `0` = chưa có. */
  readonly contextRevision: number;
  readonly contextDigest: string;
}

export interface ExecutionPolicy {
  readonly executionId: ExecutionId;
  /**
   * Key bắt buộc, `null` khi execution không thuộc Thread nào (legacy, nội bộ).
   *
   * `canonicalize()` bỏ key `undefined`, nên "vắng" và "không có" phải là cùng một giá trị
   * tường minh — nếu không, một policy có Thread và một policy legacy có thể trùng hash.
   */
  readonly thread: ExecutionThreadBinding | null;
  readonly role: AgentId;
  readonly workspace: string;
  readonly workspaceMode: "read-only" | "workspace-write";
  /**
   * Nấc công suất đã chạy execution này (`low`…`ultra`). Cùng một definition chạy được nhiều
   * model, nên nếu snapshot không nói ra nấc thì `policy.json` mô tả một execution mà nó
   * không mô tả nổi — và hai lần chạy khác model lại có cùng `policyHash`.
   */
  readonly mode: ModeId;
  /**
   * Loadout đã giải xong của execution này — model, mức nghĩ, và CLI mà model đó kéo theo.
   *
   * Tên nấc một mình đủ để trả lời câu trên chỉ khi nấc là hằng số biên dịch sẵn. Từ khi
   * `settings.json` sửa được loadout, hai máy cùng chạy `high` có thể chạy hai model khác
   * nhau — và `policy.json` nói `high` thì vẫn không nói ra máy này đã chạy gì. Ba trường
   * này là câu trả lời, và vì chúng nằm trong snapshot nên chúng nằm luôn trong `policyHash`:
   * đổi một dòng settings là đổi hash, đúng như đổi nấc.
   */
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly runtime: RuntimeId;
  /**
   * Whether this role holds any workspace grant at all. `none` for a role that declares no
   * root (read-thread, compaction, titling): it works from memory, the workspace is only
   * the process cwd, and the runtime ACL must not hand it the tree as a read root.
   */
  readonly workspaceAccess: "granted" | "none";
  readonly allowedTools: readonly ToolId[];
  /** Named skill grants (§5.3). The runtime ACL allows exactly these through `Skill`. */
  readonly skills: readonly string[];
  /**
   * Directories this execution resolves those names from, ahead of the machine-wide roots.
   *
   * Snapshotted rather than recomputed at launch because a skill root is a read grant: "which
   * tree did `Skill(code-review)` come out of" is a question the record has to be able to
   * answer later, and on a machine where a project defines its own `code-review` the answer
   * is not the shipped one.
   */
  readonly skillRoots: readonly string[];
  readonly subagents: readonly SubagentAuthorization[];
  readonly mcpServers: readonly McpServerAuthorization[];
  /**
   * Token count at which each runtime compacts — `null` on a side the role declared none
   * for, where the adapter resolves 90% of that model's window at launch. `null` rather
   * than an absent key: the snapshot has to say "not declared" out loud, the same way it
   * says which tools were withheld. Every runtime keeps its own entry because this snapshot
   * is written before dispatch and does not know which one will run it.
   */
  readonly autoCompactTokens: Readonly<Record<RuntimeId, number | null>>;
  readonly memory: MemoryGrants;
  readonly delegatesTo: readonly AgentId[];
  readonly createdAt: string;
  readonly definitionHash: string;
  readonly policyHash: string;
}

export interface CapsuleMemoryEntry {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly version: number;
}

export interface CapsuleMemoryContext {
  readonly invariantContext: string;
  readonly policyContext: string;
  readonly entries: readonly CapsuleMemoryEntry[];
  readonly diagnostics: ContextDiagnostics;
}

export interface IdentityCapsule {
  readonly executionId: ExecutionId;
  readonly definitionHash: string;
  readonly policyHash: string;
  readonly role: AgentId;
  readonly displayName: string;
  readonly instructions: string;
  readonly task: string;
  readonly activeWorkspace: string;
  readonly memoryContext: CapsuleMemoryContext;
  readonly workflowState: WorkflowExecutionState;
  readonly allowedTools: readonly ToolId[];
  readonly outputContract: {
    readonly name: string;
    readonly schema: Readonly<Record<string, unknown>>;
  };
}

export interface StoredExecutionState {
  readonly executionId: ExecutionId;
  readonly status: "prepared" | WorkflowRunStatus;
  readonly workflow: WorkflowExecutionState;
  readonly policyHash: string;
  readonly createdAt: string;
  readonly output?: unknown;
}

export interface ExecutionArtifactPaths {
  readonly directory: string;
  readonly stateFile: string;
  readonly policyFile: string;
  readonly runtimeDirectory: string;
  /** `context/`, `0700`, survives `runtime/` cleanup — see plan §7. */
  readonly contextDirectory: string;
  readonly checkpointFile: string;
  readonly continuityFile: string;
  readonly compactEventsFile: string;
}

export interface PreparedExecution {
  readonly capsule: IdentityCapsule;
  readonly policy: ExecutionPolicy;
  readonly state: StoredExecutionState;
  readonly artifacts: ExecutionArtifactPaths;
  /**
   * Context Thread đưa sang cho root này (snapshot rev N) — để render vào session context.
   * Không hash, không cấp quyền; `null` khi execution không phải root của Thread nào.
   */
  readonly threadContext?: ThreadContextHandoff | null;
}

/**
 * Vé đã kiểm nhưng chưa tiêu: policy đã đồng ý, chưa gì được tạo ra.
 *
 * `prepare()` từng làm cả hai việc trong một lần gọi, và điều đó buộc thứ tự "kiểm quyền
 * trước, tạo artifact sau" phải đúng nhờ vị trí các dòng code. Tách ra thì thứ tự ấy thành
 * kiểu: không ai gọi được `materialize()` mà không cầm một vé, và vé chỉ ra đời từ một lần
 * `authorize()` đã đi qua đủ mọi cửa.
 *
 * Tách còn mở ra cửa sổ mà graph root cần: giữa lúc quyền đã kiểm và lúc file đầu tiên được
 * ghi, `runMainSession` chen được một node `preparing` vào graph — nên không có khoảnh khắc
 * nào một execution tồn tại trên đĩa mà cây không biết về nó.
 *
 * Các trường ở đây là để đọc và log. Quyền thật nằm trong danh sách vé mà chính service
 * phát hành giữ, nên một object cùng hình dạng dựng bằng tay không đi qua được `materialize()`.
 */
export interface ExecutionAuthorization {
  readonly executionId: ExecutionId;
  readonly parent: AgentId | "principal";
  readonly target: AgentId;
  /** Workspace đã canonicalize — đúng path policy đã duyệt, không phải path caller đưa vào. */
  readonly workspace: string;
  readonly workspaceMode: "read-only" | "workspace-write";
  readonly authorizedAt: string;
}

/** Những gì cần để trả lời "được phép hay không" — và không gì hơn. */
export interface AuthorizeExecutionInput {
  readonly executionId: ExecutionId;
  readonly parent: AgentId | "principal";
  readonly target: AgentId;
  readonly workspace: string;
  readonly workspaceMode: "read-only" | "workspace-write";
}

/**
 * Phần còn lại: nội dung của execution, thứ chỉ có nghĩa sau khi quyền đã xong.
 *
 * Không có trường nào ở đây ảnh hưởng tới quyết định cho phép, nên `materialize()` đọc mọi
 * trường mang quyền từ vé chứ không từ input — caller không đổi được target hay workspace
 * giữa hai bước.
 */
export interface MaterializeExecutionInput {
  readonly task: string;
  /** Thread binding cho snapshot; `null` khi không có Thread. Không ảnh hưởng quyết định cho phép. */
  readonly thread: ExecutionThreadBinding | null;
  /**
   * Snapshot context Thread (rev = `thread.contextRevision`) cho root: seed pins vào checkpoint
   * và mục "Thread context" của session context. Bỏ trống/`null` khi không có gì để tiếp tục.
   */
  readonly threadContext?: ThreadContextHandoff | null;
  /** Bỏ trống thì lấy `DEFAULT_MODE`. */
  readonly mode?: ModeId;
  /** Loadout của nấc sau khi ghép settings; bỏ trống thì bản built-in. */
  readonly modeProfiles?: ModeProfiles;
  readonly memoryQueries: readonly MemoryQuery[];
  readonly characterBudget: number;
  readonly invariantContext: string;
  readonly policyContext: string;
}

export interface PrepareExecutionInput
  extends AuthorizeExecutionInput,
    MaterializeExecutionInput {}

export function deepFreezeExecutionValue<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Reflect.ownKeys(value)) {
    deepFreezeExecutionValue((value as Record<PropertyKey, unknown>)[key]);
  }
  return Object.freeze(value);
}

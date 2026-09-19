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
import type { LaunchScope, PolicyDecision } from "../policy/types";
import type { RuntimeEnforcementCapabilitiesV1 } from "../runtime/capabilities";
import type { ApprovalRecordV1, SessionApprovals } from "./approvals";
import type { ExecutionOutcome } from "./outcome";
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
   * What that runtime was measured to refuse on the platform this execution was prepared
   * on — the row of the table in `runtime/capabilities.ts`, snapshotted and hashed. It
   * records what the runtime honours; it grants nothing.
   */
  readonly enforcement: RuntimeEnforcementCapabilitiesV1;
  /**
   * What the principal said yes to for this execution — `[]` when nothing was asked. In the
   * snapshot, and so in the hash: a launch that was widened by a person is a different
   * identity from one that was not, and the record says which.
   */
  readonly approvals: readonly ApprovalRecordV1[];
  /**
   * The subtrees this execution may write, canonical and sorted — or `null` when the whole
   * workspace is (the only thing a launch could mean before phase 2). In the hash, and
   * therefore explicit: `canonicalize()` drops `undefined`, so an unscoped policy must say
   * `null` or it would collide with one written before scopes existed.
   */
  readonly writeScope: readonly string[] | null;
  /**
   * Directories outside the workspace the machine opened for build and test tools —
   * `~/fvm`, `~/.gradle`, DerivedData (GitHub #25) — canonical and sorted, `[]` when none.
   * In the hash: a launch that may write a toolchain cache is a different identity from one
   * that may not, and a `policy.json` from before this field reads as `[]`, which is what
   * it meant.
   */
  readonly toolchainWritePaths: readonly string[];
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
  /**
   * Kết cục con tự khai qua trailer của output (master plan 2a); vắng khi output không qua
   * được validation hoặc state do `alp` cũ ghi — đọc ra là `unknown`.
   */
  readonly outcome?: ExecutionOutcome;
}

export interface ExecutionArtifactPaths {
  readonly directory: string;
  readonly stateFile: string;
  readonly policyFile: string;
  readonly runtimeDirectory: string;
  /** `context/`, `0700`, survives `runtime/` cleanup — see plan §7. */
  readonly contextDirectory: string;
  /** `relay/`: `alp` chạy trong sandbox của runtime gửi lệnh cho process root qua đây. */
  readonly relayDirectory: string;
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
  /** The approvals this launch was granted on — carried into the policy by `materialize()`. */
  readonly approvals: readonly ApprovalRecordV1[];
  /** The scope policy approved — canonical, sorted, deduplicated — or `null` for the whole workspace. */
  readonly writeScope: readonly string[] | null;
  /** The machine's toolchain write paths, checked against this workspace — see `ExecutionPolicy`. */
  readonly toolchainWritePaths: readonly string[];
  readonly authorizedAt: string;
}

/** Những gì cần để trả lời "được phép hay không" — và không gì hơn. */
export interface AuthorizeExecutionInput {
  readonly executionId: ExecutionId;
  readonly parent: AgentId | "principal";
  readonly target: AgentId;
  readonly workspace: string;
  readonly workspaceMode: "read-only" | "workspace-write";
  /**
   * Where this launch is asked for from — the launcher's own workspace and the project
   * around it. Absent, the workspace check is identity only and no question is ever asked.
   */
  readonly launch?: LaunchScope;
  /**
   * Subtrees of the workspace a `workspace-write` launch is confined to, relative to the
   * workspace or absolute. Each must exist and resolve inside it; an empty list is a
   * contradiction and refused. Absent means the whole workspace.
   */
  readonly writeScope?: readonly string[];
  /** The session's collected approvals, when the launch runs under a root that keeps them. */
  readonly sessionApprovals?: SessionApprovals;
}

/**
 * Who can answer a `require_approval`. Belongs to the *surface* — the root `alp` on a TTY —
 * never to a role: a child of the graph has no principal at its keyboard, and the surface it
 * gets is `NO_APPROVAL_SURFACE`, under which every question is `APPROVAL_UNAVAILABLE`.
 */
export interface ApprovalSurface {
  readonly supportsApproval: boolean;
  /** `true` for yes. Only called when `supportsApproval` is true. */
  ask(decision: Extract<PolicyDecision, { kind: "require_approval" }>): Promise<boolean>;
}

export const NO_APPROVAL_SURFACE: ApprovalSurface = Object.freeze({
  supportsApproval: false,
  ask: async () => false,
});

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

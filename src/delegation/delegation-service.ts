import { DEFAULT_MODE, type ModeId, type ModeProfiles } from "../agents/modes";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentRegistry, RuntimeId } from "../agents/types";
import type { BackendExecutionResult, BackendExecutionStatus, ExecutionBackend } from "../backend/execution-backend";
import type { ExecutionService } from "../execution/execution-service";
import { executionArtifactPaths } from "../execution/execution-store";
import {
  PRINCIPAL_REQUESTER,
  type ChildRequest,
  type ExecutionBinding,
  type ExecutionGraphService,
  type ExecutionProbe,
  type ExecutionTreeView,
  type ProbeStatus,
} from "../execution/graph/execution-graph-service";
import { ExecutionGraphError } from "../execution/graph/errors";
import { findNode, type ExecutionGraphDocument, type ExecutionNode } from "../execution/graph/types";
import type { ExecutionAuthorization, MaterializeExecutionInput, PreparedExecution } from "../execution/types";
import type { MemoryService } from "../memory/memory-service";
import type { PolicyEngine } from "../policy/policy-engine";
import type { RuntimeAdapter, RuntimeLaunchSpec } from "../runtime/runtime-adapter";
import {
  DelegationError,
  type DelegationExecutionRecord,
  type DelegationExecutionStore,
  type DelegationIds,
  type DelegationRequest,
  type DelegationRequestInput,
  type DelegationResult,
} from "./types";

export interface DelegationServiceConfig {
  /** Nấc công suất kế thừa từ phiên cha (`ALP_MODE`); bỏ trống thì `DEFAULT_MODE`. */
  mode?: ModeId;
  /**
   * Loadout đã ghép `settings.json` của máy và của project. Bỏ trống thì chạy bản built-in —
   * nấc nói gì thì vai chạy đúng thế.
   */
  modeProfiles?: ModeProfiles;
}

/**
 * Hai nửa của `ExecutionService`, tách đúng ở chỗ cây cần chen vào.
 *
 * `authorize()` phải chạy trước khi một chỗ được giữ trong cây — một request bị policy từ
 * chối không được phép chiếm slot đồng thời của ai cả. `materialize()` phải chạy sau, vì nó
 * ghi file, và file chỉ được sinh ra khi đã chắc có chỗ cho chúng.
 */
export interface DelegationExecutionAuthorizer {
  authorize(input: Parameters<ExecutionService["authorize"]>[0]): Promise<ExecutionAuthorization>;
  materialize(
    authorization: ExecutionAuthorization,
    input: MaterializeExecutionInput,
  ): Promise<PreparedExecution>;
}

/** Đúng những gì delegation cần ở cây. Hẹp lại để test tiêm được một nửa đáng tin. */
export type DelegationGraph = Pick<
  ExecutionGraphService,
  | "authenticateParent"
  | "cancelSubtree"
  | "reserveChild"
  | "startReservedChild"
  | "releaseReservation"
  | "reconcile"
  | "findGraphFor"
  | "getGraph"
  | "getExecutionTree"
>;

export interface DelegationServiceOptions {
  readonly registry: AgentRegistry;
  readonly policy: Pick<PolicyEngine, "authorize">;
  readonly memory: Pick<MemoryService, "buildContext">;
  readonly executionService: DelegationExecutionAuthorizer;
  readonly graph: DelegationGraph;
  /**
   * Chỗ đứng của **process này** trong cây, đọc từ env một lần lúc dựng.
   *
   * Là thuộc tính của tiến trình chứ không phải của từng request: một process chạy dưới đúng
   * một execution, và để caller truyền nó vào từng lời gọi là trả lại đúng trường mà kẻ tấn
   * công muốn điền. `null` nghĩa là process này không chạy dưới ALP, và nó không giao được
   * việc cho ai.
   */
  readonly binding: ExecutionBinding | null;
  /** `~/.alp/executions` — nơi tra lại artifact của một execution ở process sau. */
  readonly executionsRoot: string;
  readonly runtimeAdapters: ReadonlyMap<RuntimeId, RuntimeAdapter>;
  readonly backend: ExecutionBackend;
  readonly executionStore: DelegationExecutionStore;
  readonly config: DelegationServiceConfig;
  readonly ids?: DelegationIds;
  readonly now?: () => Date;
}

function defaultIds(): DelegationIds {
  return {
    request: () => `req_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
    execution: () => `exec_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
  };
}

/**
 * Chuẩn hoá một lần, ở một chỗ.
 *
 * Fingerprint băm đúng object này, nên `"  search "` và `"search"` phải quy về một giá trị
 * *trước* khi băm — nếu không thì idempotency chỉ đúng với caller nào tình cờ không gõ thừa
 * dấu cách, và một retry sẽ đẻ ra con thứ hai.
 */
function normalizeRequest(input: DelegationRequestInput, ids: DelegationIds): DelegationRequest {
  for (const [name, value] of [
    ["targetRole", input?.targetRole],
    ["task", input?.task],
    ["workspace", input?.workspace],
  ] as const) {
    if (typeof value !== "string" || !value.trim()) {
      throw new DelegationError("INVALID_REQUEST", `delegation request requires ${name}`);
    }
  }
  const timeoutMs = input.executionOptions?.timeoutMs ?? null;
  if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new DelegationError("INVALID_REQUEST", "timeoutMs must be positive");
  }
  return Object.freeze({
    requestId: input.requestId?.trim() || ids.request(),
    targetRole: input.targetRole.trim(),
    task: input.task.trim(),
    workspace: input.workspace,
    workspaceMode: input.workspaceMode ?? "read-only",
    metadata: Object.freeze({ ...(input.metadata ?? {}) }),
    executionOptions: Object.freeze({
      background: Boolean(input.executionOptions?.background),
      interactive: Boolean(input.executionOptions?.interactive),
      timeoutMs,
    }),
  });
}

/** Trạng thái node quy về từ vựng của backend, cho những caller chỉ biết từ vựng đó. */
function backendStatusOf(status: ExecutionNode["status"]): BackendExecutionStatus {
  switch (status) {
    case "preparing":
      return "queued";
    case "queued":
      return "queued";
    case "running":
    case "cancelling":
      return "running";
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    // `interrupted` không có từ tương ứng: nó là một execution đã chết mà không ai ghi lại
    // kết cục, và câu gần nhất backend nói được là "hỏng".
    default:
      return "failed";
  }
}

async function removeTemporaryFiles(spec: RuntimeLaunchSpec): Promise<void> {
  await Promise.all(spec.temporaryFiles.map((file) => rm(file, { force: true })));
}

export class InMemoryDelegationExecutionStore implements DelegationExecutionStore {
  private readonly records = new Map<string, DelegationExecutionRecord>();
  put(record: DelegationExecutionRecord): void {
    if (this.records.has(record.executionId)) throw new Error(`duplicate execution \`${record.executionId}\``);
    this.records.set(record.executionId, Object.freeze({ ...record }));
  }
  get(executionId: string): DelegationExecutionRecord | null {
    return this.records.get(executionId) ?? null;
  }
  update(executionId: string, patch: Partial<Pick<DelegationExecutionRecord, "status" | "error">>): void {
    const current = this.records.get(executionId);
    if (!current) throw new DelegationError("EXECUTION_NOT_FOUND", `execution \`${executionId}\` does not exist`);
    this.records.set(executionId, Object.freeze({ ...current, ...patch }));
  }
  list(): readonly DelegationExecutionRecord[] {
    return Object.freeze([...this.records.values()]);
  }
}

export class FileDelegationExecutionStore implements DelegationExecutionStore {
  private readonly file: string;

  constructor(options: { readonly file: string }) {
    this.file = options.file;
  }

  put(record: DelegationExecutionRecord): void {
    const records = this.read();
    if (records.some((entry) => entry.executionId === record.executionId)) {
      throw new Error(`duplicate execution \`${record.executionId}\``);
    }
    records.push(Object.freeze({ ...record }));
    this.write(records);
  }

  get(executionId: string): DelegationExecutionRecord | null {
    return this.read().find((record) => record.executionId === executionId) ?? null;
  }

  update(executionId: string, patch: Partial<Pick<DelegationExecutionRecord, "status" | "error">>): void {
    const records = this.read();
    const index = records.findIndex((record) => record.executionId === executionId);
    if (index < 0) throw new DelegationError("EXECUTION_NOT_FOUND", `execution \`${executionId}\` does not exist`);
    records[index] = Object.freeze({ ...records[index], ...patch });
    this.write(records);
  }

  list(): readonly DelegationExecutionRecord[] {
    return Object.freeze(this.read());
  }

  private read(): DelegationExecutionRecord[] {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as { version?: unknown; executions?: unknown };
      if (parsed.version !== 1 || !Array.isArray(parsed.executions)) throw new Error("invalid delegation execution store");
      return parsed.executions.map((record) => Object.freeze({ ...(record as DelegationExecutionRecord) }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private write(records: readonly DelegationExecutionRecord[]): void {
    const directory = dirname(this.file);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const temporary = join(directory, `.${randomUUID()}.executions.tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify({ version: 1, executions: records }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(temporary, this.file);
      chmodSync(this.file, 0o600);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

export class DelegationService {
  readonly config: DelegationServiceConfig;
  private readonly registry: AgentRegistry;
  private readonly policy: Pick<PolicyEngine, "authorize">;
  private readonly memory: Pick<MemoryService, "buildContext">;
  private readonly executionService: DelegationExecutionAuthorizer;
  private readonly graph: DelegationGraph;
  private readonly binding: ExecutionBinding | null;
  private readonly executionsRoot: string;
  private readonly runtimeAdapters: ReadonlyMap<RuntimeId, RuntimeAdapter>;
  private readonly backend: ExecutionBackend;
  private readonly executionStore: DelegationExecutionStore;
  private readonly ids: DelegationIds;
  private readonly now: () => Date;

  constructor(options: DelegationServiceOptions) {
    this.registry = options.registry;
    this.policy = options.policy;
    this.memory = options.memory;
    this.executionService = options.executionService;
    this.graph = options.graph;
    this.binding = options.binding;
    this.executionsRoot = options.executionsRoot;
    this.runtimeAdapters = options.runtimeAdapters;
    this.backend = options.backend;
    this.executionStore = options.executionStore;
    this.config = options.config;
    this.ids = options.ids ?? defaultIds();
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Giao một việc cho một vai khác, dưới đúng cây mà process này đang đứng trong đó.
   *
   * Thứ tự ở đây là toàn bộ nội dung của phase này, và mỗi bước đứng trước bước sau vì một
   * lý do cụ thể: xác thực cha trước khi biết cha là ai; hỏi policy trước khi chiếm một chỗ
   * trong cây; giữ chỗ trước khi ghi file; ghi file trước khi hỏi backend; và đăng ký process
   * *dưới lease* của cây, để không có khoảnh khắc nào một process tồn tại mà cây chưa biết.
   */
  async delegate(input: DelegationRequestInput): Promise<DelegationResult> {
    const binding = this.requireBinding();
    const request = normalizeRequest(input, this.ids);
    const parent = await this.graph.authenticateParent(binding);

    // Trước reservation, trước mọi file: một request bị policy từ chối không được phép chiếm
    // một slot đồng thời, dù chỉ trong khoảng thời gian nó mất để bị từ chối.
    const executionId = this.ids.execution();
    const authorization = await this.executionService.authorize({
      executionId,
      parent: parent.node.agentId,
      target: request.targetRole,
      workspace: request.workspace,
      workspaceMode: request.workspaceMode,
    });

    // Trần được tính trên một cây đã đối chiếu với backend. Bỏ bước này thì một cây còn đầy
    // node `running` ma sau một lần reboot sẽ từ chối mọi lần giao việc tiếp theo.
    await this.reconcileGraph(binding.graphId);

    const reservation = await this.graph.reserveChild(binding, this.childRequest(request), {
      executionId,
    });
    if (reservation.kind === "existing") {
      // Cùng một request đã thành node từ lần gọi trước. Một retry nhận lại đúng con cũ —
      // đẻ thêm một con thứ hai cho cùng một yêu cầu là cách một lần mất kết nối biến thành
      // hai process cùng sửa một workspace.
      return this.describe(reservation.node.executionId);
    }

    const mode = this.config.mode ?? DEFAULT_MODE;
    let launchSpec: RuntimeLaunchSpec | null = null;
    let execution: PreparedExecution;
    let runtime: RuntimeId;
    try {
      execution = await this.executionService.materialize(authorization, {
        task: request.task,
        mode,
        ...(this.config.modeProfiles === undefined ? {} : { modeProfiles: this.config.modeProfiles }),
        memoryQueries: [],
        characterBudget: 0,
        invariantContext: "ALP execution policy is authoritative and fails closed.",
        policyContext: "Use only the tools and workspace granted by the immutable execution snapshot.",
      });
      // Nấc ghim một model cho vai đích, và model quyết định CLI — cả ba giá trị đọc thẳng từ
      // snapshot, vì `policy.json` đã chốt và đã băm chúng.
      runtime = execution.policy.runtime;
      const adapter = this.runtimeAdapters.get(runtime);
      if (!adapter) {
        throw new DelegationError("RUNTIME_UNAVAILABLE", `runtime \`${runtime}\` is not registered`);
      }
      launchSpec = await adapter.prepare({
        execution,
        model: execution.policy.model,
        reasoningEffort: execution.policy.reasoningEffort,
        interactive: request.executionOptions.interactive,
        // Con nhận chỗ đứng của nó qua env, và cùng một deadline tuyệt đối mà cây đã chốt ở
        // root: hạn không cộng dồn theo tầng, nên một cây sâu hai tầng không sống gấp ba.
        binding: reservation.binding,
      });
      const health = await this.backend.healthCheck();
      if (!health.ok) throw new DelegationError("BACKEND_UNAVAILABLE", health.message);
    } catch (error) {
      // Chỗ đã giữ được trả lại ngay: hỏng ở đây là hỏng *trước* khi có process, nên giữ nó
      // thêm hai phút cho tới lúc TTL hết chỉ làm cây chật một cách vô ích.
      await this.graph.releaseReservation(binding.graphId, reservation.reservationId)
        .catch(() => undefined);
      if (launchSpec) await removeTemporaryFiles(launchSpec).catch(() => undefined);
      throw error;
    }

    try {
      const spawned = await this.graph.startReservedChild(reservation, async () =>
        this.backend.spawn({
          executionId,
          launchSpec: launchSpec as RuntimeLaunchSpec,
          lifecycle: {
            requestId: request.requestId,
            parentExecutionId: parent.node.executionId,
            background: request.executionOptions.background,
            interactive: request.executionOptions.interactive,
            timeoutMs: request.executionOptions.timeoutMs,
            // Hạn của cây, không phải hạn của lần gọi này: backend giết process đúng lúc
            // graph coi nó đã hết hạn, nên không có process nào sống lâu hơn cây của nó.
            deadlineAt: binding.deadlineAt,
          },
        }));
      return this.result(
        {
          executionId,
          requestId: request.requestId,
          parentExecutionId: parent.node.executionId,
          parentRole: parent.node.agentId,
          targetRole: request.targetRole,
          workspace: execution.policy.workspace,
          runtime,
          backend: this.backend.name,
          createdAt: this.now().toISOString(),
          status: spawned.status,
          executionStateFile: execution.artifacts.stateFile,
        },
        spawned,
      );
    } catch (error) {
      // Cây đã ghi node là `failed` dưới lease của nó; ở đây chỉ còn rác trên đĩa.
      await removeTemporaryFiles(launchSpec).catch(() => undefined);
      throw error;
    }
  }

  async status(executionId: string): Promise<DelegationResult> {
    const record = await this.lifecycleRecord(executionId);
    const value = await this.backendResult(executionId, record);
    const result = this.result(record, value);
    this.rememberLegacyStatus(record, result.status);
    return result;
  }

  async wait(executionId: string, options: { readonly timeoutMs?: number | null } = {}): Promise<DelegationResult> {
    const record = await this.lifecycleRecord(executionId);
    const value = await this.backendResult(executionId, record, () => this.backend.wait(executionId, options));
    const result = this.result(record, value);
    this.rememberLegacyStatus(record, result.status);
    return result;
  }

  /**
   * Dừng một execution, và cùng với nó cả nhánh nó đã giao việc xuống.
   *
   * Huỷ mỗi node được nhắm tên là để lại một rừng process mồ côi đang ghi vào cùng workspace,
   * không còn ai chờ kết quả của chúng và không còn ai trong cây trỏ tới chúng. Cây biết
   * nhánh đó gồm những ai; backend thì không.
   *
   * Execution của bản cũ không nằm trong cây nào, nên vẫn đi thẳng tới backend: chúng không
   * có nhánh nào bên dưới để mà dừng.
   */
  async cancel(executionId: string): Promise<DelegationResult> {
    const record = await this.lifecycleRecord(executionId);
    const graph = await this.graph.findGraphFor(executionId);
    if (!graph) {
      const value = await this.backend.cancel(executionId);
      this.rememberLegacyStatus(record, value.status);
      return this.result(record, value);
    }
    await this.graph.cancelSubtree(
      {
        graphId: graph.graphId,
        executionId,
        reason: "USER_REQUEST",
        // Một lệnh từ trong cây mang execution ID của người gọi; `alp delegation cancel` gõ
        // ở terminal thì không có ID nào để mang.
        requestedBy: this.binding?.executionId ?? PRINCIPAL_REQUESTER,
      },
      async (target: string) => {
        await this.backend.cancel(target);
      },
    );
    // Hỏi lại backend sau khi tín hiệu đã bay đi: node nào backend đã ghi terminal thì cây
    // nhận đúng kết cục đó thay vì `cancelled` mặc định.
    const reconciled = await this.reconcileGraph(graph.graphId);
    const node = findNode(reconciled, executionId);
    const status = node ? backendStatusOf(node.status) : "cancelled";
    this.rememberLegacyStatus(record, status);
    return this.result(record, { executionId, status });
  }

  /**
   * Cả cây quanh một execution, sau khi đã hỏi lại backend.
   *
   * Reconcile trước khi vẽ, vì cái người vận hành nhìn vào để quyết định có huỷ hay không
   * phải là trạng thái bây giờ: một cây toàn node `running` ma — process đã chết trong một
   * lần reboot mà không ai kịp ghi — đọc hệt như một cây đang làm việc.
   */
  async tree(executionId: string): Promise<ExecutionTreeView> {
    const graph = await this.graph.findGraphFor(executionId);
    if (!graph) {
      // Execution của bản cũ không thuộc cây nào. Nói thẳng thế, chứ không vẽ một cây một
      // node: nó không có nhánh nào bên dưới, và giả vờ có cây là hứa một thứ bảo đảm mà
      // riêng nó không được hưởng.
      throw new DelegationError(
        "EXECUTION_NOT_FOUND",
        `execution \`${executionId}\` is not part of an execution graph; it was started by an older \`alp\``,
      );
    }
    await this.reconcileGraph(graph.graphId);
    return this.graph.getExecutionTree(executionId);
  }

  /**
   * Trả lại đĩa và bảng process mà một execution đã xong còn giữ.
   *
   * Chỉ state của backend: file tạm, result file, spec, dòng trong `local.json`. Node trong
   * cây và kết cục nó ghi thì ở lại — cây là sổ sách, và một `alp delegation cleanup` không
   * được làm mất lịch sử mà `alp delegation tree` đang dựa vào để trả lời "nhánh này đã chạy
   * chưa".
   *
   * Một execution còn sống thì không dọn: xoá bản ghi backend của một process đang chạy là
   * cắt đúng sợi dây duy nhất còn giết được nó, và lần reconcile sau sẽ đọc nó thành
   * `interrupted` trong khi nó vẫn đang ghi vào workspace.
   */
  async cleanup(executionId: string): Promise<DelegationResult> {
    const record = await this.lifecycleRecord(executionId);
    if (record.status === "queued" || record.status === "running") {
      throw new DelegationError(
        "INVALID_REQUEST",
        `execution \`${executionId}\` is still ${record.status}; cancel it before cleaning up`,
      );
    }
    try {
      await this.backend.cleanup(executionId);
    } catch (error) {
      // Backend quên trước cây: máy khởi động lại, `local.json` bị dọn. Không còn gì để trả
      // lại thì lệnh đã đạt được điều nó hứa, nên nó không dựng lên một lỗi.
      if ((error as { readonly code?: unknown })?.code !== "EXECUTION_NOT_FOUND") throw error;
    }
    return this.result(record, { executionId, status: record.status });
  }

  listExecutions(): readonly DelegationExecutionRecord[] {
    return this.executionStore.list();
  }

  /**
   * Nơi execution này được quản: cây, hay legacy store.
   *
   * Cây là thẩm quyền logic, nên nó được hỏi trước và một lần duy nhất. Legacy store chỉ trả
   * lời khi không cây nào chứa execution — nghĩa là nó được mở bằng một bản `alp` cũ hơn, và
   * nó phải kết thúc được ở bản này.
   */
  private async lifecycleRecord(executionId: string): Promise<DelegationExecutionRecord> {
    const graph = await this.graph.findGraphFor(executionId);
    if (!graph) return this.record(executionId);
    const reconciled = await this.reconcileGraph(graph.graphId);
    const node = findNode(reconciled, executionId);
    if (!node) {
      throw new DelegationError("EXECUTION_NOT_FOUND", `execution \`${executionId}\` does not exist`);
    }
    return this.graphRecord(reconciled, node);
  }

  /** Kết quả của một execution do cây quản, không đi qua backend. */
  private async describe(executionId: string): Promise<DelegationResult> {
    const record = await this.lifecycleRecord(executionId);
    return this.result(record, { executionId, status: record.status });
  }

  private async reconcileGraph(graphId: string): Promise<ExecutionGraphDocument> {
    return this.graph.reconcile(graphId, this.probe);
  }

  /**
   * Backend nói gì về một execution, dịch sang từ vựng của cây.
   *
   * `EXECUTION_NOT_FOUND` là `missing` — backend tra được và không có gì. Mọi lỗi khác là
   * `unknown`: một lần đọc hỏng không phải là bằng chứng rằng process đã chết, và đối xử với
   * nó như thế là cách cả một cây đang chạy bị khai tử trong một nhịp I/O xấu.
   */
  private readonly probe: ExecutionProbe = async (executionId) => {
    try {
      const value = await this.backend.status(executionId);
      switch (value.status) {
        case "queued":
        case "running":
          return "active" satisfies ProbeStatus;
        case "completed":
          return "completed";
        case "cancelled":
          // Cùng một `cancelled` trên dây, hai chuyện khác hẳn nhau: người dùng bấm dừng,
          // hay đồng hồ của cây đã hết. Chỉ metadata phân biệt được, và cây cần biết.
          return value.metadata?.terminationReason === "deadline" ? "expired" : "cancelled";
        default:
          return "failed";
      }
    } catch (error) {
      return (error as { readonly code?: unknown })?.code === "EXECUTION_NOT_FOUND"
        ? "missing"
        : "unknown";
    }
  };

  /**
   * Backend được hỏi, nhưng cây có tiếng nói cuối cùng khi backend đã quên.
   *
   * Một execution đã terminal sống trong cây lâu hơn trong bảng process của backend — record
   * của nó bị dọn, máy khởi động lại. `alp delegation status` vẫn phải trả lời được, và câu
   * trả lời đúng là câu cây đang giữ.
   */
  private async backendResult(
    executionId: string,
    record: DelegationExecutionRecord,
    query: () => Promise<BackendExecutionResult> = () => this.backend.status(executionId),
  ): Promise<BackendExecutionResult> {
    try {
      return await query();
    } catch (error) {
      const managed = await this.graph.findGraphFor(executionId);
      if (!managed || (error as { readonly code?: unknown })?.code !== "EXECUTION_NOT_FOUND") {
        throw error;
      }
      return { executionId, status: record.status };
    }
  }

  /**
   * Bản ghi lifecycle của một node, ghép từ cây và snapshot trên đĩa.
   *
   * Cây giữ đúng những gì nó có quyền giữ — quan hệ, trạng thái, thời điểm. `workspace` và
   * `runtime` thì đọc lại từ `policy.json`, vì đó là bản đã được băm cùng execution: chép
   * chúng vào cây là tạo ra một bản thứ hai có thể lệch khỏi bản mà process thật đang chạy.
   */
  private graphRecord(
    graph: ExecutionGraphDocument,
    node: ExecutionNode,
  ): DelegationExecutionRecord {
    const paths = executionArtifactPaths(this.executionsRoot, node.executionId);
    let snapshot: { readonly workspace?: unknown; readonly runtime?: unknown };
    try {
      snapshot = JSON.parse(readFileSync(paths.policyFile, "utf8")) as typeof snapshot;
    } catch (error) {
      throw new DelegationError(
        "EXECUTION_NOT_FOUND",
        `execution \`${node.executionId}\` has no readable policy snapshot`,
        { cause: error },
      );
    }
    const parent = node.parentExecutionId ? findNode(graph, node.parentExecutionId) : null;
    return Object.freeze({
      executionId: node.executionId,
      requestId: node.requestId ?? node.executionId,
      parentExecutionId: node.parentExecutionId,
      parentRole: parent?.agentId ?? "principal",
      targetRole: node.agentId,
      workspace: String(snapshot.workspace ?? ""),
      runtime: snapshot.runtime as RuntimeId,
      backend: this.backend.name,
      createdAt: node.createdAt,
      status: backendStatusOf(node.status),
      executionStateFile: paths.stateFile,
      ...(node.error ? { error: node.error.message } : {}),
    });
  }

  private childRequest(request: DelegationRequest): ChildRequest {
    return {
      requestId: request.requestId,
      agentId: request.targetRole,
      task: request.task,
      workspace: request.workspace,
      workspaceMode: request.workspaceMode,
      // Nấc nằm trong fingerprint vì nấc quyết định model: cùng một câu hỏi ở `puck` và ở
      // `ultra` là hai việc khác nhau, và một retry đổi nấc phải được đẻ ra con mới.
      mode: this.config.mode ?? DEFAULT_MODE,
      background: request.executionOptions.background,
      interactive: request.executionOptions.interactive,
      timeoutMs: request.executionOptions.timeoutMs,
      metadata: request.metadata,
    };
  }

  /**
   * Process này đứng ở đâu trong cây — hoặc không đứng ở đâu cả.
   *
   * Không có fallback nào ở đây, và đó là chủ ý: một `alp delegate` gõ từ terminal trần
   * không có cha, và một cây suy ra từ `ALP_ROLE` là một cây mà bất kỳ ai cũng dựng được.
   */
  private requireBinding(): ExecutionBinding {
    if (!this.binding) {
      throw new ExecutionGraphError(
        "PARENT_EXECUTION_REQUIRED",
        "delegation requires an authenticated parent execution; run it from inside an ALP session",
      );
    }
    return this.binding;
  }

  /** Legacy store chỉ được cập nhật cho những execution nó còn quản. */
  private rememberLegacyStatus(
    record: DelegationExecutionRecord,
    status: BackendExecutionStatus,
  ): void {
    if (this.executionStore.get(record.executionId)) {
      this.executionStore.update(record.executionId, { status });
    }
  }

  private record(executionId: string): DelegationExecutionRecord {
    const record = this.executionStore.get(executionId);
    if (!record) throw new DelegationError("EXECUTION_NOT_FOUND", `execution \`${executionId}\` does not exist`);
    return record;
  }

  private result(record: DelegationExecutionRecord, value: BackendExecutionResult): DelegationResult {
    let status = value.status;
    let output = value.output;
    if (["completed", "failed", "cancelled"].includes(value.status) && record.executionStateFile) {
      try {
        const state = JSON.parse(readFileSync(record.executionStateFile, "utf8")) as { status?: unknown; output?: unknown };
        if (["completed", "failed", "cancelled"].includes(String(state.status))) {
          status = state.status as BackendExecutionStatus;
        }
        // Roles answer in prose, so the common case is already a string. Wrapping it in
        // JSON would hand the caller an escaped blob instead of the report.
        if (state.output !== undefined) {
          output = typeof state.output === "string" ? state.output : JSON.stringify(state.output);
        }
      } catch { /* backend result remains authoritative when state is unavailable */ }
    }
    void this.policy;
    void this.memory;
    void this.registry;
    return Object.freeze({
      executionId: record.executionId,
      requestId: record.requestId,
      status,
      ...(output === undefined ? {} : { output }),
      ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode }),
      ...(value.signal === undefined ? {} : { signal: value.signal }),
      ...(value.error === undefined ? {} : { error: value.error }),
      metadata: Object.freeze({ ...(value.metadata ?? {}), backend: record.backend, runtime: record.runtime }),
    });
  }
}

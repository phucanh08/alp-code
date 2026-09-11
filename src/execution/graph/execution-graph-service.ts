import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { AgentId } from "../../agents/types";
import type { ExecutionId } from "../types";
import { DEFAULT_EXECUTION_GRAPH_LIMITS, QUEUED_STARTUP_GRACE_MS } from "./defaults";
import { ExecutionGraphError } from "./errors";
import type { ExecutionGraphLease, ExecutionGraphStore } from "./execution-graph-store";
import {
  assertChildCapacity,
  assertWithinDeadline,
  liveReservations,
} from "./execution-limiter";
import {
  ancestorsOf,
  findNode,
  isActiveNodeStatus,
  isTerminalNodeStatus,
  subtreeOf,
  type CancellationReason,
  type CancellationRecord,
  type ExecutionGraphDocument,
  type ExecutionGraphId,
  type ExecutionGraphLimits,
  type ExecutionNode,
  type ExecutionNodeError,
  type ExecutionNodeStatus,
  type ExecutionReservation,
} from "./types";

/**
 * Bốn biến môi trường nói cho một process biết nó là ai trong cây.
 *
 * `ALP_ROLE` và `ALP_DELEGATED_ROLE` đã có từ trước và vẫn còn — nhưng chúng là *nhãn*, mọi
 * process sửa được trước khi gọi `alp delegate`. Bộ này thì khác ở chỗ `ALP_EXECUTION_CAPABILITY`:
 * sửa nó chỉ làm yêu cầu bị từ chối, vì graph giữ hash của đúng giá trị đã phát cho node đó.
 */
export const EXECUTION_BINDING_ENV = Object.freeze({
  graphId: "ALP_EXECUTION_GRAPH_ID",
  executionId: "ALP_DELEGATION_EXECUTION_ID",
  capability: "ALP_EXECUTION_CAPABILITY",
  deadlineAt: "ALP_EXECUTION_DEADLINE_AT",
} as const);

/**
 * Chỗ đứng của một execution trong cây, cộng cái chứng minh nó đứng ở đó.
 *
 * `capability` là plaintext và chỉ sống trong bộ nhớ process đã tạo node cùng env của process
 * con. Nó không đi vào `policy.json`, capsule, state snapshot hay bất kỳ file sinh ra nào —
 * graph chỉ giữ SHA-256 của nó (invariant 7).
 */
export interface ExecutionBinding {
  readonly graphId: ExecutionGraphId;
  readonly executionId: ExecutionId;
  readonly capability: string;
  readonly deadlineAt: string;
}

export interface RootExecution {
  readonly binding: ExecutionBinding;
  readonly graph: ExecutionGraphDocument;
  readonly node: ExecutionNode;
}

export interface ExecutionOutcome {
  readonly status: Extract<
    ExecutionNodeStatus,
    "completed" | "failed" | "cancelled" | "interrupted"
  >;
  readonly error?: ExecutionNodeError;
}

export interface ExecutionGraphServiceOptions {
  readonly store: ExecutionGraphStore;
  /** Test tiêm trần nhỏ hơn; production luôn chạy `DEFAULT_EXECUTION_GRAPH_LIMITS`. */
  readonly limits?: ExecutionGraphLimits;
  readonly now?: () => Date;
  readonly newExecutionId?: () => ExecutionId;
  readonly newReservationId?: () => string;
  readonly newCapability?: () => string;
}

/** Mã lỗi ghi vào node khi root chết trước khi có process. */
const ROOT_START_FAILED = "ROOT_START_FAILED";

/** Cùng chuyện đó ở một con: `backend.spawn()` hỏng dứt khoát trước khi có process. */
const CHILD_START_FAILED = "CHILD_START_FAILED";

/** `queued` quá lâu mà backend chưa từng biết tới nó — caller đã chết giữa chừng. */
const EXECUTION_NEVER_STARTED = "EXECUTION_NEVER_STARTED";

/** Có process, rồi không còn, và không ai ghi lại kết cục. */
const EXECUTION_INTERRUPTED = "EXECUTION_INTERRUPTED";

export function hashCapability(capability: string): string {
  return createHash("sha256").update(capability, "utf8").digest("hex");
}

/**
 * So capability với hash đã lưu trong thời gian không phụ thuộc nội dung.
 *
 * Hash là công khai (nó nằm trong graph, và `alp delegation tree` in graph ra), nên so sánh
 * tắt sớm ở đây cho phép dò từng byte một capability hợp lệ bằng cách đo thời gian. Hai digest
 * luôn dài bằng nhau nên `timingSafeEqual` không bao giờ ném vì độ dài.
 */
export function capabilityMatches(expectedHash: string, capability: string): boolean {
  const expected = Buffer.from(expectedHash, "hex");
  const actual = Buffer.from(hashCapability(capability), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function bindingEnvironment(binding: ExecutionBinding): Record<string, string> {
  return {
    [EXECUTION_BINDING_ENV.graphId]: binding.graphId,
    [EXECUTION_BINDING_ENV.executionId]: binding.executionId,
    [EXECUTION_BINDING_ENV.capability]: binding.capability,
    [EXECUTION_BINDING_ENV.deadlineAt]: binding.deadlineAt,
  };
}

/**
 * Binding mà process này thừa hưởng, hoặc `null` nếu nó không chạy dưới ALP.
 *
 * Thiếu một biến là không có binding, chứ không phải một binding khuyết: một nửa binding chỉ
 * có thể dẫn tới việc đoán nốt nửa kia, và thứ bị đoán ở đây là identity.
 */
export function readBindingFromEnvironment(
  env: NodeJS.ProcessEnv,
): ExecutionBinding | null {
  const graphId = env[EXECUTION_BINDING_ENV.graphId];
  const executionId = env[EXECUTION_BINDING_ENV.executionId];
  const capability = env[EXECUTION_BINDING_ENV.capability];
  const deadlineAt = env[EXECUTION_BINDING_ENV.deadlineAt];
  if (!graphId || !executionId || !capability || !deadlineAt) return null;
  return Object.freeze({ graphId, executionId, capability, deadlineAt });
}

function errorRecord(error: unknown, fallbackCode: string): ExecutionNodeError {
  const code = (error as { readonly code?: unknown })?.code;
  return {
    code: typeof code === "string" && code.length > 0 ? code : fallbackCode,
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Một yêu cầu delegation sau khi đã chuẩn hoá — đúng những trường quyết định "hai lần gọi
 * này có phải cùng một việc không", không hơn.
 *
 * Vai *gọi* không có mặt ở đây: nó được suy ra từ node của cha, không nhận từ lời khai
 * (invariant 2). `requestId` cũng không: fingerprint trả lời "việc gì", `requestId` trả lời
 * "lần gọi nào", và trộn hai câu vào một hash thì luật `REQUEST_ID_CONFLICT` — cùng ID, khác
 * việc — không còn phát biểu được.
 */
export interface ChildRequest {
  readonly requestId: string;
  /** Vai đích. */
  readonly agentId: AgentId;
  readonly task: string;
  readonly workspace: string;
  readonly workspaceMode: "read-only" | "workspace-write";
  /** Nấc công suất đã chọn cho con. Đổi nấc là đổi model, nên nó là một việc khác. */
  readonly mode: string;
  readonly background: boolean;
  readonly interactive: boolean;
  readonly timeoutMs: number | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** Context string của HMAC. Đổi nó là đổi mọi capability con, nên version nằm trong tên. */
export const CHILD_CAPABILITY_CONTEXT = "alp-execution-capability-v1";

/**
 * Capability của con, dẫn xuất từ capability của cha.
 *
 * Dẫn xuất chứ không random, vì một retry của cùng một request phải ra đúng giá trị cũ: nếu
 * không thì process nào mất bản ghi trong bộ nhớ sẽ không bao giờ nói chuyện lại được với con
 * nó đã đẻ, và cây có một node không ai còn quyền kết thúc. Vì đây là HMAC dưới khoá của cha,
 * chỉ ai đang cầm capability của cha mới tính được — người đọc graph chỉ thấy hash.
 */
export function deriveChildCapability(
  parentCapability: string,
  graphId: ExecutionGraphId,
  childExecutionId: ExecutionId,
): string {
  return createHmac("sha256", parentCapability)
    .update(`${CHILD_CAPABILITY_CONTEXT}\0${graphId}\0${childExecutionId}`, "utf8")
    .digest("base64url");
}

/** Binding của một con, tính từ binding của cha. Không chạm đĩa, không cần lease. */
export function childBinding(
  parent: ExecutionBinding,
  childExecutionId: ExecutionId,
): ExecutionBinding {
  return Object.freeze({
    graphId: parent.graphId,
    executionId: childExecutionId,
    capability: deriveChildCapability(parent.capability, parent.graphId, childExecutionId),
    deadlineAt: parent.deadlineAt,
  });
}

/**
 * JSON với khoá đã sắp xếp ở mọi tầng.
 *
 * `JSON.stringify` giữ nguyên thứ tự chèn khoá, nên cùng một nội dung viết theo hai thứ tự
 * khác nhau ra hai chuỗi khác nhau — và fingerprint sẽ bảo rằng một yêu cầu là hai yêu cầu,
 * biến idempotency thành một lời hứa chỉ đúng khi caller tình cờ viết đúng thứ tự. Khoá mang
 * `undefined` bị bỏ, để "không truyền" và "truyền undefined" băm ra cùng một thứ.
 */
function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

/** Danh tính nội dung của một yêu cầu: cha nào, giao ai, làm gì, ở đâu, quyền gì, chạy sao. */
export function requestFingerprint(
  parentExecutionId: ExecutionId,
  request: ChildRequest,
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        parentExecutionId,
        agentId: request.agentId,
        task: request.task,
        workspace: request.workspace,
        workspaceMode: request.workspaceMode,
        mode: request.mode,
        background: request.background,
        interactive: request.interactive,
        timeoutMs: request.timeoutMs,
        metadata: request.metadata,
      }),
      "utf8",
    )
    .digest("hex");
}

/** Một node đã xác thực, cùng bản graph mà nó được đọc ra. */
export interface AuthenticatedExecution {
  readonly graph: ExecutionGraphDocument;
  readonly node: ExecutionNode;
}

/** Chỗ đã giữ, chưa commit: caller còn phải dựng artifact rồi mới `startReservedChild()`. */
export interface ReservedChild {
  readonly kind: "reserved";
  readonly reservationId: string;
  readonly requestFingerprint: string;
  readonly binding: ExecutionBinding;
  readonly parentExecutionId: ExecutionId;
  readonly agentId: AgentId;
  readonly depth: number;
}

/** Cùng một request đã thành node từ lần gọi trước — retry không được spawn lần nữa. */
export interface ExistingChild {
  readonly kind: "existing";
  readonly node: ExecutionNode;
  readonly binding: ExecutionBinding;
}

export type ChildReservation = ReservedChild | ExistingChild;

/**
 * Backend nói gì về một execution, đã lược về đúng phần cây cần biết.
 *
 * `unknown` là "không tra được", khác hẳn `missing` là "tra được, và không có". Gộp hai cái
 * đó là cách một backend tạm không trả lời biến cả cây thành orphan và trả sạch slot về cho
 * người gọi tiếp theo, trong khi mọi process vẫn đang chạy.
 */
export type ProbeStatus =
  | "missing"
  | "active"
  | "completed"
  | "failed"
  | "cancelled"
  /**
   * Backend đã giết process vì hết hạn.
   *
   * Tách khỏi `cancelled` vì hai chuyện này đọc giống nhau trên đĩa mà nghĩa thì trái ngược:
   * một cái là người dùng đổi ý, một cái là cây chạm trần tuổi thọ của nó. Gộp lại thì
   * `alp delegation tree` không nói được vì sao một nhánh dừng, và không ai biết có phải
   * nâng `wallClockMs` hay không.
   */
  | "expired"
  | "unknown";

export type ExecutionProbe = (executionId: ExecutionId) => Promise<ProbeStatus>;

/** Gửi lệnh dừng tới process của một execution. Ném khi backend không nhận được lệnh. */
export type ExecutionCanceller = (executionId: ExecutionId) => Promise<void>;

/** Ai ra lệnh huỷ, khi lệnh không đến từ một node nào trong cây. */
export const PRINCIPAL_REQUESTER = "principal";

export interface CancelSubtreeInput {
  readonly graphId: ExecutionGraphId;
  readonly executionId: ExecutionId;
  readonly reason: CancellationReason;
  /** Execution ID đã yêu cầu, hoặc `principal` khi lệnh đến từ CLI. */
  readonly requestedBy: string;
}

/** Trạng thái mà một node còn được phép đẻ con. `cancelling` thì không. */
const PARENT_ACTIVE_STATUSES: readonly ExecutionNodeStatus[] = ["preparing", "queued", "running"];

/** Node có thể đã có record ở backend. `preparing` thì chưa bao giờ chạm tới backend. */
const PROBED_STATUSES: readonly ExecutionNodeStatus[] = ["queued", "running", "cancelling"];

/**
 * Bao nhiêu execution được hỏi backend cùng lúc trong một lần reconcile.
 *
 * Có trần vì reconcile chạy trước *mọi* lệnh lifecycle: hỏi tuần tự thì một cây tám node bắt
 * `alp delegate` chờ tám vòng round-trip trước khi làm gì, còn hỏi hết cùng lúc thì một máy
 * đang tải nặng nhận tám lần đọc file kết quả trong một nhịp.
 */
const RECONCILE_CONCURRENCY = 4;
/**
 * Bao nhiêu anh em bị huỷ cùng lúc.
 *
 * Mỗi lần huỷ là một tín hiệu tới một process group; bắn tất cả cùng lúc trên một cây rộng
 * là cách máy của người dùng tự làm nghẽn chính nó ngay lúc họ đang cố dừng mọi thứ lại.
 */
const CANCEL_CONCURRENCY = 4;

/**
 * Vòng đời của cây, ở phía trên store.
 *
 * Store trả lời "ghi cái này có hợp lệ không"; service trả lời "được phép làm gì tiếp theo" —
 * và mọi câu trả lời của nó đều hình thành *dưới* một lease, vì một quyết định tính trên bản
 * đọc trước lease là một quyết định về quá khứ.
 */
export class ExecutionGraphService {
  private readonly store: ExecutionGraphStore;
  private readonly limits: ExecutionGraphLimits;
  private readonly now: () => Date;
  private readonly newExecutionId: () => ExecutionId;
  private readonly newReservationId: () => string;
  private readonly newCapability: () => string;

  constructor(options: ExecutionGraphServiceOptions) {
    this.store = options.store;
    this.limits = options.limits ?? DEFAULT_EXECUTION_GRAPH_LIMITS;
    this.now = options.now ?? (() => new Date());
    this.newExecutionId =
      options.newExecutionId ??
      (() => `exec_${randomUUID().replaceAll("-", "").slice(0, 20)}`);
    this.newReservationId = options.newReservationId ?? (() => `rsv_${randomUUID()}`);
    // 32 byte là mức mà đoán trúng không còn là một chiến lược; base64url để nó đi qua env
    // và dòng lệnh mà không cần quote.
    this.newCapability = options.newCapability ?? (() => randomBytes(32).toString("base64url"));
  }

  /**
   * Mở một cây mới quanh một execution chưa tồn tại.
   *
   * Node ra đời ở `preparing`, trước cả khi `ExecutionService.materialize()` ghi file đầu
   * tiên: mọi thứ sinh ra sau đó đều đã có một chỗ trong cây để bị huỷ, bị đếm, và bị chờ.
   * Trần và deadline được chốt ngay tại đây và bất biến từ đó — cả cây, cả đời nó.
   */
  async createRoot(input: {
    readonly agentId: AgentId;
    /**
     * ID đã cấp từ trước, khi caller phải xin quyền trước lúc mở cây — `runMainSession` xin
     * `principal → main` rồi mới tạo root, và cả hai bước nói về cùng một execution.
     */
    readonly executionId?: ExecutionId;
  }): Promise<RootExecution> {
    const executionId = input.executionId ?? this.newExecutionId();
    const capability = this.newCapability();
    const createdAt = this.now();
    const timestamp = createdAt.toISOString();
    const node: ExecutionNode = {
      executionId,
      graphId: executionId,
      parentExecutionId: null,
      agentId: input.agentId,
      depth: 0,
      status: "preparing",
      requestId: null,
      requestFingerprint: null,
      capabilityHash: hashCapability(capability),
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: null,
      endedAt: null,
      cancellation: null,
      error: null,
      terminationReason: null,
    };
    const graph: ExecutionGraphDocument = {
      version: 1,
      graphId: executionId,
      rootExecutionId: executionId,
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      deadlineAt: new Date(createdAt.getTime() + this.limits.wallClockMs).toISOString(),
      limits: this.limits,
      delegationUsed: 0,
      nodes: [node],
      reservations: [],
    };
    await this.store.create(graph);
    return Object.freeze({
      binding: Object.freeze({
        graphId: executionId,
        executionId,
        capability,
        deadlineAt: graph.deadlineAt,
      }),
      graph,
      node,
    });
  }

  /**
   * Đăng ký process của root **trong khi** vẫn giữ lease.
   *
   * Nhả lease trước khi backend có record là mở một cửa sổ mà cây nói "đang chạy" còn process
   * thì chưa tồn tại: một lệnh huỷ rơi vào đúng đó sẽ huỷ một thứ chưa có, rồi process xuất
   * hiện sau và không còn ai nhớ phải giết nó (invariant 5).
   *
   * `register` hỏng thì node thành `failed` ngay trong cùng lease đó — một cây có root
   * `preparing` vĩnh viễn là một cây mà không lệnh nào dọn được.
   */
  async startRoot<T>(
    binding: ExecutionBinding,
    register: (binding: ExecutionBinding) => Promise<T>,
  ): Promise<T> {
    return this.store.withExclusiveLease(binding.graphId, async (lease) => {
      const graph = await lease.read();
      const node = this.authenticate(graph, binding);
      if (isTerminalNodeStatus(node.status)) {
        throw new ExecutionGraphError(
          "INVALID_NODE_TRANSITION",
          `execution \`${node.executionId}\` already ended as \`${node.status}\``,
        );
      }
      assertWithinDeadline(graph, this.now());

      let result: T;
      try {
        result = await register(binding);
      } catch (error) {
        await this.settle(lease, graph, node.executionId, {
          status: "failed",
          error: errorRecord(error, ROOT_START_FAILED),
        });
        throw error;
      }
      const startedAt = this.now().toISOString();
      await lease.write(
        withNode(graph, node.executionId, (current) => ({
          ...current,
          status: "running",
          startedAt: current.startedAt ?? startedAt,
          updatedAt: startedAt,
        })),
      );
      return result;
    });
  }

  /**
   * Ghi kết cục của một execution — root hay con, cùng một đường.
   *
   * Kết cục đầu tiên là kết cục: một node đã terminal được trả lại nguyên vẹn chứ không bị
   * ghi đè, nên một backend trả lời muộn hay một lần reconcile sau restart không biến một
   * run đã xong thành một run hỏng.
   */
  async finishExecution(
    binding: ExecutionBinding,
    outcome: ExecutionOutcome,
  ): Promise<ExecutionNode> {
    return this.store.withExclusiveLease(binding.graphId, async (lease) => {
      const graph = await lease.read();
      const node = this.authenticate(graph, binding);
      if (isTerminalNodeStatus(node.status)) return node;
      return this.settle(lease, graph, node.executionId, outcome);
    });
  }

  /** Execution chết trước khi chạm tới backend — vẫn phải là một node terminal đọc được. */
  async failExecution(binding: ExecutionBinding, error: unknown): Promise<ExecutionNode> {
    return this.finishExecution(binding, { status: "failed", error: errorRecord(error, ROOT_START_FAILED) });
  }

  /**
   * Cha là ai — đọc từ cây, không từ lời khai.
   *
   * `ALP_ROLE` sửa được bằng một dòng `export` trước khi gọi `alp delegate`; capability thì
   * không, vì graph giữ hash của đúng giá trị đã phát cho node đó. Vai trả về ở đây là vai
   * dùng để hỏi policy — đó là toàn bộ nội dung của invariant 2.
   */
  async authenticateParent(binding: ExecutionBinding): Promise<AuthenticatedExecution> {
    const graph = await this.store.get(binding.graphId);
    if (!graph) {
      throw new ExecutionGraphError(
        "EXECUTION_GRAPH_NOT_FOUND",
        `execution graph \`${binding.graphId}\` does not exist`,
      );
    }
    const node = this.authenticate(graph, binding);
    assertParentActive(node);
    return Object.freeze({ graph, node });
  }

  /** Cây chứa execution này, hoặc `null` khi không cây nào chứa — tín hiệu duy nhất cho legacy. */
  async findGraphFor(executionId: ExecutionId): Promise<ExecutionGraphDocument | null> {
    return this.store.findByExecutionId(executionId);
  }

  async getGraph(graphId: ExecutionGraphId): Promise<ExecutionGraphDocument | null> {
    return this.store.get(graphId);
  }

  /**
   * Giữ một chỗ cho con, dưới lease, trước khi một byte artifact nào được ghi.
   *
   * Giữa lúc trần được kiểm và lúc backend đăng ký process có một khoảng dài — materialize,
   * dựng launch spec, probe runtime — đủ để hai caller cùng nhìn thấy "còn một chỗ" rồi cùng
   * đi tiếp. Reservation lấp khoảng đó: nó tính vào capacity ngay tại lúc kiểm.
   *
   * Trả `ExistingChild` khi request này đã thành node: một retry phải nhận lại đúng con cũ
   * chứ không đẻ thêm con thứ hai, và capability thì dẫn xuất lại được nên caller vẫn đủ
   * quyền kết thúc nó.
   */
  async reserveChild(
    parent: ExecutionBinding,
    request: ChildRequest,
    options: { readonly executionId?: ExecutionId } = {},
  ): Promise<ChildReservation> {
    return this.store.withExclusiveLease(parent.graphId, async (lease) => {
      const graph = await lease.read();
      const parentNode = this.authenticate(graph, parent);
      const now = this.now();
      const fingerprint = requestFingerprint(parent.executionId, request);

      const committed = graph.nodes.find((node) => node.requestId === request.requestId);
      if (committed) {
        assertSameRequest(request.requestId, committed.requestFingerprint, fingerprint);
        return Object.freeze({
          kind: "existing" as const,
          node: committed,
          binding: this.verifiedChildBinding(parent, committed),
        });
      }
      const live = liveReservations(graph, now).find(
        (reservation) => reservation.requestId === request.requestId,
      );
      if (live) {
        assertSameRequest(request.requestId, live.requestFingerprint, fingerprint);
        throw new ExecutionGraphError(
          "REQUEST_IN_PROGRESS",
          `delegation request \`${request.requestId}\` is already being started as \`${live.executionId}\``,
          { executionId: live.executionId },
        );
      }

      // Thứ tự: cha còn sống, rồi tổ tiên chưa bị huỷ, rồi hạn, rồi trần. Một caller có cha
      // đã chết muốn nghe điều đó, không phải nghe rằng cây đang đông.
      assertParentActive(parentNode);
      assertNoCancelledAncestor(graph, parentNode);
      assertWithinDeadline(graph, now);
      assertChildCapacity({ graph, parentExecutionId: parentNode.executionId, now });

      const executionId = options.executionId ?? this.newExecutionId();
      if (findNode(graph, executionId)) {
        throw new ExecutionGraphError(
          "INVALID_NODE_TRANSITION",
          `execution \`${executionId}\` already exists in graph \`${graph.graphId}\``,
          { executionId },
        );
      }
      const capability = deriveChildCapability(parent.capability, graph.graphId, executionId);
      const timestamp = now.toISOString();
      const reservation: ExecutionReservation = {
        reservationId: this.newReservationId(),
        executionId,
        parentExecutionId: parentNode.executionId,
        agentId: request.agentId,
        depth: parentNode.depth + 1,
        requestId: request.requestId,
        requestFingerprint: fingerprint,
        capabilityHash: hashCapability(capability),
        createdAt: timestamp,
        expiresAt: new Date(now.getTime() + graph.limits.reservationTtlMs).toISOString(),
      };
      // Reservation hết hạn bị dọn trong chính lần ghi này: chúng đã không còn tính vào
      // capacity, và để lại thì một request cũ vẫn chặn `requestId` của nó mãi mãi.
      await lease.write({
        ...graph,
        revision: graph.revision + 1,
        updatedAt: timestamp,
        reservations: [...liveReservations(graph, now), reservation],
      });
      return Object.freeze({
        kind: "reserved" as const,
        reservationId: reservation.reservationId,
        requestFingerprint: fingerprint,
        binding: Object.freeze({
          graphId: graph.graphId,
          executionId,
          capability,
          deadlineAt: graph.deadlineAt,
        }),
        parentExecutionId: parentNode.executionId,
        agentId: request.agentId,
        depth: reservation.depth,
      });
    });
  }

  /**
   * Trả lại một chỗ đã giữ mà không bao giờ thành node.
   *
   * Không ném khi reservation đã biến mất: đường gọi duy nhất là dọn dẹp sau một lỗi cục bộ,
   * và một lỗi thứ hai ném ra từ chỗ dọn dẹp sẽ nuốt mất lỗi thật.
   */
  async releaseReservation(graphId: ExecutionGraphId, reservationId: string): Promise<void> {
    await this.store.withExclusiveLease(graphId, async (lease) => {
      const graph = await lease.read();
      if (!graph.reservations.some((reservation) => reservation.reservationId === reservationId)) {
        return;
      }
      await lease.write({
        ...graph,
        revision: graph.revision + 1,
        updatedAt: this.now().toISOString(),
        reservations: graph.reservations.filter(
          (reservation) => reservation.reservationId !== reservationId,
        ),
      });
    });
  }

  /**
   * Biến chỗ đã giữ thành node, và đăng ký process **trong khi** vẫn giữ lease.
   *
   * Hai lần ghi trong một lease: `queued` trước khi `register` chạy, rồi `running` sau khi
   * nó về. Nhả lease ở giữa là mở đúng cửa sổ mà invariant 5 đóng — cây nói "đang chạy" mà
   * chưa process nào tồn tại, hoặc process tồn tại mà cây chưa biết để giết.
   *
   * `delegationUsed` tăng đúng một lần, ở lần ghi thứ nhất, và không hoàn lại khi spawn hỏng:
   * ngân sách đếm số lần cây *đã thử* đẻ con, vì hoàn lại là cách một vòng lặp hỏng đều đặn
   * chạy mãi mà không bao giờ chạm trần.
   */
  async startReservedChild<T>(
    reserved: ReservedChild,
    register: (binding: ExecutionBinding) => Promise<T>,
  ): Promise<T> {
    return this.store.withExclusiveLease(reserved.binding.graphId, async (lease) => {
      const graph = await lease.read();
      const now = this.now();
      const reservation = graph.reservations.find(
        (candidate) => candidate.reservationId === reserved.reservationId,
      );
      if (!reservation) {
        throw new ExecutionGraphError(
          "RESERVATION_NOT_FOUND",
          `reservation \`${reserved.reservationId}\` is no longer held by graph \`${graph.graphId}\``,
        );
      }
      if (Date.parse(reservation.expiresAt) <= now.getTime()) {
        await lease.write({
          ...graph,
          revision: graph.revision + 1,
          updatedAt: now.toISOString(),
          reservations: graph.reservations.filter(
            (candidate) => candidate.reservationId !== reservation.reservationId,
          ),
        });
        throw new ExecutionGraphError(
          "RESERVATION_EXPIRED",
          `reservation \`${reserved.reservationId}\` expired at ${reservation.expiresAt}`,
        );
      }
      assertSameRequest(
        reservation.requestId,
        reservation.requestFingerprint,
        reserved.requestFingerprint,
      );
      assertWithinDeadline(graph, now);
      const parentNode = findNode(graph, reservation.parentExecutionId);
      if (!parentNode) {
        throw new ExecutionGraphError(
          "EXECUTION_NODE_NOT_FOUND",
          `execution \`${reservation.parentExecutionId}\` is not part of graph \`${graph.graphId}\``,
        );
      }
      assertParentActive(parentNode);
      assertNoCancelledAncestor(graph, parentNode);

      const timestamp = now.toISOString();
      const node: ExecutionNode = {
        executionId: reservation.executionId,
        graphId: graph.graphId,
        parentExecutionId: reservation.parentExecutionId,
        agentId: reservation.agentId,
        depth: reservation.depth,
        status: "queued",
        requestId: reservation.requestId,
        requestFingerprint: reservation.requestFingerprint,
        capabilityHash: reservation.capabilityHash,
        createdAt: reservation.createdAt,
        updatedAt: timestamp,
        startedAt: null,
        endedAt: null,
        cancellation: null,
        error: null,
        terminationReason: null,
      };
      const queued = await lease.write({
        ...graph,
        revision: graph.revision + 1,
        updatedAt: timestamp,
        delegationUsed: graph.delegationUsed + 1,
        nodes: [...graph.nodes, node],
        reservations: graph.reservations.filter(
          (candidate) => candidate.reservationId !== reservation.reservationId,
        ),
      });

      let result: T;
      try {
        result = await register(reserved.binding);
      } catch (error) {
        await this.settle(lease, queued, node.executionId, {
          status: "failed",
          error: errorRecord(error, CHILD_START_FAILED),
        });
        throw error;
      }
      const startedAt = this.now().toISOString();
      await lease.write(
        withNode(queued, node.executionId, (current) => ({
          ...current,
          status: "running",
          startedAt: current.startedAt ?? startedAt,
          updatedAt: startedAt,
        })),
      );
      return result;
    });
  }

  /**
   * Hỏi backend về mọi node còn active, rồi ghi lại sự thật đó vào cây.
   *
   * Chạy trước mọi lệnh lifecycle, vì cây là thứ sống lâu hơn process đã tạo ra nó: sau một
   * lần reboot, mọi node vẫn đứng ở trạng thái cuối cùng ai đó kịp ghi, và một cây toàn node
   * `running` ma sẽ từ chối mọi delegation tiếp theo bằng một trần mà thực tế không ai đang
   * dùng.
   *
   * Backend được hỏi **ngoài** lease — giữ lease suốt một vòng probe là khoá cả cây lại theo
   * đúng thời gian I/O chậm nhất — rồi kết quả được áp dưới một lease mới, trên bản đọc lại,
   * và chỉ theo chiều tiến: một node đã terminal trong lúc probe chạy thì giữ nguyên kết cục
   * của nó.
   */
  async reconcile(
    graphId: ExecutionGraphId,
    probe: ExecutionProbe,
  ): Promise<ExecutionGraphDocument> {
    const snapshot = await this.store.get(graphId);
    if (!snapshot) {
      throw new ExecutionGraphError(
        "EXECUTION_GRAPH_NOT_FOUND",
        `execution graph \`${graphId}\` does not exist`,
      );
    }
    const probed = await probeAll(
      snapshot.nodes.filter((node) => PROBED_STATUSES.includes(node.status)),
      probe,
    );

    const orphaned: { readonly executionId: ExecutionId }[] = [];
    const reconciled = await this.store.withExclusiveLease(graphId, async (lease) => {
      const graph = await lease.read();
      const now = this.now();
      const timestamp = now.toISOString();
      let changed = false;
      const nodes = graph.nodes.map((node) => {
        const status = probed.get(node.executionId);
        if (status === undefined || !isActiveNodeStatus(node.status)) return node;
        const next = reconciledStatus(node, status, now);
        if (!next) return node;
        changed = true;
        if (next.status === "failed" || next.status === "interrupted") {
          orphaned.push({ executionId: node.executionId });
        }
        return {
          ...node,
          status: next.status,
          updatedAt: timestamp,
          ...(next.status === "running"
            ? { startedAt: node.startedAt ?? timestamp }
            : { endedAt: node.endedAt ?? timestamp }),
          ...(next.error ? { error: next.error } : {}),
          ...(next.terminationReason ? { terminationReason: next.terminationReason } : {}),
          ...(next.cancellation && !node.cancellation ? { cancellation: next.cancellation } : {}),
        };
      });
      const reservations = liveReservations(graph, now);
      if (!changed && reservations.length === graph.reservations.length) return graph;
      return lease.write({
        ...graph,
        revision: graph.revision + 1,
        updatedAt: timestamp,
        nodes,
        reservations,
      });
    });

    // Cascade sau khi lease đã nhả, không lồng vào lease trên: lease này không reentrant, và
    // một lần khoá lồng nhau ở đây là một deadlock đứng im chứ không phải một lỗi đọc được.
    if (orphaned.length === 0) return reconciled;
    return this.cascadeParentFailure(graphId, orphaned.map((entry) => entry.executionId));
  }

  /**
   * Dừng một execution và cả nhánh dưới nó.
   *
   * Ba pha, và thứ tự của chúng là toàn bộ nội dung của phase này:
   *
   * 1. **Dưới lease:** đánh dấu mọi node còn sống trong nhánh là `cancelling` và thu hồi
   *    reservation của chúng, rồi *ghi xuống đĩa*. Từ lúc này không con nào mới ra đời được
   *    trong nhánh — `reserveChild` sẽ thấy `assertNoCancelledAncestor` chặn lại — nên
   *    không có process nào sinh ra sau lệnh huỷ mà không ai biết để giết.
   * 2. **Ngoài lease:** gửi tín hiệu, sâu nhất trước. Giữ lease suốt quãng này là khoá cả
   *    cây trong lúc gọi sang một process khác; và lá phải chết trước gốc, nếu không một cha
   *    đang hấp hối có thể dọn dẹp trên đám con vẫn đang ghi file.
   * 3. **Dưới lease lần nữa:** ghi kết cục. Backend nào không huỷ được thì node ở lại
   *    `cancelling` — reconciliation sẽ hỏi lại, và bịa ra `cancelled` ở đây là cách một
   *    process còn sống biến mất khỏi sổ sách.
   */
  async cancelSubtree(
    input: CancelSubtreeInput,
    cancel: ExecutionCanceller,
  ): Promise<ExecutionGraphDocument> {
    const marked = await this.store.withExclusiveLease(input.graphId, async (lease) => {
      const graph = await lease.read();
      const target = findNode(graph, input.executionId);
      if (!target) {
        throw new ExecutionGraphError(
          "EXECUTION_NODE_NOT_FOUND",
          `execution \`${input.executionId}\` is not part of graph \`${input.graphId}\``,
        );
      }
      const now = this.now();
      const timestamp = now.toISOString();
      const doomed = subtreeOf(graph, input.executionId).filter((node) => isActiveNodeStatus(node.status));
      const held = new Set(doomed.map((node) => node.executionId));
      // Một chỗ đã giữ trong nhánh này là một process sắp ra đời. Thu hồi nó dưới cùng lease
      // đã đánh dấu cha nó, nếu không thì owner của reservation vẫn commit được một con mới
      // vào một nhánh vừa bị huỷ.
      const reservations = graph.reservations.filter(
        (reservation) => !held.has(reservation.parentExecutionId),
      );
      if (doomed.length === 0 && reservations.length === graph.reservations.length) return graph;
      const nodes = graph.nodes.map((node) => {
        if (!held.has(node.executionId)) return node;
        return {
          ...node,
          status: "cancelling" as const,
          updatedAt: timestamp,
          // Lần đầu thắng: nếu nhánh này đã bị huỷ vì cha hỏng, ghi đè lý do ở đây chỉ đổi
          // một câu trả lời đúng thành câu trả lời của lệnh gần nhất.
          cancellation: node.cancellation ?? this.cancellationFor(input, node, timestamp),
        };
      });
      return lease.write({
        ...graph,
        revision: graph.revision + 1,
        updatedAt: timestamp,
        nodes,
        reservations,
      });
    });

    const signalled = await this.signalDeepestFirst(marked, input.executionId, cancel);
    if (signalled.size === 0) return marked;

    return this.store.withExclusiveLease(input.graphId, async (lease) => {
      const graph = await lease.read();
      const timestamp = this.now().toISOString();
      let changed = false;
      const nodes = graph.nodes.map((node) => {
        // `cancelling` chứ không phải "có trong danh sách": một agent kịp trả kết quả giữa
        // lúc tín hiệu bay đi và lúc ta khoá lại đã `completed`, và kết quả đó là thật.
        if (!signalled.has(node.executionId) || node.status !== "cancelling") return node;
        changed = true;
        return {
          ...node,
          status: "cancelled" as const,
          updatedAt: timestamp,
          endedAt: node.endedAt ?? timestamp,
          terminationReason: node.cancellation?.reason === "WALL_CLOCK_EXCEEDED"
            ? "deadline" as const
            : node.terminationReason,
        };
      });
      if (!changed) return graph;
      return lease.write({ ...graph, revision: graph.revision + 1, updatedAt: timestamp, nodes });
    });
  }

  /**
   * Lý do huỷ của một node trong nhánh.
   *
   * Node bị nhắm đích danh mang lý do của lệnh; hậu duệ mang `PARENT_CANCELLED`, vì chúng
   * dừng do cha chứ không do chính chúng. Hạn chót là ngoại lệ: cả cây dùng chung một
   * `deadlineAt`, nên mọi node trong đó đều thực sự hết hạn, không phải chết lây.
   */
  private cancellationFor(
    input: CancelSubtreeInput,
    node: ExecutionNode,
    timestamp: string,
  ): CancellationRecord {
    const reason: CancellationReason = node.executionId === input.executionId
      || input.reason === "WALL_CLOCK_EXCEEDED"
      ? input.reason
      : "PARENT_CANCELLED";
    return {
      reason,
      requestedBy: node.executionId === input.executionId ? input.requestedBy : input.executionId,
      requestedAt: timestamp,
    };
  }

  /**
   * Gửi tín hiệu huỷ theo tầng, sâu nhất trước, và trả về những node backend đã nhận.
   *
   * `allSettled` chứ không phải `all`: một backend từ chối là một nhánh cần thử lại, không
   * phải lý do để bỏ mặc mọi nhánh còn lại đang chạy.
   */
  private async signalDeepestFirst(
    graph: ExecutionGraphDocument,
    executionId: ExecutionId,
    cancel: ExecutionCanceller,
  ): Promise<Set<ExecutionId>> {
    const pending = subtreeOf(graph, executionId).filter((node) => node.status === "cancelling");
    const byDepth = new Map<number, ExecutionNode[]>();
    for (const node of pending) {
      const wave = byDepth.get(node.depth) ?? [];
      wave.push(node);
      byDepth.set(node.depth, wave);
    }
    const signalled = new Set<ExecutionId>();
    for (const depth of [...byDepth.keys()].sort((left, right) => right - left)) {
      const wave = byDepth.get(depth) as readonly ExecutionNode[];
      for (let index = 0; index < wave.length; index += CANCEL_CONCURRENCY) {
        const batch = wave.slice(index, index + CANCEL_CONCURRENCY);
        const outcomes = await Promise.allSettled(batch.map(async (node) => cancel(node.executionId)));
        outcomes.forEach((outcome, offset) => {
          if (outcome.status === "fulfilled") signalled.add(batch[offset].executionId);
        });
      }
    }
    return signalled;
  }

  /**
   * Hậu duệ còn sống của một node vừa chết thì không còn ai chờ kết quả của chúng.
   *
   * P0 đánh dấu, chưa giết: gửi tín hiệu tới đúng process group là việc của cascade
   * cancellation ở P1 kế tiếp. Nhưng đánh dấu ngay thì trần đồng thời được trả về đúng lúc,
   * và `alp delegation tree` không hiển thị một nhánh đang chạy dưới một cha đã hỏng.
   */
  private async cascadeParentFailure(
    graphId: ExecutionGraphId,
    parents: readonly ExecutionId[],
  ): Promise<ExecutionGraphDocument> {
    return this.store.withExclusiveLease(graphId, async (lease) => {
      const graph = await lease.read();
      const now = this.now();
      const timestamp = now.toISOString();
      const doomed = new Map<ExecutionId, ExecutionId>();
      for (const parent of parents) {
        for (const descendant of subtreeOf(graph, parent)) {
          if (descendant.executionId === parent) continue;
          if (!isActiveNodeStatus(descendant.status)) continue;
          if (!doomed.has(descendant.executionId)) doomed.set(descendant.executionId, parent);
        }
      }
      const held = new Set([...parents, ...doomed.keys()]);
      const reservations = graph.reservations.filter(
        (reservation) => !held.has(reservation.parentExecutionId),
      );
      if (doomed.size === 0 && reservations.length === graph.reservations.length) return graph;
      const nodes = graph.nodes.map((node) => {
        const requestedBy = doomed.get(node.executionId);
        if (requestedBy === undefined) return node;
        const cancellation: CancellationRecord = {
          reason: "PARENT_FAILED",
          requestedBy,
          requestedAt: timestamp,
        };
        return {
          ...node,
          status: "cancelled" as const,
          updatedAt: timestamp,
          endedAt: node.endedAt ?? timestamp,
          cancellation: node.cancellation ?? cancellation,
        };
      });
      return lease.write({
        ...graph,
        revision: graph.revision + 1,
        updatedAt: timestamp,
        nodes,
        reservations,
      });
    });
  }

  /**
   * Binding của một con đã commit, kiểm lại chính hash mà cây đang giữ.
   *
   * Dẫn xuất luôn ra một chuỗi nào đó, kể cả từ một capability sai — kiểm ở đây là chỗ duy
   * nhất phân biệt "cha thật đang lấy lại con của mình" với "ai đó đoán trúng một request ID".
   */
  private verifiedChildBinding(
    parent: ExecutionBinding,
    node: ExecutionNode,
  ): ExecutionBinding {
    const binding = childBinding(parent, node.executionId);
    if (!capabilityMatches(node.capabilityHash, binding.capability)) {
      throw new ExecutionGraphError(
        "CAPABILITY_INVALID",
        `execution \`${node.executionId}\` was not issued to \`${parent.executionId}\``,
        { executionId: node.executionId },
      );
    }
    return binding;
  }

  private authenticate(
    graph: ExecutionGraphDocument,
    binding: ExecutionBinding,
  ): ExecutionNode {
    const node = findNode(graph, binding.executionId);
    if (!node) {
      throw new ExecutionGraphError(
        "EXECUTION_NODE_NOT_FOUND",
        `execution \`${binding.executionId}\` is not part of graph \`${graph.graphId}\``,
      );
    }
    if (!capabilityMatches(node.capabilityHash, binding.capability)) {
      throw new ExecutionGraphError(
        "CAPABILITY_INVALID",
        `execution \`${binding.executionId}\` presented a capability the graph did not issue`,
      );
    }
    return node;
  }

  private async settle(
    lease: ExecutionGraphLease,
    graph: ExecutionGraphDocument,
    executionId: ExecutionId,
    outcome: ExecutionOutcome,
  ): Promise<ExecutionNode> {
    const endedAt = this.now().toISOString();
    const next = await lease.write(
      withNode(graph, executionId, (current) => ({
        ...current,
        status: outcome.status,
        updatedAt: endedAt,
        endedAt: current.endedAt ?? endedAt,
        error: outcome.error ?? current.error,
      })),
    );
    // `findNode` trên bản vừa ghi, không trên bản dựng tại chỗ: thứ caller đọc phải là thứ
    // đã đi qua `validateGraphWrite`.
    return findNode(next, executionId) as ExecutionNode;
  }

  /**
   * Cả cây quanh một execution, dưới dạng chỉ để đọc.
   *
   * Nhận **bất kỳ** node nào chứ không riêng root: người vận hành cầm trong tay cái ID mà
   * `alp delegate` vừa in ra, tức là một cái lá, và bắt họ tự tìm ngược lên root là bắt họ
   * đọc JSON thô — đúng việc mà lệnh này sinh ra để thay thế.
   *
   * Không cây nào chứa ID đó là `EXECUTION_NODE_NOT_FOUND`, không phải một cây rỗng: một
   * execution của bản cũ không có cây, và trả về "cây trống" sẽ đọc thành "đã xong" trong khi
   * process của nó có thể vẫn đang chạy. Document hỏng thì lỗi của store bay thẳng lên —
   * fallback ở đây là biến một cây không đọc được thành một cây không tồn tại.
   */
  async getExecutionTree(executionId: ExecutionId): Promise<ExecutionTreeView> {
    const graph = await this.store.findByExecutionId(executionId);
    const node = graph ? findNode(graph, executionId) : null;
    if (!graph || !node) {
      throw new ExecutionGraphError(
        "EXECUTION_NODE_NOT_FOUND",
        `execution \`${executionId}\` is not part of any execution graph`,
      );
    }
    const root = findNode(graph, graph.rootExecutionId);
    if (!root) {
      throw new ExecutionGraphError(
        "EXECUTION_GRAPH_CORRUPT",
        `execution graph \`${graph.graphId}\` has no root node`,
      );
    }
    const byStatus: Partial<Record<ExecutionNodeStatus, number>> = {};
    for (const candidate of graph.nodes) {
      byStatus[candidate.status] = (byStatus[candidate.status] ?? 0) + 1;
    }
    return Object.freeze({
      graphId: graph.graphId,
      rootExecutionId: graph.rootExecutionId,
      executionId: node.executionId,
      revision: graph.revision,
      createdAt: graph.createdAt,
      updatedAt: graph.updatedAt,
      deadlineAt: graph.deadlineAt,
      limits: graph.limits,
      delegation: Object.freeze({
        used: graph.delegationUsed,
        limit: graph.limits.delegationLimit,
        // Không âm: trần có thể bị hạ giữa đời một cây bằng một bản `alp` mới, và một số âm
        // ở đây đọc như một lỗi kế toán chứ không như "hết quota".
        remaining: Math.max(graph.limits.delegationLimit - graph.delegationUsed, 0),
      }),
      summary: Object.freeze({
        total: graph.nodes.length,
        active: graph.nodes.filter((candidate) => isActiveNodeStatus(candidate.status)).length,
        byStatus: Object.freeze(byStatus),
        pending: liveReservations(graph, this.now()).length,
      }),
      root: treeNodeOf(graph, root, new Set<ExecutionId>()),
    });
  }
}

/**
 * Document kế tiếp với đúng một node được thay.
 *
 * `revision + 1` và `updatedAt` đi liền ở đây chứ không để từng call site nhớ: quên tăng
 * revision là đúng cái `validateGraphWrite` gọi là lost update.
 */
function withNode(
  graph: ExecutionGraphDocument,
  executionId: ExecutionId,
  change: (node: ExecutionNode) => ExecutionNode,
): ExecutionGraphDocument {
  const nodes = graph.nodes.map((node) => (node.executionId === executionId ? change(node) : node));
  const updated = nodes.find((node) => node.executionId === executionId);
  return {
    ...graph,
    revision: graph.revision + 1,
    updatedAt: updated?.updatedAt ?? graph.updatedAt,
    nodes,
  };
}

function assertParentActive(node: ExecutionNode): void {
  if (!PARENT_ACTIVE_STATUSES.includes(node.status)) {
    throw new ExecutionGraphError(
      "PARENT_NOT_ACTIVE",
      `execution \`${node.executionId}\` is \`${node.status}\` and cannot delegate`,
      { executionId: node.executionId },
    );
  }
}

/**
 * Một tổ tiên đang bị huỷ thì cả nhánh đang bị huỷ.
 *
 * Kiểm cả chuỗi chứ không chỉ cha: lệnh huỷ đánh dấu node bị huỷ rồi mới lan xuống, nên có
 * một khoảnh khắc cha vẫn `running` trong khi ông đã `cancelling` — và một con sinh ra đúng
 * lúc đó là một process không nằm trong danh sách mà lệnh huỷ đang duyệt.
 */
function assertNoCancelledAncestor(
  graph: ExecutionGraphDocument,
  node: ExecutionNode,
): void {
  for (const ancestor of ancestorsOf(graph, node.executionId)) {
    if (ancestor.status === "cancelling" || ancestor.status === "cancelled") {
      throw new ExecutionGraphError(
        "EXECUTION_CANCELLED",
        `execution \`${node.executionId}\` sits under \`${ancestor.executionId}\`, which is \`${ancestor.status}\``,
        { executionId: ancestor.executionId },
      );
    }
  }
}

/** Cùng một `requestId` phải mô tả cùng một việc, nếu không thì nó là hai việc trùng tên. */
function assertSameRequest(requestId: string, expected: string | null, actual: string): void {
  if (expected === actual) return;
  throw new ExecutionGraphError(
    "REQUEST_ID_CONFLICT",
    `delegation request \`${requestId}\` was already used for a different request`,
  );
}

/** Trạng thái kế tiếp của một node sau khi backend trả lời, hoặc `null` nếu không đổi gì. */
function reconciledStatus(
  node: ExecutionNode,
  probed: ProbeStatus,
  now: Date,
): {
  readonly status: ExecutionNodeStatus;
  readonly error?: ExecutionNodeError;
  readonly cancellation?: CancellationRecord;
  readonly terminationReason?: "deadline";
} | null {
  switch (probed) {
    // Không tra được backend thì không biết gì thêm, và "không biết" phải để nguyên trạng
    // thái cũ: trả slot về sớm là cách hai process cùng chạy dưới một chỗ.
    case "unknown":
      return null;
    case "active":
      return node.status === "queued" ? { status: "running" } : null;
    case "completed":
      return { status: "completed" };
    case "cancelled":
      return { status: "cancelled" };
    // Hạn chót do backend cưỡng chế; cây chỉ ghi lại. Đồng hồ nằm ở nơi có process để giết,
    // và một timer thứ hai ở đây sẽ chạy trong một CLI đã thoát từ lâu.
    case "expired":
      return {
        status: "cancelled",
        terminationReason: "deadline",
        cancellation: {
          reason: "WALL_CLOCK_EXCEEDED",
          requestedBy: node.graphId,
          requestedAt: now.toISOString(),
        },
      };
    case "failed":
      return { status: "failed" };
    case "missing":
      // `queued` và backend chưa từng nghe tới nó: hoặc máy còn đang chậm, hoặc process đã
      // gọi đã chết giữa reserve và spawn. Ân hạn phân biệt hai chuyện đó.
      // Một node đang bị huỷ mà process đã biến mất thì lệnh huỷ đã tới đích, không phải
      // nó chết bất đắc kỳ tử — `interrupted` ở đây sẽ báo cáo một lần dừng có chủ ý như
      // một sự cố.
      if (node.status === "cancelling") return { status: "cancelled" };
      if (node.status === "queued") {
        return now.getTime() - Date.parse(node.updatedAt) < QUEUED_STARTUP_GRACE_MS
          ? null
          : {
              status: "failed",
              error: {
                code: EXECUTION_NEVER_STARTED,
                message: `execution \`${node.executionId}\` never reached the backend`,
              },
            };
      }
      return {
        status: "interrupted",
        error: {
          code: EXECUTION_INTERRUPTED,
          message: `execution \`${node.executionId}\` disappeared without recording an outcome`,
        },
      };
  }
}

/**
 * Hỏi backend về từng node, tối đa `RECONCILE_CONCURRENCY` câu cùng lúc.
 *
 * Một probe ném là `unknown`, không phải `missing`: câu hỏi là "backend biết gì", và một
 * backend không trả lời được thì câu trả lời đúng là "chưa biết".
 */
async function probeAll(
  nodes: readonly ExecutionNode[],
  probe: ExecutionProbe,
): Promise<Map<ExecutionId, ProbeStatus>> {
  const results = new Map<ExecutionId, ProbeStatus>();
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(RECONCILE_CONCURRENCY, nodes.length) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= nodes.length) return;
        const node = nodes[index];
        try {
          results.set(node.executionId, await probe(node.executionId));
        } catch {
          results.set(node.executionId, "unknown");
        }
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * Một node như người vận hành được phép nhìn thấy.
 *
 * Cố tình **không** phải `ExecutionNode`. Node mang `capabilityHash` và `requestFingerprint`;
 * cả hai là vật liệu nội bộ, và một DTO riêng là thứ duy nhất giữ cho chúng không rò ra
 * `alp delegation tree --json` rồi vào log CI của ai đó chỉ vì một trường mới được thêm vào
 * node sau này. Danh sách trường ở đây là một quyết định, không phải một bản sao.
 */
export interface ExecutionTreeNode {
  readonly executionId: ExecutionId;
  readonly parentExecutionId: ExecutionId | null;
  readonly agentId: AgentId;
  readonly depth: number;
  readonly status: ExecutionNodeStatus;
  /** Request đã sinh ra node này — đủ để nối lại với lệnh gọi, không lộ fingerprint. */
  readonly requestId: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly cancellation: CancellationRecord | null;
  readonly error: ExecutionNodeError | null;
  readonly terminationReason: "deadline" | null;
  readonly children: readonly ExecutionTreeNode[];
}

export interface ExecutionTreeSummary {
  readonly total: number;
  readonly active: number;
  readonly byStatus: Readonly<Partial<Record<ExecutionNodeStatus, number>>>;
  /**
   * Số chỗ đã giữ mà chưa thành node.
   *
   * Một con số, không phải danh sách: nó giải thích vì sao trần đồng thời đã đầy trong khi
   * chưa thấy đủ node, mà không đưa ra reservation ID hay capability hash nào.
   */
  readonly pending: number;
}

export interface ExecutionTreeView {
  readonly graphId: ExecutionGraphId;
  readonly rootExecutionId: ExecutionId;
  /** Node được hỏi. Cây trả về luôn tính từ root, nên đây là chỗ để tô đậm. */
  readonly executionId: ExecutionId;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deadlineAt: string;
  readonly limits: ExecutionGraphLimits;
  readonly delegation: {
    readonly used: number;
    readonly limit: number;
    readonly remaining: number;
  };
  readonly summary: ExecutionTreeSummary;
  readonly root: ExecutionTreeNode;
}

/**
 * Thứ tự ổn định: `createdAt`, rồi execution ID khi trùng.
 *
 * Hai con sinh trong cùng một mili-giây là chuyện bình thường — reservation được cấp trong
 * cùng một lease. Không có tie-break thì thứ tự rơi về thứ tự chèn của mảng, và cùng một cây
 * in ra hai lần cho hai bảng khác nhau; mọi snapshot test dựng trên đó sẽ nhấp nháy.
 */
function compareNodes(left: ExecutionNode, right: ExecutionNode): number {
  const byTime = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (byTime !== 0 && Number.isFinite(byTime)) return byTime;
  return left.executionId < right.executionId ? -1 : left.executionId > right.executionId ? 1 : 0;
}

/**
 * `seen` chứ không phải niềm tin vào document: store đã chứng minh cây không có chu trình
 * trước khi tới đây, nhưng hàm này cũng đệ quy, và một vòng lặp lọt qua bằng đường khác sẽ
 * là stack overflow trong một lệnh chỉ để *xem* — chứ không phải một lỗi đọc được.
 */
function treeNodeOf(
  graph: ExecutionGraphDocument,
  node: ExecutionNode,
  seen: Set<ExecutionId>,
): ExecutionTreeNode {
  seen.add(node.executionId);
  return Object.freeze({
    executionId: node.executionId,
    parentExecutionId: node.parentExecutionId,
    agentId: node.agentId,
    depth: node.depth,
    status: node.status,
    requestId: node.requestId,
    createdAt: node.createdAt,
    startedAt: node.startedAt,
    endedAt: node.endedAt,
    cancellation: node.cancellation,
    error: node.error,
    terminationReason: node.terminationReason,
    children: Object.freeze(
      [...graph.nodes.filter((candidate) =>
        candidate.parentExecutionId === node.executionId && !seen.has(candidate.executionId))]
        .sort(compareNodes)
        .map((child) => treeNodeOf(graph, child, seen)),
    ),
  });
}

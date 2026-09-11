import { createHash } from "node:crypto";
import type { RuntimeId } from "../agents/types";
import type { ContinuityCheckpointV1 } from "../context/types";
import type { ExecutionThreadBinding } from "../execution/types";
import type { ExecutionProbe } from "../execution/graph/execution-graph-service";
import type { ExecutionGraphDocument, ExecutionNode } from "../execution/graph/types";
import { isActiveNodeStatus, isTerminalNodeStatus, type ExecutionNodeStatus } from "../execution/graph/types";
import { projectThreadContext } from "./context-projector";
import {
  assertThreadContextSnapshot,
  type ThreadCompactionRecordV1,
  type ThreadContextHandoff,
  type ThreadContextSnapshotV1,
} from "./context-types";
import { ThreadError } from "./errors";
import { HistoryBridgeRegistry, type HistoryExecutionSource } from "./history-bridge";
import { worseCompleteness, type CollectedEntry, type HistoryCompleteness, type ThreadEntry, type ThreadExecutionBoundary } from "./history-types";
import { contextArtifactRef, messageArtifactRef } from "./invariants";
import type { ThreadStore } from "./thread-store";
import {
  EMPTY_THREAD_CONTEXT_DIGEST,
  EMPTY_THREAD_CONTEXT_REVISION,
  THREAD_EXECUTION_OUTCOMES,
  unsettledExecution,
  type CreateThreadInput,
  type ThreadActivity,
  type ThreadDocumentV1,
  type ThreadExecutionOutcome,
  type ThreadExecutionRef,
  type ThreadId,
  type ThreadMessageRef,
  type ThreadListQuery,
  type ThreadSummary,
} from "./types";

/**
 * Phần graph mà Thread cần nhìn — chỉ đọc. Thread không tạo node, không cancel, không giữ
 * lease graph: nó hỏi "root này còn sống không" và chỉ vậy.
 */
export interface ThreadGraphReader {
  findGraphFor(executionId: string): Promise<ExecutionGraphDocument | null>;
  /**
   * Hỏi backend về các node còn active của cây rồi ghi lại sự thật — chính là
   * `ExecutionGraphService.reconcile` với probe đã gắn sẵn. Không có thì Thread tin trạng
   * thái graph đang lưu.
   */
  reconcile?(graphId: string): Promise<ExecutionGraphDocument>;
}

/**
 * Reader thật: `findGraphFor` của graph service, và `reconcile` với probe backend đã gắn.
 * Thread không giữ backend — nó chỉ giữ một hàm "hỏi rồi ghi lại", do graph service làm.
 */
export function threadGraphReader(
  graph: { findGraphFor(executionId: string): Promise<ExecutionGraphDocument | null>; reconcile(graphId: string, probe: ExecutionProbe): Promise<ExecutionGraphDocument> },
  probe: ExecutionProbe,
): ThreadGraphReader {
  return {
    findGraphFor: (executionId) => graph.findGraphFor(executionId),
    reconcile: (graphId) => graph.reconcile(graphId, probe),
  };
}

/**
 * Bao lâu sau `reservedAt` mà chưa thấy graph nào thì coi root đã chết giữa reserve và
 * `createRoot`. Cùng nghĩa với `reservationTtlMs` của graph (`defaults.ts`): một máy chậm
 * không bị khai tử oan, một caller chết không giữ chỗ mãi.
 */
export const THREAD_RESERVATION_TTL_MS = 2 * 60 * 1_000;

export interface ThreadServiceOptions {
  readonly store: ThreadStore;
  readonly graph: ThreadGraphReader;
  readonly now?: () => Date;
  /** Trần bytes cho snapshot context. Chỉ test đổi. */
  readonly contextMaxBytes?: number;
  /** TTL cho ref chưa có graph. Chỉ test đổi. */
  readonly reservationTtlMs?: number;
  /** Bridge đọc transcript theo runtime. Thiếu = mọi runtime `unsupported`. */
  readonly history?: HistoryBridgeRegistry;
}

/**
 * Kết quả `reserveRoot`: ref đã ghi, binding bất biến để đưa vào graph + policy, và handoff
 * (snapshot rev N) để đưa vào checkpoint + session context của execution mới.
 */
export interface ReservedRoot {
  readonly thread: ThreadDocumentV1;
  readonly ref: ThreadExecutionRef;
  readonly binding: ExecutionThreadBinding;
  readonly handoff: ThreadContextHandoff;
}

/** Đầu vào projection: những gì E-n để lại mà Thread không tự đọc được. */
export interface ProjectContextInput {
  /** Checkpoint E-n **đã verify integrity** bởi caller; `null` = mất hoặc không tin được. */
  readonly checkpoint: ContinuityCheckpointV1 | null;
  readonly runtime: RuntimeId | null;
}

/** Một root execution nhìn từ cả hai phía, đã đối chiếu. */
export interface DescribedThreadExecution {
  readonly ref: ThreadExecutionRef;
  readonly node: ExecutionNode;
  readonly graph: ExecutionGraphDocument;
}

/** Root thuộc Thread ⇔ không có cha và có binding. Không suy từ `agentId`. */
export function isRootThreadExecution(node: ExecutionNode): boolean {
  return node.parentExecutionId === null && node.thread !== null;
}

/**
 * Orchestration của Thread: nơi duy nhất gọi `withExclusiveLease`.
 *
 * Nguyên tắc 5 của plan nằm ở hình dạng từng hàm: mọi việc dưới Thread lease chỉ đọc/ghi
 * document Thread — không tra graph, không hỏi backend, không nhận callback. Graph và backend
 * được hỏi **trước** hoặc **sau** lease, trên snapshot; kết quả chỉ được áp nếu Thread vẫn ở
 * trạng thái mà snapshot đó nói. Thế là hai lease không bao giờ lồng nhau, theo cả hai chiều.
 */
export class ThreadService {
  private readonly store: ThreadStore;
  private readonly graph: ThreadGraphReader;
  private readonly now: () => Date;
  private readonly contextMaxBytes: number | undefined;
  private readonly reservationTtlMs: number;
  private readonly history: HistoryBridgeRegistry;

  constructor(options: ThreadServiceOptions) {
    this.store = options.store;
    this.graph = options.graph;
    this.now = options.now ?? (() => new Date());
    this.contextMaxBytes = options.contextMaxBytes;
    this.reservationTtlMs = options.reservationTtlMs ?? THREAD_RESERVATION_TTL_MS;
    this.history = options.history ?? new HistoryBridgeRegistry();
  }

  async createThread(input: CreateThreadInput): Promise<ThreadDocumentV1> {
    return this.store.create(input);
  }

  async get(threadId: ThreadId): Promise<ThreadDocumentV1> {
    const thread = await this.store.get(threadId);
    if (!thread) throw new ThreadError("THREAD_NOT_FOUND", `thread \`${threadId}\` does not exist`);
    return thread;
  }

  async list(query: ThreadListQuery = {}): Promise<readonly ThreadSummary[]> {
    return this.store.list(query);
  }

  /**
   * Giữ chỗ cho root tiếp theo. Chỉ Thread lease; graph chưa có node nào cho execution này.
   *
   * Reserve **trước** `createRoot`: một graph/process tồn tại mà Thread không biết là một lỗ
   * trong lịch sử continuation. Crash ngay sau đây để lại ref unsettled không có graph —
   * reconcile (P3) đánh `interrupted` sau TTL, không cần ai nhớ.
   */
  async reserveRoot(threadId: ThreadId, executionId: string): Promise<ReservedRoot> {
    return this.store.withExclusiveLease(threadId, async (lease) => {
      const thread = lease.current();
      assertOpen(thread);
      const busy = unsettledExecution(thread);
      if (busy) {
        throw new ThreadError(
          "THREAD_BUSY",
          `thread \`${threadId}\` still has an unsettled execution \`${busy.executionId}\``,
          { executionId: busy.executionId },
        );
      }
      // Projection của root trước còn pending thì rev hiện tại thiếu đúng những gì root đó
      // để lại — reserve lên nó là lặng lẽ đánh rơi pins của E-n. Caller project trước.
      const pending = pendingProjection(thread);
      if (pending) {
        throw new ThreadError(
          "THREAD_INVARIANT_VIOLATION",
          `thread \`${threadId}\` has not projected the context of execution \`${pending.executionId}\` yet`,
          { executionId: pending.executionId },
        );
      }
      const timestamp = this.now().toISOString();
      const context = thread.currentContext;
      const snapshot = context === null ? null : await this.readSnapshot(lease.threadId, context, lease);
      const ref: ThreadExecutionRef = {
        executionId,
        sequence: thread.executions.length + 1,
        contextRevision: context?.revision ?? EMPTY_THREAD_CONTEXT_REVISION,
        contextDigest: context?.digest ?? EMPTY_THREAD_CONTEXT_DIGEST,
        reservedAt: timestamp,
        settled: null,
      };
      const committed = await lease.commit({
        ...thread,
        revision: thread.revision + 1,
        executions: [...thread.executions, ref],
        updatedAt: timestamp,
      });
      return Object.freeze({
        thread: committed,
        ref,
        binding: Object.freeze({
          id: thread.id,
          contextRevision: ref.contextRevision,
          contextDigest: ref.contextDigest,
        }),
        handoff: Object.freeze({
          threadId: thread.id,
          sequence: ref.sequence,
          title: thread.title,
          snapshot,
        }),
      });
    });
  }

  /**
   * Chiếu những gì E-n để lại thành rev N+1. Chạy **sau** `settleRoot`, dưới một Thread lease
   * riêng: payload trước, index sau — crash ở giữa để lại một orphan và một projection vẫn
   * pending, cả hai đều phục hồi được (orphan dọn, projection chạy lại từ checkpoint trên đĩa).
   *
   * Idempotent: ref đã có `nextContextRevision` thì trả document hiện tại, không chiếu lần hai.
   */
  async projectContext(
    threadId: ThreadId,
    executionId: string,
    input: ProjectContextInput,
  ): Promise<ThreadDocumentV1> {
    // Một lần chiếu trước đã chết sau khi ghi payload thì tên `context/<N+1>.json` đã bị chiếm.
    await this.store.collectOrphans(threadId);
    return this.store.withExclusiveLease(threadId, async (lease) => {
      const thread = lease.current();
      const index = thread.executions.findIndex((ref) => ref.executionId === executionId);
      const ref = thread.executions[index];
      if (!ref) {
        throw new ThreadError(
          "THREAD_EXECUTION_BINDING_MISMATCH",
          `execution \`${executionId}\` is not part of thread \`${threadId}\``,
          { executionId },
        );
      }
      if (ref.settled === null) {
        throw new ThreadError(
          "THREAD_INVARIANT_VIOLATION",
          `execution \`${executionId}\` of thread \`${threadId}\` is not settled; nothing to project`,
          { executionId },
        );
      }
      if (ref.settled.nextContextRevision !== null) return thread;
      const previous = thread.currentContext === null
        ? null
        : await this.readSnapshot(threadId, thread.currentContext, lease);
      const timestamp = this.now().toISOString();
      const { snapshot, compaction } = projectThreadContext({
        threadId,
        previous,
        title: thread.title,
        execution: {
          executionId,
          sequence: ref.sequence,
          outcome: ref.settled.outcome,
          runtime: input.runtime,
          finishedAt: ref.settled.finishedAt,
        },
        checkpoint: input.checkpoint,
        createdAt: timestamp,
        ...(this.contextMaxBytes === undefined ? {} : { maxBytes: this.contextMaxBytes }),
      });
      const artifact = await lease.writePayload("context", String(snapshot.revision), snapshot);
      let compactions = thread.compactions;
      if (compaction !== null) {
        const lastCompaction = thread.compactions.at(-1);
        const record: ThreadCompactionRecordV1 = {
          version: 1,
          id: `compaction-${snapshot.revision}`,
          threadId,
          ...compaction,
          fromMessageSequence: lastCompaction?.toMessageSequence === undefined ? (thread.messages.length === 0 ? 0 : 1) : lastCompaction.toMessageSequence + 1,
          toMessageSequence: thread.messages.length,
          inputDigest: previous?.digest ?? EMPTY_THREAD_CONTEXT_DIGEST,
          outputContextRevision: snapshot.revision,
          outputContextDigest: snapshot.digest,
          strategy: "deterministic",
          createdAt: timestamp,
        };
        const compactionArtifact = await lease.writePayload("compactions", record.id, record);
        compactions = [...compactions, {
          ...compaction, id: record.id, artifact: compactionArtifact, createdAt: timestamp,
          fromMessageSequence: record.fromMessageSequence, toMessageSequence: record.toMessageSequence,
        }];
      }
      const executions = thread.executions.slice();
      executions[index] = { ...ref, settled: { ...ref.settled, nextContextRevision: snapshot.revision } };
      return lease.commit({
        ...thread,
        revision: thread.revision + 1,
        currentContext: { revision: snapshot.revision, digest: snapshot.digest, artifact },
        compactions,
        executions,
        updatedAt: timestamp,
      });
    });
  }

  /**
   * Mirror delta transcript của một root vào `messages/`, và (lần đầu, sau settle) ghi boundary.
   *
   * Transcript đọc **ngoài** lease — nó là file của runtime, không phải của Thread. Dưới lease
   * chỉ còn: lọc trùng theo `id` entry, ghi payload, commit. Idempotent theo hai lớp: cursor
   * (bridge không đọc lại dòng đã đọc) và `id` (`<exec>:<nativeId>`; cùng entry không vào hai
   * lần kể cả khi cursor bị reset). Không bao giờ ném vì transcript: lỗi đọc = `final-only`.
   */
  async collectHistory(threadId: ThreadId, source: HistoryExecutionSource): Promise<ThreadDocumentV1> {
    const before = await this.get(threadId);
    const known = before.executions.find((ref) => ref.executionId === source.executionId);
    if (!known) {
      throw new ThreadError(
        "THREAD_EXECUTION_BINDING_MISMATCH",
        `execution \`${source.executionId}\` is not part of thread \`${threadId}\``,
        { executionId: source.executionId },
      );
    }
    const bridge = this.history.for(source.runtime);
    const delta = await bridge.collectDelta({ execution: source, cursor: known.history?.cursor ?? null }).catch(() => ({
      entries: [] as readonly CollectedEntry[],
      cursor: known.history?.cursor ?? null,
      completeness: "final-only" as HistoryCompleteness,
      pinnedVersion: null,
      skipped: 0,
    }));

    return this.store.withExclusiveLease(threadId, async (lease) => {
      const thread = lease.current();
      const index = thread.executions.findIndex((ref) => ref.executionId === source.executionId);
      if (index === -1) return thread;
      const ref = thread.executions[index];
      const existing = new Set(thread.messages.map((message) => message.id));
      const timestamp = this.now().toISOString();
      const fresh: ThreadEntry[] = delta.entries
        .map((entry) => ({ version: 1 as const, executionId: source.executionId, ...entry }))
        .filter((entry) => !existing.has(entryId(entry)));
      const settled = ref.settled;
      const boundaryMissing = settled !== null
        && !thread.messages.some((message) => message.executionId === source.executionId && message.kind === "boundary");
      const entryCount = (ref.history?.entryCount ?? 0) + fresh.length;
      const skipped = (ref.history?.skipped ?? 0) + delta.skipped;
      if (boundaryMissing) {
        const boundary: ThreadExecutionBoundary = {
          version: 1,
          kind: "boundary",
          executionId: source.executionId,
          nativeId: null,
          createdAt: settled.finishedAt,
          sequence: ref.sequence,
          outcome: settled.outcome,
          runtime: source.runtime,
          historyCompleteness: delta.completeness,
          pinnedVersion: delta.pinnedVersion,
          collected: entryCount,
          skipped,
        };
        fresh.push(boundary);
      }
      if (fresh.length === 0 && ref.history !== null && ref.history !== undefined && ref.history.completeness === delta.completeness) {
        return thread;
      }
      const messages = thread.messages.slice();
      for (const entry of fresh) {
        const sequence = messages.length + 1;
        const artifact = await lease.writePayload("messages", String(sequence), entry);
        messages.push({
          id: entryId(entry),
          sequence,
          executionId: entry.executionId,
          kind: entry.kind,
          artifact,
          digest: canonicalDigest(entry),
          createdAt: entry.createdAt,
        });
      }
      const executions = thread.executions.slice();
      executions[index] = {
        ...ref,
        history: {
          completeness: delta.completeness,
          pinnedVersion: delta.pinnedVersion,
          cursor: delta.cursor,
          entryCount,
          skipped,
          collectedAt: timestamp,
        },
      };
      return lease.commit({ ...thread, revision: thread.revision + 1, messages, executions, updatedAt: timestamp });
    });
  }

  /** Completeness tệ nhất trong các root đã collect; `null` khi chưa root nào có history. */
  historyCompleteness(thread: ThreadDocumentV1): HistoryCompleteness | null {
    let worst: HistoryCompleteness | null = null;
    for (const ref of thread.executions) {
      if (!ref.history) continue;
      worst = worst === null ? ref.history.completeness : worseCompleteness(worst, ref.history.completeness);
    }
    return worst;
  }

  /** Một entry đã ghi, verify digest so với index. */
  async readEntry(threadId: ThreadId, ref: ThreadMessageRef): Promise<ThreadEntry> {
    const payload = await this.store.readPayload(threadId, ref.artifact);
    if (canonicalDigest(payload) !== ref.digest) {
      throw new ThreadError("THREAD_CONTEXT_TAMPERED", `history entry ${ref.artifact} of thread \`${threadId}\` does not match its digest`);
    }
    return payload as ThreadEntry;
  }

  /** Snapshot hiện tại của Thread, đã verify digest; `null` khi chưa có revision nào. */
  async currentContext(threadId: ThreadId): Promise<ThreadContextSnapshotV1 | null> {
    const thread = await this.get(threadId);
    if (thread.currentContext === null) return null;
    return this.readSnapshot(threadId, thread.currentContext);
  }

  /** Ref đã settled mà chưa chiếu context — `continue` phải chiếu nó trước khi reserve. */
  pendingProjection(thread: ThreadDocumentV1): ThreadExecutionRef | null {
    return pendingProjection(thread);
  }

  /**
   * Đọc và verify `context/<rev>.json` so với ref index. Có lease thì đang ở dưới lease (I/O
   * của chính Thread, cho phép); không có thì là đọc snapshot bất biến ngoài lease.
   */
  private async readSnapshot(
    threadId: ThreadId,
    ref: { readonly revision: number; readonly digest: string },
    _lease?: unknown,
  ): Promise<ThreadContextSnapshotV1> {
    let payload: unknown;
    try {
      payload = await this.store.readPayload(threadId, contextArtifactRef(ref.revision));
    } catch (error) {
      throw new ThreadError(
        "THREAD_CONTEXT_TAMPERED",
        `context snapshot ${ref.revision} of thread \`${threadId}\` is missing`,
        { cause: error },
      );
    }
    return assertThreadContextSnapshot(payload, { threadId, revision: ref.revision, digest: ref.digest });
  }

  /**
   * Ghi kết cục cho ref. Write-once: ref đã settled thì giữ nguyên, kể cả khi outcome mới
   * khác — graph đã là truth của lifecycle, Thread chỉ chép lại một lần.
   */
  async settleRoot(
    threadId: ThreadId,
    executionId: string,
    outcome: ThreadExecutionOutcome,
  ): Promise<ThreadDocumentV1> {
    if (!THREAD_EXECUTION_OUTCOMES.includes(outcome)) {
      throw new ThreadError("THREAD_INVARIANT_VIOLATION", `unknown execution outcome \`${String(outcome)}\``);
    }
    return this.store.withExclusiveLease(threadId, async (lease) => {
      const thread = lease.current();
      const index = thread.executions.findIndex((ref) => ref.executionId === executionId);
      if (index === -1) {
        throw new ThreadError(
          "THREAD_EXECUTION_BINDING_MISMATCH",
          `execution \`${executionId}\` is not part of thread \`${threadId}\``,
          { executionId },
        );
      }
      const ref = thread.executions[index];
      if (ref.settled !== null) return thread;
      const timestamp = this.now().toISOString();
      const executions = thread.executions.slice();
      executions[index] = {
        ...ref,
        settled: { outcome, finishedAt: timestamp, nextContextRevision: null },
      };
      return lease.commit({
        ...thread,
        revision: thread.revision + 1,
        executions,
        updatedAt: timestamp,
      });
    });
  }

  /**
   * View tính ra từ ref + graph, không lưu. Đọc graph ngoài lease — đây là snapshot để hiển
   * thị, không phải quyết định ghi.
   */
  async activity(threadId: ThreadId): Promise<ThreadActivity> {
    const thread = await this.get(threadId);
    const pending = unsettledExecution(thread);
    if (!pending) return { kind: "idle" };
    const graph = await this.graph.findGraphFor(pending.executionId);
    const root = graph?.nodes.find((node) => node.executionId === pending.executionId) ?? null;
    if (root && isActiveNodeStatus(root.status)) {
      return { kind: "running", executionId: pending.executionId };
    }
    return { kind: "unsettled", executionId: pending.executionId };
  }

  /**
   * Đưa Thread về khớp với sự thật của graph/backend sau khi process đã chết mà không kịp
   * settle. Cùng hình dạng với `ExecutionGraphService.reconcile`: quyết định trên snapshot,
   * **ngoài** lease; rồi Thread lease + đọc lại, và chỉ áp intent nếu ref vẫn chưa settled
   * (monotonic — một settle thật đến trong lúc probe thì thắng).
   *
   *   không graph ∧ quá TTL      → interrupted (chết giữa reserve và createRoot)
   *   không graph ∧ trong TTL    → giữ (đang preparing)
   *   root terminal              → chép status của root
   *   root active                → graph hỏi backend; terminal thì chép, còn sống thì giữ
   */
  async reconcile(threadId: ThreadId): Promise<ThreadDocumentV1> {
    const snapshot = await this.get(threadId);
    const pending = unsettledExecution(snapshot);
    if (!pending) return snapshot;
    const intent = await this.reconcileIntent(pending);
    if (intent === null) return snapshot;
    return this.store.withExclusiveLease(threadId, async (lease) => {
      const thread = lease.current();
      const index = thread.executions.findIndex((ref) => ref.executionId === pending.executionId);
      const ref = thread.executions[index];
      if (!ref || ref.settled !== null) return thread;
      const timestamp = this.now().toISOString();
      const executions = thread.executions.slice();
      executions[index] = { ...ref, settled: { outcome: intent, finishedAt: timestamp, nextContextRevision: null } };
      return lease.commit({ ...thread, revision: thread.revision + 1, executions, updatedAt: timestamp });
    });
  }

  /** Kết cục nên ghi cho một ref unsettled, hoặc `null` nếu root còn (có thể) đang chạy. */
  private async reconcileIntent(ref: ThreadExecutionRef): Promise<ThreadExecutionOutcome | null> {
    const found = await this.graph.findGraphFor(ref.executionId);
    if (!found) {
      const age = this.now().getTime() - Date.parse(ref.reservedAt);
      return age > this.reservationTtlMs ? "interrupted" : null;
    }
    let root = found.nodes.find((node) => node.executionId === ref.executionId) ?? null;
    if (root && isActiveNodeStatus(root.status) && this.graph.reconcile) {
      const probed = await this.graph.reconcile(found.graphId);
      root = probed.nodes.find((node) => node.executionId === ref.executionId) ?? null;
    }
    if (!root) return "interrupted";
    return isTerminalNodeStatus(root.status) ? outcomeOf(root.status) : null;
  }

  /**
   * Một root execution, đối chiếu ba chiều: ref có trong Thread, node graph nói cùng Thread,
   * và revision/digest context hai bên bằng nhau. Lệch ở đâu cũng là
   * `THREAD_EXECUTION_BINDING_MISMATCH` — không sửa Thread cho khớp, vì phía đã hash (graph
   * node, policy) mới là bên đáng tin.
   */
  async describeExecution(threadId: ThreadId, executionId: string): Promise<DescribedThreadExecution> {
    const thread = await this.get(threadId);
    const ref = thread.executions.find((candidate) => candidate.executionId === executionId);
    if (!ref) {
      throw new ThreadError(
        "THREAD_EXECUTION_BINDING_MISMATCH",
        `execution \`${executionId}\` is not part of thread \`${threadId}\``,
        { executionId },
      );
    }
    const graph = await this.graph.findGraphFor(executionId);
    const node = graph?.nodes.find((candidate) => candidate.executionId === executionId) ?? null;
    if (!graph || !node) {
      throw new ThreadError(
        "THREAD_EXECUTION_BINDING_MISMATCH",
        `execution \`${executionId}\` has no graph node to check against thread \`${threadId}\``,
        { executionId },
      );
    }
    if (
      !isRootThreadExecution(node)
      || node.thread?.id !== threadId
      || node.thread.contextRevision !== ref.contextRevision
      || node.thread.contextDigest !== ref.contextDigest
    ) {
      throw new ThreadError(
        "THREAD_EXECUTION_BINDING_MISMATCH",
        `execution \`${executionId}\` carries a binding that does not match thread \`${threadId}\``,
        { executionId },
      );
    }
    return Object.freeze({ ref, node, graph });
  }

  /** `open → closed`. Từ chối khi còn ref unsettled: đóng một việc đang chạy là để nó mồ côi. */
  async close(threadId: ThreadId): Promise<ThreadDocumentV1> {
    return this.store.withExclusiveLease(threadId, async (lease) => {
      const thread = lease.current();
      if (thread.status === "archived") {
        throw new ThreadError("THREAD_ARCHIVED", `thread \`${threadId}\` is archived`);
      }
      if (thread.status === "closed") return thread;
      assertSettled(thread);
      const timestamp = this.now().toISOString();
      return lease.commit({ ...thread, revision: thread.revision + 1, status: "closed", updatedAt: timestamp });
    });
  }

  /** `closed → archived`. Thread `open` phải `close` trước — đây là hai quyết định, không một. */
  async archive(threadId: ThreadId): Promise<ThreadDocumentV1> {
    return this.store.withExclusiveLease(threadId, async (lease) => {
      const thread = lease.current();
      if (thread.status === "archived") return thread;
      if (thread.status !== "closed") {
        throw new ThreadError(
          "THREAD_INVARIANT_VIOLATION",
          `thread \`${threadId}\` must be closed before it can be archived`,
        );
      }
      assertSettled(thread);
      const timestamp = this.now().toISOString();
      return lease.commit({ ...thread, revision: thread.revision + 1, status: "archived", updatedAt: timestamp });
    });
  }
}

/** Status terminal của node graph → outcome của Thread; cùng từ vựng, chỉ đổi kiểu. */
function outcomeOf(status: ExecutionNodeStatus): ThreadExecutionOutcome {
  switch (status) {
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return status;
    default:
      throw new ThreadError("THREAD_INVARIANT_VIOLATION", `node status \`${status}\` is not terminal`);
  }
}

function pendingProjection(thread: ThreadDocumentV1): ThreadExecutionRef | null {
  return thread.executions.find((ref) => ref.settled !== null && ref.settled.nextContextRevision === null) ?? null;
}

function assertOpen(thread: ThreadDocumentV1): void {
  if (thread.status === "closed") {
    throw new ThreadError("THREAD_CLOSED", `thread \`${thread.id}\` is closed and accepts no new execution`);
  }
  if (thread.status === "archived") {
    throw new ThreadError("THREAD_ARCHIVED", `thread \`${thread.id}\` is archived`);
  }
}

function assertSettled(thread: ThreadDocumentV1): void {
  const busy = unsettledExecution(thread);
  if (busy) {
    throw new ThreadError(
      "THREAD_BUSY",
      `thread \`${thread.id}\` still has an unsettled execution \`${busy.executionId}\``,
      { executionId: busy.executionId },
    );
  }
}

/** `<exec>:<nativeId>`; entry không có ID native lấy digest nội dung — cùng nội dung, cùng ID. */
function entryId(entry: ThreadEntry): string {
  return `${entry.executionId}:${entry.nativeId ?? `${entry.kind}-${canonicalDigest(entry).slice(0, 16)}`}`;
}

function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortKeys(value))).digest("hex");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]));
  }
  return value;
}

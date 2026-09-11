import type { AgentDefinition, AgentRegistry, RuntimeId } from "../../agents/types";
import { MODE_PROFILES, type ModeId, type ModeProfiles } from "../../agents/modes";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BackendExecutionResult, ExecutionBackend } from "../../backend/execution-backend";
import { readCheckpoint } from "../../context/checkpoint";
import { INTERACTIVE_TASK_SENTINEL } from "../../context/continuity";
import type { ExecutionService } from "../../execution/execution-service";
import type { ExecutionGraphService } from "../../execution/graph/execution-graph-service";
import type { RuntimeAdapter } from "../../runtime/runtime-adapter";
import type { PreparedExecution } from "../../execution/types";
import { historySourceOf, type HistoryExecutionSource } from "../../thread/history-bridge";
import type { ProjectContextInput, ThreadService } from "../../thread/thread-service";
import { ThreadError } from "../../thread/errors";
import { THREAD_ID_PATTERN, unsettledExecution, type ThreadDocumentV1, type ThreadExecutionOutcome, type ThreadId } from "../../thread/types";
import type { ModeSelector } from "../mode-selector";

export interface RunMainInput {
  readonly cwd: string;
  /** Nấc công suất cho phiên này. Bỏ trống thì selector hỏi (TTY) hoặc lấy nấc đã lưu. */
  readonly mode?: ModeId;
  /** Tiêu đề Thread mới (`alp --title`). Thành `objective` của context; không cấp gì. */
  readonly title?: string;
}

export interface RunMainDependencies {
  readonly registry: Pick<AgentRegistry, "get">;
  readonly selector: Pick<ModeSelector, "select">;
  readonly executionService: Pick<ExecutionService, "authorize" | "materialize">;
  /**
   * Cây của phiên này. Root ra đời giữa authorize và materialize, nên không có khoảnh khắc
   * nào một execution có file trên đĩa mà cây chưa biết tới nó.
   */
  readonly graph: Pick<ExecutionGraphService, "createRoot" | "startRoot" | "finishExecution" | "failExecution">;
  /**
   * Đơn vị công việc mà root này thuộc về. Bare `alp` luôn mở Thread mới; `reserveRoot` và
   * `settleRoot` mỗi cái giữ Thread lease **một mình** — không bao giờ lồng với lease graph.
   */
  readonly threads: Pick<ThreadService, "createThread" | "reserveRoot" | "settleRoot" | "projectContext" | "collectHistory">;
  /**
   * Một dòng cho principal trước khi runtime chiếm terminal — stderr, để stdout của phiên
   * vẫn là của runtime. Bỏ trống thì im lặng (test, script).
   */
  readonly announce?: (line: string) => void;
  readonly adapters: ReadonlyMap<RuntimeId, RuntimeAdapter>;
  readonly backend: ExecutionBackend;
  readonly executionId: () => string;
  readonly interactive: boolean;
  readonly workspaceModeFor?: (cwd: string) => Promise<"read-only" | "workspace-write">;
  /** Loadout đã ghép settings của máy/project. Bỏ trống thì chạy đúng bản built-in. */
  readonly modeProfiles?: ModeProfiles;
}

export async function runMainSession(
  input: RunMainInput,
  dependencies: RunMainDependencies,
): Promise<BackendExecutionResult> {
  const definition = dependencies.registry.get("main") as AgentDefinition<unknown>;
  if (definition.reportsTo !== "principal") throw new Error("main must report to principal");
  const selection = await dependencies.selector.select({
    ...(input.mode === undefined ? {} : { requestedMode: input.mode }),
    interactive: dependencies.interactive && input.mode === undefined,
  });
  if (!selection.ok) return { executionId: "cancelled", status: "cancelled" };
  const mode = selection.mode;
  const profiles = dependencies.modeProfiles ?? MODE_PROFILES;
  // Thread trước execution, không lease: nó chỉ là bản ghi "có một việc bắt đầu ở đây".
  const thread = await dependencies.threads.createThread({
    agentId: definition.id,
    workspace: input.cwd,
    title: input.title ?? null,
  });
  // Nói tên Thread ra trước khi launch, vì sau đó terminal là của runtime — và đây là thứ
  // duy nhất principal cần nhớ để quay lại việc này sau khi process chết.
  dependencies.announce?.(`Thread: ${thread.id}   (continue later: alp thread continue ${thread.id})`);
  return runThreadRoot({ thread, definition, mode, profiles, cwd: input.cwd }, dependencies);
}

export interface ContinueThreadInput {
  readonly threadId: string;
  readonly cwd: string;
  readonly mode?: ModeId;
}

export interface ContinueThreadDependencies extends RunMainDependencies {
  readonly threads: RunMainDependencies["threads"] & Pick<ThreadService, "get" | "reconcile" | "pendingProjection">;
  /** `~/.alp/executions` — nơi đọc lại checkpoint của root cũ khi projection còn pending. */
  readonly executionsRoot: string;
}

/**
 * `alp thread continue <id>`: root #n+1 trên một Thread có sẵn.
 *
 *   reconcile → phải open → không ref unsettled → chiếu projection pending → chọn nấc →
 *   cùng root flow với bare `alp` từ authorize
 *
 * "Continue" là **Execution mới**, không attach vào process cũ. Không reuse policy cũ: E-n+1
 * authorize lại theo definition và nấc hiện tại — một Thread mở trên claude tiếp tục được
 * trên codex, và ngược lại.
 */
export async function continueThreadSession(
  input: ContinueThreadInput,
  dependencies: ContinueThreadDependencies,
): Promise<BackendExecutionResult> {
  const threadId = parseThreadId(input.threadId);
  const definition = dependencies.registry.get("main") as AgentDefinition<unknown>;
  if (definition.reportsTo !== "principal") throw new Error("main must report to principal");
  // Reconcile trước mọi quyết định: một process chết không settle để lại ref unsettled mà
  // graph/backend đã biết kết cục — không hỏi thì `continue` từ chối oan bằng THREAD_BUSY.
  let thread = await dependencies.threads.reconcile(threadId);
  assertContinuable(thread);
  const pending = dependencies.threads.pendingProjection(thread);
  if (pending) {
    // Lịch sử trước bản chiếu, như thứ tự ở `settle`: transcript của root chết vẫn nằm trên
    // đĩa runtime, và boundary phải đứng trước context rev mới của nó.
    await collectHistory(dependencies.threads, threadId, await historySourceFromDisk(dependencies.executionsRoot, pending.executionId));
    thread = await dependencies.threads.projectContext(
      threadId,
      pending.executionId,
      await projectionInputFromDisk(dependencies.executionsRoot, pending.executionId),
    );
  }
  const selection = await dependencies.selector.select({
    ...(input.mode === undefined ? {} : { requestedMode: input.mode }),
    interactive: dependencies.interactive && input.mode === undefined,
  });
  if (!selection.ok) return { executionId: "cancelled", status: "cancelled" };
  const profiles = dependencies.modeProfiles ?? MODE_PROFILES;
  dependencies.announce?.(`Thread: ${thread.id}   (continuation #${thread.executions.length + 1})`);
  return runThreadRoot({ thread, definition, mode: selection.mode, profiles, cwd: input.cwd }, dependencies);
}

function parseThreadId(value: string): ThreadId {
  if (!THREAD_ID_PATTERN.test(value)) throw new ThreadError("THREAD_NOT_FOUND", `invalid thread ID \`${value}\``);
  return value;
}

/** Những gì `reserveRoot` sẽ từ chối, nói sớm và kèm gợi ý — trước khi selector hỏi nấc. */
function assertContinuable(thread: ThreadDocumentV1): void {
  if (thread.status === "closed") {
    throw new ThreadError("THREAD_CLOSED", `thread \`${thread.id}\` is closed; open a new one with \`alp\``);
  }
  if (thread.status === "archived") {
    throw new ThreadError("THREAD_ARCHIVED", `thread \`${thread.id}\` is archived`);
  }
  const busy = unsettledExecution(thread);
  if (busy) {
    throw new ThreadError(
      "THREAD_BUSY",
      `thread \`${thread.id}\` still has a running execution \`${busy.executionId}\`; `
        + `check \`alp delegation status ${busy.executionId}\` or stop it with \`alp delegation cancel ${busy.executionId}\``,
      { executionId: busy.executionId },
    );
  }
}

interface ThreadRootInput {
  readonly thread: ThreadDocumentV1;
  readonly definition: AgentDefinition<unknown>;
  readonly mode: ModeId;
  readonly profiles: ModeProfiles;
  readonly cwd: string;
}

/**
 * Root #n của một Thread. Thứ tự là nội dung của phase này:
 *
 *   authorize → reserveRoot (Thread lease) → createRoot (graph) → materialize … finish (graph
 *   lease quanh spawn) → settleRoot (Thread lease)
 *
 * Authorize trước reserve: một execution bị từ chối không được chiếm slot Thread. Reserve
 * trước `createRoot`: graph/process mà Thread không biết là một lỗ trong lịch sử continuation.
 */
async function runThreadRoot(
  input: ThreadRootInput,
  dependencies: RunMainDependencies,
): Promise<BackendExecutionResult> {
  const { thread, definition, mode, profiles } = input;
  const executionId = dependencies.executionId();
  const requestedWorkspaceMode = dependencies.workspaceModeFor
    ? await dependencies.workspaceModeFor(input.cwd)
    : "read-only";
  // Project đã đăng ký là **trần**, không phải một cái cấp phát. `main` thôi cầm bút từ
  // 2026-09-10 nên nó không khai write root nào, và xin `workspace-write` ở đây sẽ bị
  // `ExecutionService` từ chối thẳng — phiên chết trước khi principal gõ được chữ nào.
  // Đọc definition rồi mới quyết định thì cùng một dòng này còn đúng cho vai sau, nếu ghế
  // ngoài cùng có ngày lại cầm bút.
  const workspaceMode = definition.capabilities.workspace.writeRoots.length > 0
    ? requestedWorkspaceMode
    : "read-only";
  const authorization = await dependencies.executionService.authorize({
    executionId,
    parent: "principal",
    target: definition.id,
    workspace: input.cwd,
    workspaceMode,
  });
  // Binding chốt ở đây và bất biến từ đây: cùng một giá trị đi vào graph node và vào
  // snapshot policy đã hash. Thread lease được nhả trước khi graph được chạm tới.
  const reserved = await dependencies.threads.reserveRoot(thread.id, executionId);
  // Cây trước file. Mọi thứ `materialize()` sinh ra từ đây đã có một node để bị đếm, bị chờ
  // và bị huỷ — kể cả khi process này chết ngay dòng sau.
  const root = await dependencies.graph.createRoot({
    agentId: definition.id,
    executionId,
    thread: reserved.binding,
  });
  // Kết cục về Thread đi hai bước, mỗi bước một Thread lease riêng và không lease graph nào:
  // settle (chép outcome) rồi project (chiếu checkpoint E-n thành rev N+1). Crash giữa hai
  // bước để lại projection pending — `continue` (P3) chiếu nốt trước khi mở root mới.
  let prepared: PreparedExecution | undefined;
  const settle = async (outcome: ThreadExecutionOutcome): Promise<void> => {
    await dependencies.threads.settleRoot(thread.id, executionId, outcome);
    // Lịch sử là best-effort giữa settle và project: transcript hỏng không được chặn bản
    // chiếu, và cũng không được giữ lease nào của bước kia (mỗi bước một lease riêng).
    const source = prepared ? historySourceOf(prepared) : null;
    if (source) await collectHistory(dependencies.threads, thread.id, source);
    await dependencies.threads.projectContext(thread.id, executionId, await projectionInput(prepared));
  };
  const result = await withRootFailure(dependencies.graph, root, settle, async () => {
    const execution = await dependencies.executionService.materialize(authorization, {
      // Never rendered into a turn — an interactive launch writes no task file. It exists as
      // audit metadata in `identity-capsule.json`, saying what this execution was opened for.
      // The real task arrives as the principal's own first message.
      task: INTERACTIVE_TASK_SENTINEL,
      thread: reserved.binding,
      threadContext: reserved.handoff,
      mode,
      modeProfiles: profiles,
      memoryQueries: [],
      characterBudget: 0,
      invariantContext: "ALP execution policy is authoritative and fails closed.",
      policyContext: "Direct raw runtime launch is unsupported; use ALP workflows.",
    });
    prepared = execution;
    // Runtime là **hệ quả** của model, không phải một lựa chọn riêng: nấc (đã ghép settings)
    // ghim một model cho `main`, và model đó chỉ chạy được trên đúng một CLI. Đọc lại từ
    // snapshot chứ không tra lại bảng: `policy.json` và tiến trình phải nói cùng một điều.
    const adapter = dependencies.adapters.get(execution.policy.runtime);
    if (!adapter) throw new Error(`runtime \`${execution.policy.runtime}\` is not registered`);
    const health = await adapter.probe();
    if (!health.ok) throw new Error(`${health.message}${health.remediation ? `; ${health.remediation}` : ""}`);
    const launchSpec = await adapter.prepare({
      execution,
      // Nấc thắng khai báo của vai — cùng một `main` chạy bốn model khác nhau. Lấy thẳng từ
      // policy, để `policy.json` và tiến trình thật sự chạy không thể lệch nhau.
      model: execution.policy.model,
      reasoningEffort: execution.policy.reasoningEffort,
      interactive: true,
      binding: root.binding,
    });
    const backendHealth = await dependencies.backend.healthCheck();
    if (!backendHealth.ok) throw new Error(backendHealth.message);
    // Spawn chạy **dưới** lease của graph: nhả lease trước khi backend có record là mở một
    // cửa sổ mà cây nói "đang chạy" còn process thì chưa tồn tại. `wait` thì ở ngoài — giữ
    // lease suốt phiên là khoá cả cây lại trong lúc nó đang cần đẻ con.
    const spawned = await dependencies.graph.startRoot(root.binding, async () =>
      // The principal is sitting in front of this one, so it must own the terminal: a backend
      // that tees stdout instead of inheriting it would leave the session with no tty and no
      // way to type. `interactive` is the only thing that keeps `stdio: "inherit"` here.
      dependencies.backend.spawn({
        executionId,
        launchSpec,
        lifecycle: {
          requestId: executionId,
          parentExecutionId: null,
          background: false,
          interactive: true,
          timeoutMs: null,
          // Hạn tuyệt đối của cây được chốt đúng một lần, ở root, và mọi process trong cây
          // nhận lại đúng timestamp đó.
          deadlineAt: root.binding.deadlineAt,
        },
      }));
    const backendResult = spawned.status === "running"
      ? await dependencies.backend.wait(executionId)
      : spawned;
    const result = await reconcile(backendResult, execution.artifacts?.stateFile);
    // Kết cục của phiên là kết cục của root. Ghi nó ở đây chứ không ở `finally`: một lần
    // ném từ phía trên đã được `withRootFailure` ghi là `failed`, và ghi đè lần nữa chỉ đổi
    // thông điệp lỗi thành một dòng vô nghĩa hơn.
    await dependencies.graph.finishExecution(root.binding, {
      status: result.status === "completed" ? "completed"
        : result.status === "cancelled" ? "cancelled"
        : "failed",
      ...(result.error ? { error: { code: result.error.code, message: result.error.message } } : {}),
    });
    return result;
  });
  // Sau khi graph đã terminal, và ngoài mọi lease graph: Thread chép lại kết cục một lần.
  await settle(threadOutcome(result.status));
  return result;
}

function threadOutcome(status: BackendExecutionResult["status"]): ThreadExecutionOutcome {
  return status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "failed";
}

/**
 * Những gì E-n để lại cho projector. Checkpoint đi qua `readCheckpoint` — sai integrity hay
 * lệch policy thì là `null`, và revision mới mang `degraded` thay vì mang pins không tin được.
 * Chưa materialize thì không có gì cả: chỉ outcome.
 */
async function projectionInput(prepared: PreparedExecution | undefined): Promise<ProjectContextInput> {
  if (!prepared?.artifacts?.checkpointFile) return { checkpoint: null, runtime: prepared?.policy.runtime ?? null };
  return projectionInputFromFiles(prepared.artifacts.checkpointFile, {
    executionId: prepared.policy.executionId,
    policyHash: prepared.policy.policyHash,
    runtime: prepared.policy.runtime,
  });
}

/**
 * Cùng đầu vào, nhưng cho một root mà process này chưa từng thấy: đọc `policy.json` của nó
 * trên đĩa để biết policyHash và runtime. Không có policy (chết trước materialize) → chỉ
 * outcome, không runtime.
 */
async function projectionInputFromDisk(executionsRoot: string, executionId: string): Promise<ProjectContextInput> {
  const directory = join(executionsRoot, executionId);
  let policy: { readonly policyHash?: unknown; readonly runtime?: unknown };
  try {
    policy = JSON.parse(await readFile(join(directory, "policy.json"), "utf8"));
  } catch {
    return { checkpoint: null, runtime: null };
  }
  const runtime = policy.runtime === "claude" || policy.runtime === "codex" ? policy.runtime : null;
  if (typeof policy.policyHash !== "string") return { checkpoint: null, runtime };
  return projectionInputFromFiles(join(directory, "context", "checkpoint.json"), {
    executionId,
    policyHash: policy.policyHash,
    runtime,
  });
}

/**
 * Mirror transcript vào Thread, nuốt mọi lỗi: `collectHistory` đã tự hạ xuống `final-only`
 * khi transcript không đọc được, phần còn lại (store hỏng, lease) không đáng để một phiên
 * đã chạy xong mất bản chiếu context của nó.
 */
async function collectHistory(
  threads: Pick<ThreadService, "collectHistory">,
  threadId: ThreadId,
  source: HistoryExecutionSource,
): Promise<void> {
  try {
    await threads.collectHistory(threadId, source);
  } catch {
    /* best-effort */
  }
}

/** Nguồn transcript của một root mà process này chưa từng thấy — chỉ còn `policy.json` + `context/`. */
export async function historySourceFromDisk(executionsRoot: string, executionId: string): Promise<HistoryExecutionSource> {
  const directory = join(executionsRoot, executionId);
  let policy: { readonly runtime?: unknown; readonly workspace?: unknown } = {};
  try {
    policy = JSON.parse(await readFile(join(directory, "policy.json"), "utf8"));
  } catch {
    /* chết trước materialize: không runtime, không transcript */
  }
  return {
    executionId,
    runtime: policy.runtime === "claude" || policy.runtime === "codex" ? policy.runtime : null,
    workspace: typeof policy.workspace === "string" ? policy.workspace : "",
    contextDirectory: join(directory, "context"),
  };
}

async function projectionInputFromFiles(
  checkpointFile: string,
  binding: { readonly executionId: string; readonly policyHash: string; readonly runtime: RuntimeId | null },
): Promise<ProjectContextInput> {
  const read = await readCheckpoint(checkpointFile, { executionId: binding.executionId, policyHash: binding.policyHash });
  return { checkpoint: read.ok ? read.value : null, runtime: binding.runtime };
}

/**
 * Chạy phần còn lại của phiên, và nếu nó ném thì để lại một root terminal đọc được.
 *
 * Một root `preparing` vĩnh viễn là một cây mà không lệnh nào dọn được: nó vẫn tính vào trần
 * đồng thời, vẫn hiện ra trong `alp delegation tree`, và không có process nào để giết. Lỗi
 * gốc vẫn là thứ được ném lên — `failExecution` chỉ ghi lại, không nuốt.
 */
async function withRootFailure(
  graph: RunMainDependencies["graph"],
  root: Awaited<ReturnType<ExecutionGraphService["createRoot"]>>,
  settle: (outcome: ThreadExecutionOutcome) => Promise<void>,
  session: () => Promise<BackendExecutionResult>,
): Promise<BackendExecutionResult> {
  try {
    return await session();
  } catch (error) {
    await graph.failExecution(root.binding, error).catch(() => undefined);
    // Graph đã terminal, rồi mới tới Thread — cùng thứ tự với đường thành công. Nếu chính
    // bước này hỏng, ref còn unsettled và reconcile (P3) dọn theo graph.
    await settle("failed").catch(() => undefined);
    throw error;
  }
}

/**
 * Kết quả của backend, chỉnh lại theo `state.json` khi execution tự ghi kết cục của nó.
 *
 * Exit code trả lời "process có chết sạch không"; `state.json` trả lời "công việc có xong
 * không". Hai câu khác nhau, và câu thứ hai là câu principal hỏi.
 */
async function reconcile(
  backendResult: BackendExecutionResult,
  stateFile: string | undefined,
): Promise<BackendExecutionResult> {
  if (!stateFile || !["completed", "failed", "cancelled"].includes(backendResult.status)) {
    return backendResult;
  }
  try {
    const state = JSON.parse(await readFile(stateFile, "utf8")) as { status?: unknown; output?: unknown };
    const status = ["completed", "failed", "cancelled"].includes(String(state.status))
      ? state.status as BackendExecutionResult["status"]
      : backendResult.status;
    return {
      ...backendResult,
      status,
      ...(state.output === undefined
        ? {}
        // Prose answers pass through unchanged; only a non-string is serialized.
        : { output: typeof state.output === "string" ? state.output : JSON.stringify(state.output) }),
    };
  } catch { return backendResult; }
}

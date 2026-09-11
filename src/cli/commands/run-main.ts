import type { AgentDefinition, AgentRegistry, RuntimeId } from "../../agents/types";
import { MODE_PROFILES, type ModeId, type ModeProfiles } from "../../agents/modes";
import { readFile } from "node:fs/promises";
import type { BackendExecutionResult, ExecutionBackend } from "../../backend/execution-backend";
import { INTERACTIVE_TASK_SENTINEL } from "../../context/continuity";
import type { ExecutionService } from "../../execution/execution-service";
import type { ExecutionGraphService } from "../../execution/graph/execution-graph-service";
import type { RuntimeAdapter } from "../../runtime/runtime-adapter";
import type { ModeSelector } from "../mode-selector";

export interface RunMainInput {
  readonly cwd: string;
  /** Nấc công suất cho phiên này. Bỏ trống thì selector hỏi (TTY) hoặc lấy nấc đã lưu. */
  readonly mode?: ModeId;
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
  // Cây trước file. Mọi thứ `materialize()` sinh ra từ đây đã có một node để bị đếm, bị chờ
  // và bị huỷ — kể cả khi process này chết ngay dòng sau.
  const root = await dependencies.graph.createRoot({ agentId: definition.id, executionId });
  return withRootFailure(dependencies, root, async () => {
    const execution = await dependencies.executionService.materialize(authorization, {
      // Never rendered into a turn — an interactive launch writes no task file. It exists as
      // audit metadata in `identity-capsule.json`, saying what this execution was opened for.
      // The real task arrives as the principal's own first message.
      task: INTERACTIVE_TASK_SENTINEL,
      mode,
      modeProfiles: profiles,
      memoryQueries: [],
      characterBudget: 0,
      invariantContext: "ALP execution policy is authoritative and fails closed.",
      policyContext: "Direct raw runtime launch is unsupported; use ALP workflows.",
    });
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
}

/**
 * Chạy phần còn lại của phiên, và nếu nó ném thì để lại một root terminal đọc được.
 *
 * Một root `preparing` vĩnh viễn là một cây mà không lệnh nào dọn được: nó vẫn tính vào trần
 * đồng thời, vẫn hiện ra trong `alp delegation tree`, và không có process nào để giết. Lỗi
 * gốc vẫn là thứ được ném lên — `failExecution` chỉ ghi lại, không nuốt.
 */
async function withRootFailure(
  dependencies: Pick<RunMainDependencies, "graph">,
  root: Awaited<ReturnType<ExecutionGraphService["createRoot"]>>,
  session: () => Promise<BackendExecutionResult>,
): Promise<BackendExecutionResult> {
  try {
    return await session();
  } catch (error) {
    await dependencies.graph.failExecution(root.binding, error).catch(() => undefined);
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

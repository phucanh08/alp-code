import { parseMode, type ModeProfiles } from "../../agents/modes";
import { join } from "node:path";
import { agentRegistry } from "../../agents/registry";
import type { AgentRegistry, RuntimeId } from "../../agents/types";
import { LocalProcessBackend } from "../../backend/local-process-backend";
import { DelegationService, FileDelegationExecutionStore, type DelegationAcceptanceView, type DelegationEvidenceView } from "../../delegation/delegation-service";
import { ProjectRegistryStore } from "./init";
import type { DelegationResult } from "../../delegation/types";
import { gitBaselineProbe } from "../../execution/evidence-baseline";
import { ExecutionService } from "../../execution/execution-service";
import { FileExecutionStore } from "../../execution/execution-store";
import {
  ExecutionGraphService,
  readBindingFromEnvironment,
  type ExecutionTreeNode,
  type ExecutionTreeView,
} from "../../execution/graph/execution-graph-service";
import { FileExecutionGraphStore } from "../../execution/graph/file-execution-graph-store";
import { evaluateBudget, NO_USAGE, USAGE_COLUMNS, type ExecutionTreeUsageLike } from "../../execution/usage";
import { renderUsage } from "../usage-format";
import { MarkdownFileStore } from "../../memory/adapters/markdown-file-store";
import { MemoryService } from "../../memory/memory-service";
import { PolicyEngine } from "../../policy/policy-engine";
import { ClaudeRuntimeAdapter } from "../../runtime/claude-adapter";
import { ClaudeHistoryBridge } from "../../runtime/claude-history-bridge";
import { CodexRuntimeAdapter } from "../../runtime/codex-adapter";
import { CodexHistoryBridge } from "../../runtime/codex-history-bridge";
import { HistoryBridgeRegistry } from "../../thread/history-bridge";
import { trustedVerifyFile, verifyTrusted } from "../../trust";
import { loadVerifyCommands } from "../settings";
import type { RuntimeAdapter } from "../../runtime/runtime-adapter";
import { WorkflowRunner } from "../../workflow/workflow-runner";
import type { InstallLayout } from "../../install-layout";
import { RelayServer, spawnRelayExecutor } from "../../execution/relay-server";
import { loadDelegationConfig } from "../../install/config";
import { executionGraphsDirectory, executionsDirectory, memoryRoot } from "../../install/paths";

export interface RunDelegateDependencies {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly service: Pick<
    DelegationService,
    "delegate" | "wait" | "status" | "cancel" | "cleanup" | "listExecutions" | "tree" | "evidence" | "accept" | "reject"
  >;
  /** The project's registry — built-ins plus its trusted agents. Used to read the target's declared write roots. */
  readonly registry?: Pick<AgentRegistry, "get" | "has">;
}

/**
 * The two spellings of "which project". Named once because two readers need them: the parse
 * loop below, and the caller that has to build the project's registry *before* the service
 * exists — an agent trusted in that project is only reachable if the registry knows it.
 */
export const WORKSPACE_FLAGS = Object.freeze(["--workspace", "--project"]);

export function workspaceFromArgs(argv: readonly string[], cwd: string): string {
  for (let index = 0; index < argv.length; index += 1) {
    if (WORKSPACE_FLAGS.includes(argv[index])) return argv[index + 1] ?? cwd;
  }
  return cwd;
}

/**
 * Vai đích có khai write root nào không.
 *
 * Một tên không có trong registry vẫn đi tiếp với `read-only`: câu trả lời "vai này không tồn
 * tại" thuộc về `ExecutionService`, nơi nó được nói bằng đúng mã lỗi, chứ không phải một
 * exception bật ra ở chỗ đang tính quyền workspace.
 */
function writesWorkspace(registry: Pick<AgentRegistry, "get" | "has">, role: string): boolean {
  return registry.has(role) && registry.get(role).capabilities.workspace.writeRoots.length > 0;
}

const BUDGET_FLAGS = [
  { name: "--budget-tokens", field: "tokens" },
  { name: "--budget-tool-calls", field: "toolCalls" },
] as const;

function required(args: readonly string[], index: number, message: string): string {
  const value = args[index];
  if (!value) throw new Error(message);
  return value;
}

export async function runDelegateCommand(
  argv: readonly string[],
  dependencies: RunDelegateDependencies,
): Promise<DelegationResult> {
  const targetRole = argv[0];
  if (!targetRole) throw new Error("delegate requires a target role");
  let background = false;
  let timeoutMs: number | null = null;
  let workspace = dependencies.cwd;
  const writeScope: string[] = [];
  const requiredEvidence: string[] = [];
  const budget: { tokens?: number; toolCalls?: number } = {};
  const task: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    const budgetFlag = BUDGET_FLAGS.find((flag) => value === flag.name || value.startsWith(`${flag.name}=`));
    if (budgetFlag !== undefined) {
      // Observe-only: a ceiling the parent wants reported against, never one ALP enforces mid-run.
      const raw = value === budgetFlag.name ? required(argv, ++index, `${budgetFlag.name} requires a positive integer`) : value.slice(budgetFlag.name.length + 1);
      const parsed = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${budgetFlag.name} must be a positive integer, got \`${raw}\``);
      budget[budgetFlag.field] = parsed;
    } else if (value === "--runtime") {
      // Nấc quyết định model, model quyết định CLI. Một cờ `--runtime` còn sót trong script
      // cũ sẽ chọn sai CLI cho model của nấc, nên nó dừng ở đây chứ không bị bỏ qua.
      throw new Error("`--runtime` không còn tồn tại; nấc quyết định model và runtime — dùng `alp mode set` hoặc ALP_MODE");
    } else if (value === "--background") background = true;
    else if (value === "--timeout-ms") {
      timeoutMs = Number(required(argv, ++index, "--timeout-ms requires a number"));
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be positive");
    } else if (WORKSPACE_FLAGS.includes(value)) {
      workspace = required(argv, ++index, `${value} requires a path`);
    } else if (value === "--write-scope") {
      // Repeatable: each flag names one subtree of the workspace the child may write.
      writeScope.push(required(argv, ++index, "--write-scope requires a path"));
    } else if (value === "--require-evidence") {
      // Repeatable: `change` or `verify:<id>`; the service validates the spelling.
      requiredEvidence.push(required(argv, ++index, "--require-evidence requires `change` or `verify:<id>`"));
    } else if (value === "--parent-role" || value === "--role" || value === "--kind") {
      throw new Error(`unsupported identity-aware raw-runtime shortcut \`${value}\``);
    } else if (value === "--backend") {
      // Rejected rather than ignored. Unknown words fall through to the task below, so a
      // stale `--backend paseo` left in a script would otherwise be handed to the agent as
      // part of what it was asked to do, and the run would look fine while doing the wrong
      // thing. There is one backend now; saying so is the only honest answer.
      throw new Error("`--backend` was removed: delegation always runs on the local backend");
    } else if (value !== "--") task.push(value);
  }
  if (!task.join(" ").trim()) throw new Error("delegate requires a task");
  // Cha là ai không còn được hỏi ở đây. `ALP_ROLE` sửa được bằng một dòng `export`, nên mọi
  // lần đọc nó là một lần nhận lời khai; `DelegationService` xác thực capability thừa hưởng
  // rồi đọc vai từ chính node trong cây.
  const registry = dependencies.registry ?? agentRegistry;
  const spawned = await dependencies.service.delegate({
    targetRole,
    task: task.join(" "),
    workspace,
    // Ai hỏi không còn quyết định được ghi hay không — vai đích quyết định. Từ 2026-09-10
    // `main` không khai write root nào nữa, nên luật cũ ("principal giao cho main thì được
    // ghi") vừa cấp một quyền `main` không cầm nổi, vừa bỏ đói `worker` — vai duy nhất còn
    // cầm bút. Hỏi đúng definition thì cả hai chuyện đó tự hết, và PolicyEngine vẫn là chốt
    // cuối: một vai không khai write root mà xin ghi thì bị chặn ở đó chứ không ở đây.
    workspaceMode: writesWorkspace(registry, targetRole) ? "workspace-write" : "read-only",
    // Only when asked for: absent means the whole workspace, and the service (not this
    // parser) is where a scope on a read-only role is refused, by policy.
    ...(writeScope.length === 0 ? {} : { writeScope }),
    ...(requiredEvidence.length === 0 ? {} : { requiredEvidence }),
    ...(Object.keys(budget).length === 0 ? {} : { budget }),
    metadata: {},
    executionOptions: { background, interactive: false, timeoutMs },
  });
  return !background && spawned.status === "running"
    ? dependencies.service.wait(spawned.executionId, { timeoutMs })
    : spawned;
}

/**
 * Kết quả đã được định dạng sẵn, để caller in thẳng thay vì bọc trong JSON.
 *
 * Mọi lệnh delegation khác trả về một object và `alp` in nó ra dưới dạng JSON — đúng với
 * chúng, vì chúng là dữ liệu để script đọc. `tree` thì tồn tại để *người* đọc, và một cây
 * JSON lồng bốn tầng là đúng cái thứ mà lệnh này sinh ra để thay thế.
 */
export interface RenderedOutput {
  readonly [RENDERED_OUTPUT]: true;
  readonly rendered: string;
}

/**
 * Nhãn chứ không phải tên trường: `status` và `wait` trả về payload của backend, và một
 * backend hoàn toàn có thể có `rendered` của riêng nó. Nhận diện bằng tên sẽ để payload ấy
 * cướp đường in và nuốt mất phần JSON mà script đang đọc.
 */
const RENDERED_OUTPUT = Symbol.for("alp.cli.renderedOutput");

export function renderedOutput(rendered: string): RenderedOutput {
  return { [RENDERED_OUTPUT]: true, rendered };
}

export function isRenderedOutput(value: unknown): value is RenderedOutput {
  return typeof value === "object" && value !== null && (value as RenderedOutput)[RENDERED_OUTPUT] === true;
}

/** Vì sao một node dừng, gói trong một câu. `null` khi nó chưa dừng, hoặc dừng bình thường. */
function nodeAnnotation(node: ExecutionTreeNode): string | null {
  if (node.cancellation) {
    const reason = node.terminationReason === "deadline"
      ? `${node.cancellation.reason} (deadline)`
      : node.cancellation.reason;
    return `${reason} · requested by ${node.cancellation.requestedBy}`;
  }
  return node.error ? `${node.error.code}: ${node.error.message}` : null;
}

function renderBranch(
  node: ExecutionTreeNode,
  highlighted: string,
  prefix: string,
  isLast: boolean,
  isRoot: boolean,
): readonly string[] {
  const connector = isRoot ? "" : isLast ? "└─ " : "├─ ";
  const annotation = nodeAnnotation(node);
  const line = [
    `${prefix}${connector}${node.agentId}`,
    node.executionId,
    node.status,
    ...(node.requestId ? [`req ${node.requestId}`] : []),
    ...(annotation ? [annotation] : []),
    // Đã thu evidence thì nói kết luận; chưa thu mà có đòi thì nói "chưa" — cha đọc cây
    // để biết còn phải `alp delegation evidence` hay không.
    ...(node.evidence ? [`evidence ${node.evidence.evaluation}`] : node.requiredEvidence.length > 0 ? ["evidence pending"] : []),
    // Phán quyết của cha (P4): có thì in; con đã dừng mà chưa có thì nói "undecided" — đó là
    // việc còn nợ, không phải một chi tiết.
    ...(node.acceptance ? [`decision ${node.acceptance.decision}`] : node.requestId && node.endedAt ? ["decision undecided"] : []),
    // Cái node đã tốn, như bridge đếm — bốn cột token tách riêng vì mỗi runtime đếm cache
    // một kiểu. Có khai budget thì nói so ra sao; `exceeded` là để cha *thấy*, không đổi gì.
    ...(node.usage ? [`usage ${renderUsage(node.usage)}`] : []),
    ...(node.budget ? [`budget ${evaluateBudget(node.budget, node.usage)}`] : []),
  ].join("  ·  ") + (node.executionId === highlighted ? "  ←" : "");
  // Con nối tiếp dưới thân của cha: một cây thụt lề bằng khoảng trắng không đọc được khi
  // một nhánh dài hơn màn hình.
  const childPrefix = isRoot ? "" : `${prefix}${isLast ? "   " : "│  "}`;
  return [
    line,
    ...node.children.flatMap((child, index) =>
      renderBranch(child, highlighted, childPrefix, index === node.children.length - 1, false)),
  ];
}

/**
 * Cây cho người đọc: trần và hạn ở trên, rồi root xuống lá.
 *
 * Trần được in kể cả khi chưa chạm tới. Câu hỏi mà người vận hành mang tới lệnh này thường
 * là "vì sao nó không đẻ thêm con nữa", và câu trả lời gần như luôn là một con số trong khối
 * này — nhưng chỉ khi con số đó nằm ngay đó để so.
 */
export function renderExecutionTree(view: ExecutionTreeView): string {
  const { limits, delegation, summary } = view;
  return [
    `graph ${view.graphId}  ·  revision ${view.revision}  ·  updated ${view.updatedAt}`,
    // Cây thuộc về một Thread (đơn vị công việc) — hoặc là cây của bản `alp` trước Thread.
    `thread ${view.thread ? `${view.thread.id}  ·  context rev ${view.thread.contextRevision}` : "legacy-unthreaded"}`,
    `deadline ${view.deadlineAt}`,
    `delegation ${delegation.used}/${delegation.limit} used  ·  ${delegation.remaining} remaining`,
    `nodes ${summary.total}  ·  ${summary.active} active  ·  ${summary.pending} slot(s) held`,
    `limits: depth ≤ ${limits.maxDepth}  ·  ${limits.maxChildrenPerExecution} children/execution  ·  `
      + `${limits.maxConcurrentChildrenPerExecution} concurrent children  ·  `
      + `${limits.maxConcurrentExecutions} concurrent executions`,
    renderTreeUsage(view.usage),
    "",
    ...renderBranch(view.root, view.executionId, "", true, true),
    "",
  ].join("\n");
}

/** Tổng theo cây; `partial` khi có node chưa có số — kể cả node còn chạy. Chưa có số nào thì nói thẳng. */
function renderTreeUsage(usage: ExecutionTreeUsageLike): string {
  const { total, partial } = usage;
  if (partial && USAGE_COLUMNS.every((column) => total[column] === NO_USAGE[column])) return "usage not measured";
  return `usage in ${total.inputTokens}  ·  out ${total.outputTokens}  ·  cache r/w ${total.cacheReadTokens}/${total.cacheWriteTokens}  ·  tools ${total.toolCalls}${partial ? "  (partial)" : ""}`;
}

/** Một dòng cho một item: nguồn, độ tin, rồi phần người đọc cần để tự kiểm lại. */
function renderEvidenceItem(item: DelegationEvidenceView["items"][number]): string {
  const head = `  ${item.kind.padEnd(14)} ${item.provenance.padEnd(13)} ${item.source}`;
  switch (item.kind) {
    case "change": {
      const paths = item.paths.length === 0 ? "no path changed" : `${item.paths.length} path(s)${item.commit ? `, commit ${item.commit.slice(0, 12)}` : ""}`;
      const outside = item.outsideScope.length === 0 ? "" : `  · ${item.outsideScope.length} outside scope${item.outsideScopeVerified ? "" : " (unverified)"}`;
      const ambiguous = item.ambiguousWith.length === 0 ? "" : `  · ambiguous with ${item.ambiguousWith.join(", ")}`;
      return `${head}  ${paths}${outside}${ambiguous}`;
    }
    case "verify": {
      const ambiguous = item.ambiguousWith.length === 0 ? "" : `  · ambiguous with ${item.ambiguousWith.join(", ")}`;
      return `${head}  verify:${item.commandId} exit ${item.exitCode} in ${item.durationMs} ms${ambiguous}`;
    }
    case "verify-skipped":
      return `${head}  verify:${item.commandId} skipped: ${item.reason}${item.reason === "untrusted" ? " — run `alp trust verify` in the project" : ""}`;
    case "tool-call":
      return `${head}  ${item.ref.name}`;
    case "output":
      return `${head}  digest ${item.digest.slice(0, 12)}`;
    case "boundary":
      return `${head}  ${item.ref.outcome} · history ${item.ref.historyCompleteness}`;
    case "usage": {
      const budget = item.budget === null ? "no budget" : `budget ${item.status}${item.budget.tokens === undefined ? "" : ` · tokens ≤ ${item.budget.tokens}`}${item.budget.toolCalls === undefined ? "" : ` · tool calls ≤ ${item.budget.toolCalls}`}`;
      return `${head}  ${renderUsage(item.usage)} · ${budget}`;
    }
  }
}

/**
 * Evidence cho người đọc: kết luận trước, rồi từng mục đã đòi, rồi item.
 *
 * Kết luận đứng đầu vì đó là câu hỏi duy nhất cha mang tới: "đã đủ chưa". Phần dưới là để
 * cha không phải tin câu trả lời đó — mỗi item nói nó đến từ đâu và tin được tới đâu.
 */
export function renderEvidence(view: DelegationEvidenceView): string {
  const required = view.required.length === 0
    ? ["required: nothing"]
    : view.required.map((entry) => `required: ${entry}  ·  ${view.missing.includes(entry) ? "missing" : view.evaluation === "unknown" ? "unknown" : "present"}`);
  const acceptance = view.acceptance === null
    ? "decision undecided  ·  alp delegation accept|reject <request-id>"
    : `decision ${view.acceptance.decision}  ·  at ${view.acceptance.decidedAt}${view.acceptance.evidenceDigest === view.digest ? "" : `  ·  on an earlier evidence ${view.acceptance.evidenceDigest.slice(0, 12)}`}`;
  return [
    `evidence ${view.executionId}  ·  ${view.evaluation}  ·  collected ${view.collectedAt}`,
    `digest ${view.digest}  ·  history ${view.completeness}`,
    acceptance,
    ...required,
    "",
    ...view.items.map(renderEvidenceItem),
    "",
  ].join("\n");
}

/** `--reason <text>` / `--reason=<text>`, lặp được; thứ tự giữ nguyên. */
function reasonsFrom(argv: readonly string[]): string[] {
  const reasons: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--reason") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--reason requires a value");
      reasons.push(value);
      index += 1;
    } else if (arg.startsWith("--reason=")) {
      reasons.push(arg.slice("--reason=".length));
    } else if (arg !== "--json") {
      throw new Error(`unknown option \`${arg}\``);
    }
  }
  return reasons;
}

export function renderAcceptance(view: DelegationAcceptanceView): string {
  return [
    `${view.decision} ${view.requestId}  ·  execution ${view.executionId}  ·  evidence ${view.evaluation} (${view.evidenceDigest.slice(0, 12)})  ·  at ${view.decidedAt}`,
    ...view.reasons.map((reason) => `  - ${reason}`),
    "",
  ].join("\n");
}

export async function runDelegationLifecycleCommand(
  argv: readonly string[],
  service: RunDelegateDependencies["service"],
): Promise<unknown> {
  const command = argv[0];
  if (command === "status") return service.status(required(argv, 1, "status requires execution ID"));
  if (command === "wait") return service.wait(required(argv, 1, "wait requires execution ID"));
  if (command === "cancel") return service.cancel(required(argv, 1, "cancel requires execution ID"));
  if (command === "cleanup") return service.cleanup(required(argv, 1, "cleanup requires execution ID"));
  if (command === "list") return service.listExecutions();
  if (command === "tree") {
    const view = await service.tree(required(argv, 1, "tree requires execution ID"));
    return argv.includes("--json") ? view : renderedOutput(renderExecutionTree(view));
  }
  if (command === "evidence") {
    const view = await service.evidence(required(argv, 1, "evidence requires execution ID"));
    return argv.includes("--json") ? view : renderedOutput(renderEvidence(view));
  }
  if (command === "accept" || command === "reject") {
    const requestId = required(argv, 1, `${command} requires a request ID`);
    const reasons = reasonsFrom(argv.slice(2));
    if (command === "reject" && reasons.length === 0) throw new Error("reject requires --reason \"<why>\"");
    const view = command === "accept" ? await service.accept(requestId, { reasons }) : await service.reject(requestId, { reasons });
    return argv.includes("--json") ? view : renderedOutput(renderAcceptance(view));
  }
  throw new Error(`unknown delegation lifecycle command \`${command ?? ""}\``);
}

/**
 * Thư mục state mà mọi phiên của máy này chạy backend trên đó — root lẫn con.
 *
 * Một hàm chứ không phải hai lần gọi `loadDelegationConfig` ở hai file: `alp` và
 * `alp delegate` phải đọc cùng một `local.json`, nếu không thì `alp delegation cancel` ở
 * process sau không tra nổi execution mà process trước đã mở, và bảng process nào cũng đúng
 * một nửa.
 */
export function sharedBackendStateDirectory(
  layout: Pick<InstallLayout, "installRoot" | "channel">,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return loadDelegationConfig(layout.installRoot, env, layout.channel).stateDir;
}

export interface DefaultDelegationComposition {
  readonly service: DelegationService;
  readonly config: { stateDir: string };
}

export async function createDefaultDelegationComposition(
  layout: InstallLayout,
  env: NodeJS.ProcessEnv = process.env,
  /** The project's registry — built-ins plus its trusted agents. Defaults to built-ins only. */
  registry: AgentRegistry = agentRegistry,
  /** Loadout đã ghép settings của máy/project. Bỏ trống thì chạy đúng bản built-in. */
  modeProfiles?: ModeProfiles,
): Promise<DefaultDelegationComposition> {
  const config = loadDelegationConfig(layout.installRoot, env, layout.channel);
  // The one backend. It spawns the runtime as a child process, so it needs no daemon and
  // works on a machine where nothing else is installed — and it hands the runtime its own
  // settings file, which is what makes a role's `permissions.deny` real rather than
  // advisory. Its state lives in `local.json` under the delegation state directory, so a
  // later CLI process can run lifecycle commands against an execution this one started.
  const backend = new LocalProcessBackend({
    env,
    stateDir: config.stateDir,
    ...(layout.channel === "dev" ? {} : {
      supervisorInvocation: { executable: layout.selfExecutable, args: ["__internal", "supervisor"] },
    }),
  });
  // `~/.alp/executions/` holds every `policy.json` and evidence file: no launch may ever be
  // handed a scope, or a whole workspace, that can write there.
  const executionsRoot = executionsDirectory(env);
  const policy = new PolicyEngine({ registry, protectedRoots: [executionsRoot] });
  const memory = new MemoryService({
    store: new MarkdownFileStore({ root: memoryRoot(env) }),
    policy,
    audit: { record() {} },
  });
  // `~/.alp/executions/<id>/` — cùng chỗ với phiên root. Hai root khác nhau từng là một
  // câu hỏi mở trong `docs/architecture.md`: doctor, hook và `alp context` đều đọc một nơi,
  // nên artifact của con nằm ở nơi kia là artifact không ai tìm thấy.
  const executionService = new ExecutionService({
    registry,
    policy,
    memory,
    workflowRunner: new WorkflowRunner(),
    store: new FileExecutionStore({ root: executionsRoot }),
    // Ảnh chụp work tree trước mỗi launch ghi được: không có nó, `change` chỉ có thể là `unknown`.
    baseline: (workspace) => gitBaselineProbe().capture(workspace),
  });
  const service = new DelegationService({
    registry,
    policy,
    memory,
    executionService,
    // Cùng thư mục cây mà `alp` (phiên root) ghi vào: một process sau chỉ đọc được cây của
    // process trước nếu cả hai đồng ý cây nằm ở đâu.
    graph: new ExecutionGraphService({
      store: new FileExecutionGraphStore({ root: executionGraphsDirectory(env) }),
    }),
    // Bốn biến env, tất-cả-hoặc-không: một nửa binding chỉ dẫn tới việc đoán nốt nửa kia.
    binding: readBindingFromEnvironment(env),
    executionsRoot,
    // The bound of the one approval rule: a launch outside the parent's workspace is a
    // question only while it stays inside the registered project around that workspace.
    projectRootOf: (path) => new ProjectRegistryStore().projectContaining(path),
    runtimeAdapters: new Map<RuntimeId, RuntimeAdapter>([
      ["claude", new ClaudeRuntimeAdapter({ env })],
      ["codex", new CodexRuntimeAdapter({ env })],
    ]),
    backend,
    // Con foreground gõ `alp delegate` trong sandbox của nó: process này trả lời, bằng cùng
    // `alp` mà terminal gọi, với binding của con.
    relay: new RelayServer({ execute: spawnRelayExecutor({ stableCommand: layout.stableCommand }) }),
    executionStore: new FileDelegationExecutionStore({ file: join(config.stateDir, "code-native-executions.json") }),
    // Con kế thừa nấc của cha: một phiên `ultra` mà subagent lặng lẽ tụt về `medium` thì
    // nấc chỉ còn đúng ở ghế ngoài cùng.
    config: {
      ...(env.ALP_MODE ? { mode: parseMode(env.ALP_MODE) } : {}),
      ...(modeProfiles ? { modeProfiles } : {}),
    },
    // Evidence đọc lịch sử qua cùng hai bridge mà Thread dùng, và chỉ chạy lệnh verify của
    // khối đã `alp trust verify`.
    evidence: {
      history: new HistoryBridgeRegistry([new ClaudeHistoryBridge({ env }), new CodexHistoryBridge({ env })]),
      verifySettings: (workspace) => loadVerifyCommands(workspace, env),
      verifyTrusted: (project, digest) => verifyTrusted(project, digest, trustedVerifyFile(env)),
      env,
    },
  });
  return { service, config: { stateDir: config.stateDir } };
}

import { parseMode, type ModeProfiles } from "../../agents/modes";
import { join } from "node:path";
import { agentRegistry } from "../../agents/registry";
import type { AgentRegistry, RuntimeId } from "../../agents/types";
import { LocalProcessBackend } from "../../backend/local-process-backend";
import { DelegationService, FileDelegationExecutionStore } from "../../delegation/delegation-service";
import type { DelegationResult } from "../../delegation/types";
import { ExecutionService } from "../../execution/execution-service";
import { FileExecutionStore } from "../../execution/execution-store";
import { MarkdownFileStore } from "../../memory/adapters/markdown-file-store";
import { MemoryService } from "../../memory/memory-service";
import { PolicyEngine } from "../../policy/policy-engine";
import { ClaudeRuntimeAdapter } from "../../runtime/claude-adapter";
import { CodexRuntimeAdapter } from "../../runtime/codex-adapter";
import type { RuntimeAdapter } from "../../runtime/runtime-adapter";
import { WorkflowRunner } from "../../workflow/workflow-runner";
import type { InstallLayout } from "../../install-layout";
import { loadDelegationConfig } from "../../install/config";
import { memoryRoot } from "../../install/paths";

export interface RunDelegateDependencies {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly service: Pick<DelegationService, "delegate" | "wait" | "status" | "cancel" | "cleanup" | "listExecutions">;
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
  const task: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--runtime") {
      // Nấc quyết định model, model quyết định CLI. Một cờ `--runtime` còn sót trong script
      // cũ sẽ chọn sai CLI cho model của nấc, nên nó dừng ở đây chứ không bị bỏ qua.
      throw new Error("`--runtime` không còn tồn tại; nấc quyết định model và runtime — dùng `alp mode set` hoặc ALP_MODE");
    } else if (value === "--background") background = true;
    else if (value === "--timeout-ms") {
      timeoutMs = Number(required(argv, ++index, "--timeout-ms requires a number"));
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be positive");
    } else if (WORKSPACE_FLAGS.includes(value)) {
      workspace = required(argv, ++index, `${value} requires a path`);
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
  const parentRole = dependencies.env.ALP_DELEGATED_ROLE || dependencies.env.ALP_ROLE || "main";
  const registry = dependencies.registry ?? agentRegistry;
  const spawned = await dependencies.service.delegate({
    parentRole,
    parentExecutionId: dependencies.env.ALP_DELEGATION_EXECUTION_ID || null,
    targetRole,
    task: task.join(" "),
    workspace,
    // Ai hỏi không còn quyết định được ghi hay không — vai đích quyết định. Từ 2026-09-10
    // `main` không khai write root nào nữa, nên luật cũ ("principal giao cho main thì được
    // ghi") vừa cấp một quyền `main` không cầm nổi, vừa bỏ đói `worker` — vai duy nhất còn
    // cầm bút. Hỏi đúng definition thì cả hai chuyện đó tự hết, và PolicyEngine vẫn là chốt
    // cuối: một vai không khai write root mà xin ghi thì bị chặn ở đó chứ không ở đây.
    workspaceMode: writesWorkspace(registry, targetRole) ? "workspace-write" : "read-only",
    metadata: {},
    executionOptions: { background, interactive: false, timeoutMs },
  });
  return !background && spawned.status === "running"
    ? dependencies.service.wait(spawned.executionId, { timeoutMs })
    : spawned;
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
  throw new Error(`unknown delegation lifecycle command \`${command ?? ""}\``);
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
  const policy = new PolicyEngine({ registry });
  const memory = new MemoryService({
    store: new MarkdownFileStore({ root: memoryRoot(env) }),
    policy,
    audit: { record() {} },
  });
  const executionService = new ExecutionService({
    registry,
    policy,
    memory,
    workflowRunner: new WorkflowRunner(),
    store: new FileExecutionStore({ root: join(config.stateDir, "execution-snapshots") }),
  });
  const service = new DelegationService({
    registry,
    policy,
    memory,
    executionService,
    runtimeAdapters: new Map<RuntimeId, RuntimeAdapter>([
      ["claude", new ClaudeRuntimeAdapter({ env })],
      ["codex", new CodexRuntimeAdapter({ env })],
    ]),
    backend,
    executionStore: new FileDelegationExecutionStore({ file: join(config.stateDir, "code-native-executions.json") }),
    // Con kế thừa nấc của cha: một phiên `ultra` mà subagent lặng lẽ tụt về `medium` thì
    // nấc chỉ còn đúng ở ghế ngoài cùng.
    config: {
      ...(env.ALP_MODE ? { mode: parseMode(env.ALP_MODE) } : {}),
      ...(modeProfiles ? { modeProfiles } : {}),
    },
  });
  return { service, config: { stateDir: config.stateDir } };
}

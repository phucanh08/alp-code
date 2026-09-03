import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentRegistry } from "../../agents/registry";
import type { RuntimeId } from "../../agents/types";
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
import { FileRuntimePreferenceStore } from "../../runtime/runtime-preference-store";
import { WorkflowRunner } from "../../workflow/workflow-runner";

export interface RunDelegateDependencies {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly service: Pick<DelegationService, "delegate" | "wait" | "status" | "cancel" | "cleanup" | "listExecutions">;
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
  let runtime: RuntimeId | undefined;
  let background = false;
  let timeoutMs: number | null = null;
  let workspace = dependencies.cwd;
  const task: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--runtime") {
      const selected = required(argv, ++index, "--runtime requires claude or codex");
      if (selected !== "claude" && selected !== "codex") throw new Error(`invalid runtime \`${selected}\``);
      runtime = selected;
    } else if (value === "--background") background = true;
    else if (value === "--timeout-ms") {
      timeoutMs = Number(required(argv, ++index, "--timeout-ms requires a number"));
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be positive");
    } else if (value === "--workspace" || value === "--project") {
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
  const spawned = await dependencies.service.delegate({
    parentRole,
    parentExecutionId: dependencies.env.ALP_DELEGATION_EXECUTION_ID || null,
    targetRole,
    task: task.join(" "),
    workspace,
    workspaceMode: parentRole === "principal" && targetRole === "main"
      ? "workspace-write"
      : "read-only",
    metadata: {},
    executionOptions: { background, interactive: false, timeoutMs, ...(runtime ? { runtime } : {}) },
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
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DefaultDelegationComposition> {
  const localRequire = createRequire(__filename);
  const configModule = localRequire(join(repoRoot, "scripts", "lib", "delegation", "config.cjs")) as {
    loadDelegationConfig(root: string, environment: NodeJS.ProcessEnv): { stateDir: string };
  };
  const config = configModule.loadDelegationConfig(repoRoot, env);
  // The one backend. It spawns the runtime as a child process, so it needs no daemon and
  // works on a machine where nothing else is installed — and it hands the runtime its own
  // settings file, which is what makes a role's `permissions.deny` real rather than
  // advisory. Its state lives in `local.json` under the delegation state directory, so a
  // later CLI process can run lifecycle commands against an execution this one started.
  const backend = new LocalProcessBackend({ env, stateDir: config.stateDir });
  const preference = await new FileRuntimePreferenceStore({
    file: join(env.HOME || homedir(), ".alp", "runtime.json"),
  }).read();
  const policy = new PolicyEngine({ registry: agentRegistry });
  const memory = new MemoryService({
    store: new MarkdownFileStore({ root: join(repoRoot, "memory") }),
    policy,
    audit: { record() {} },
  });
  const executionService = new ExecutionService({
    registry: agentRegistry,
    policy,
    memory,
    workflowRunner: new WorkflowRunner(),
    store: new FileExecutionStore({ root: join(config.stateDir, "execution-snapshots") }),
  });
  const service = new DelegationService({
    registry: agentRegistry,
    policy,
    memory,
    executionService,
    runtimeAdapters: new Map<RuntimeId, RuntimeAdapter>([
      ["claude", new ClaudeRuntimeAdapter({ env })],
      ["codex", new CodexRuntimeAdapter({ env })],
    ]),
    backend,
    executionStore: new FileDelegationExecutionStore({ file: join(config.stateDir, "code-native-executions.json") }),
    config: { defaultRuntime: preference.runtime ?? "claude" },
  });
  return { service, config: { stateDir: config.stateDir } };
}

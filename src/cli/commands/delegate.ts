import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentRegistry } from "../../agents/registry";
import type { RuntimeId } from "../../agents/types";
import type { BackendExecutionResult, ExecutionBackend, SpawnExecutionInput } from "../../backend/execution-backend";
import { BackendRegistry } from "../../delegation/backend-registry";
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
import { ProjectRegistryStore } from "./init";

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
  let backend: string | undefined;
  let runtime: RuntimeId | undefined;
  let background = false;
  let timeoutMs: number | null = null;
  let workspace = dependencies.cwd;
  const task: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--backend") backend = required(argv, ++index, "--backend requires a name");
    else if (value === "--runtime") {
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
    metadata: backend ? { backend } : {},
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

interface CjsBackend {
  readonly name: string;
  healthCheck(): { readonly ok: boolean; readonly message: string };
  spawn(input: Record<string, unknown>): BackendExecutionResult;
  status(executionId: string): BackendExecutionResult;
  wait(executionId: string, options?: { readonly timeoutMs?: number | null }): BackendExecutionResult;
  cancel(executionId: string): void | BackendExecutionResult;
  cleanup(executionId: string): void;
}

class CjsExecutionBackendAdapter implements ExecutionBackend {
  readonly name: string;
  constructor(private readonly backend: CjsBackend) { this.name = backend.name; }
  async healthCheck() { return this.backend.healthCheck(); }
  async spawn(input: SpawnExecutionInput): Promise<BackendExecutionResult> {
    const lifecycle = input.lifecycle ?? {
      requestId: input.executionId,
      parentExecutionId: null,
      background: true,
      interactive: false,
      timeoutMs: null,
    };
    return this.backend.spawn({
      ...input,
      request: {
        requestId: lifecycle.requestId,
        parentExecutionId: lifecycle.parentExecutionId,
        executionOptions: {
          background: lifecycle.background,
          interactive: lifecycle.interactive,
          timeoutMs: lifecycle.timeoutMs,
        },
      },
    });
  }
  async status(executionId: string) { return this.backend.status(executionId); }
  async wait(executionId: string, options?: { readonly timeoutMs?: number | null }) { return this.backend.wait(executionId, options); }
  async cancel(executionId: string) {
    const value = this.backend.cancel(executionId);
    return value ?? { executionId, status: "cancelled" };
  }
  async cleanup(executionId: string) { this.backend.cleanup(executionId); }
}

export interface DefaultDelegationComposition {
  readonly service: DelegationService;
  readonly backendRegistry: BackendRegistry;
  readonly config: { backend: string; fallbackBackend: string | null; stateDir: string };
}

export async function createDefaultDelegationComposition(
  repoRoot: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DefaultDelegationComposition> {
  const localRequire = createRequire(__filename);
  const configModule = localRequire(join(repoRoot, "scripts", "lib", "delegation", "config.cjs")) as {
    loadDelegationConfig(root: string, environment: NodeJS.ProcessEnv): {
      backend: string;
      fallbackBackend: string | null;
      stateDir: string;
      backends: Record<string, Record<string, unknown> & { enabled: boolean }>;
    };
  };
  const config = configModule.loadDelegationConfig(repoRoot, env);
  const backendRegistry = new BackendRegistry();
  const cjsStateStore = localRequire(join(repoRoot, "scripts", "lib", "delegation", "core", "execution-store.cjs")) as {
    FileExecutionStore: new (file: string) => unknown;
  };
  if (config.backends.herdr?.enabled) {
    const { HerdrBackend } = localRequire(join(repoRoot, "scripts", "lib", "delegation", "backends", "herdr", "backend.cjs")) as {
      HerdrBackend: new (options: Record<string, unknown>) => CjsBackend;
    };
    backendRegistry.register(new CjsExecutionBackendAdapter(new HerdrBackend({
      repoRoot,
      stateDir: config.stateDir,
      state: new cjsStateStore.FileExecutionStore(join(config.stateDir, "herdr.json")),
    })));
  }
  if (config.backends.paseo?.enabled) {
    const { PaseoBackend } = localRequire(join(repoRoot, "scripts", "lib", "delegation", "backends", "paseo", "backend.cjs")) as {
      PaseoBackend: new (options: Record<string, unknown>) => CjsBackend;
    };
    backendRegistry.register(new CjsExecutionBackendAdapter(new PaseoBackend({
      config: config.backends.paseo,
      stateDir: config.stateDir,
      state: new cjsStateStore.FileExecutionStore(join(config.stateDir, "paseo.json")),
    })));
  }
  const projectBackend = await new ProjectRegistryStore({
    file: join(env.HOME || homedir(), ".alp", "projects.json"),
  }).backendFor(cwd).catch(() => null);
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
    backendRegistry,
    executionStore: new FileDelegationExecutionStore({ file: join(config.stateDir, "code-native-executions.json") }),
    config: {
      backend: projectBackend ?? config.backend,
      fallbackBackend: config.fallbackBackend,
      defaultRuntime: preference.runtime ?? "claude",
    },
  });
  return { service, backendRegistry, config: { backend: projectBackend ?? config.backend, fallbackBackend: config.fallbackBackend, stateDir: config.stateDir } };
}

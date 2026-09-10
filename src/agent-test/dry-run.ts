import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionService } from "../execution/execution-service";
import { FileExecutionStore } from "../execution/execution-store";
import type { PreparedExecution } from "../execution/types";
import { MarkdownFileStore } from "../memory/adapters/markdown-file-store";
import { MemoryService } from "../memory/memory-service";
import { PolicyEngine } from "../policy/policy-engine";
import { ClaudeRuntimeAdapter } from "../runtime/claude-adapter";
import { CodexRuntimeAdapter } from "../runtime/codex-adapter";
import type { RuntimeAdapter, RuntimeLaunchSpec } from "../runtime/runtime-adapter";
import { WorkflowRunner } from "../workflow/workflow-runner";
import type { ModeId } from "../agents/modes";
import type { AgentId, AgentRegistry, RuntimeId } from "../agents/types";

/**
 * Tier 2 of §10.3: run a role all the way through `ExecutionService.prepare` and both
 * runtime adapters, then stop before the spawn.
 *
 * Everything an execution would write goes to a temporary tree that is removed afterwards —
 * memory, execution state, the runtime config files. Nothing else is faked: the registry,
 * the policy engine with its own canonicalizer, and both adapters are the shipped ones,
 * because a dry run assembled out of doubles can only prove that the doubles agree.
 *
 * The workspace is a fresh temporary directory, never `process.cwd()`. That is not tidiness:
 * a relative workspace root resolved against the launcher's cwd passes every test run from
 * the repo and denies the project a real `--project` was pointed at.
 */
export interface AgentDryRunOptions {
  readonly role: AgentId;
  readonly registry: AgentRegistry;
  readonly hooksDirectory: string;
  readonly assetRoot?: string;
  readonly stableCommand?: string;
  /** Base environment for the adapters; state-holding entries are overridden per run. */
  readonly env?: NodeJS.ProcessEnv;
  readonly parent?: AgentId | "principal";
  readonly workspaceMode?: "read-only" | "workspace-write";
  readonly mode?: ModeId;
  readonly task?: string;
  readonly interactive?: boolean;
}

export interface AgentDryRun {
  readonly execution: PreparedExecution;
  /** The temporary tree holding everything this run wrote. Remove with `removeDryRun`. */
  readonly root: string;
  readonly workspace: string;
  readonly memoryRoot: string;
  readonly launch: Readonly<Record<RuntimeId, RuntimeLaunchSpec>>;
  /** What the SessionStart hook will deliver — identical for both runtimes. */
  readonly sessionContext: string;
  /** `mcp-config.json` as handed to Claude — `{ mcpServers: {} }` when nothing is granted. */
  readonly mcpConfig: { readonly mcpServers: Readonly<Record<string, unknown>> };
  readonly claudeSettings: {
    readonly permissions: {
      readonly additionalDirectories: readonly string[];
      readonly allow: readonly string[];
      readonly deny: readonly string[];
    };
    readonly sandbox?: { readonly filesystem?: { readonly denyWrite?: readonly string[] } };
  };
  readonly codexConfig: string;
}

/** Windows releases handles lazily; a fresh tree is deleted often enough to need the retries. */
export function removeDryRun(root: string): Promise<void> {
  return rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

export async function dryRunAgent(options: AgentDryRunOptions): Promise<AgentDryRun> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "alp-dry-run-")));
  const workspace = join(root, "project");
  const memoryRoot = join(root, "memory");
  const executionsRoot = join(root, "executions");
  await Promise.all([workspace, memoryRoot, executionsRoot].map((directory) => mkdir(directory, { recursive: true })));

  const { registry } = options;
  const policy = new PolicyEngine({ registry });
  const memory = new MemoryService({
    store: new MarkdownFileStore({ root: memoryRoot }),
    policy,
    audit: { record() {} },
  });
  const executionService = new ExecutionService({
    registry,
    policy,
    memory,
    workflowRunner: new WorkflowRunner(),
    store: new FileExecutionStore({ root: executionsRoot }),
  });

  const adapterEnv = { ...(options.env ?? {}), ALP_MEMORY_ROOT: memoryRoot };
  const adapterOptions = {
    env: adapterEnv,
    hooksDirectory: options.hooksDirectory,
    ...(options.assetRoot ? { assetRoot: options.assetRoot } : {}),
    ...(options.stableCommand ? { stableCommand: options.stableCommand } : {}),
  };
  const adapters = new Map<RuntimeId, RuntimeAdapter>([
    ["claude", new ClaudeRuntimeAdapter(adapterOptions)],
    ["codex", new CodexRuntimeAdapter(adapterOptions)],
  ]);

  const definition = registry.get(options.role);
  const execution = await executionService.prepare({
    executionId: `exec_dry_${options.role.replaceAll("-", "_")}`,
    parent: options.parent ?? (definition.reportsTo === "principal" ? "principal" : definition.reportsTo),
    target: options.role,
    task: options.task ?? `Dry-run ${options.role}`,
    workspace,
    workspaceMode: options.workspaceMode ?? "read-only",
    ...(options.mode ? { mode: options.mode } : {}),
    memoryQueries: [],
    characterBudget: 0,
    invariantContext: "ALP execution policy is authoritative and fails closed.",
    policyContext: "Use only the tools and workspace granted by the immutable execution snapshot.",
  });

  // Both runtimes, each on its own declared model — the point of tier 2 is the side-by-side
  // diff. Which one a real launch picks is a mode decision, reported separately.
  const launch: Record<string, RuntimeLaunchSpec> = {};
  for (const [runtime, adapter] of adapters) {
    launch[runtime] = await adapter.prepare({
      execution,
      model: definition.model[runtime],
      reasoningEffort: definition.reasoningEffort[runtime],
      interactive: options.interactive ?? false,
    });
  }

  const [sessionContext, claudeSettings, mcpConfig, codexConfig] = await Promise.all([
    readFile(launch.claude.env.ALP_SESSION_CONTEXT, "utf8"),
    readFile(launch.claude.env.ALP_RUNTIME_CONFIG, "utf8").then((value) => JSON.parse(value) as AgentDryRun["claudeSettings"]),
    readFile(launch.claude.args[launch.claude.args.indexOf("--mcp-config") + 1] ?? "", "utf8")
      .then((value) => JSON.parse(value) as AgentDryRun["mcpConfig"]),
    readFile(launch.codex.env.ALP_RUNTIME_CONFIG, "utf8"),
  ]);

  return {
    execution,
    root,
    workspace,
    memoryRoot,
    launch: launch as Readonly<Record<RuntimeId, RuntimeLaunchSpec>>,
    sessionContext,
    claudeSettings,
    mcpConfig,
    codexConfig,
  };
}

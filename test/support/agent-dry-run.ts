import { mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentRegistry } from "../../src/agents/registry";
import type { AgentId, RuntimeId } from "../../src/agents/types";
import { ExecutionService } from "../../src/execution/execution-service";
import { FileExecutionStore } from "../../src/execution/execution-store";
import type { PreparedExecution } from "../../src/execution/types";
import { MarkdownFileStore } from "../../src/memory/adapters/markdown-file-store";
import { MemoryService } from "../../src/memory/memory-service";
import { PolicyEngine } from "../../src/policy/policy-engine";
import { ClaudeRuntimeAdapter } from "../../src/runtime/claude-adapter";
import { CodexRuntimeAdapter } from "../../src/runtime/codex-adapter";
import type { RuntimeAdapter, RuntimeLaunchSpec } from "../../src/runtime/runtime-adapter";
import { WorkflowRunner } from "../../src/workflow/workflow-runner";
import { removeTemporary } from "./temporary-root";

/**
 * Tier 2 of the agent test tooling (vision §10.3): run a role all the way through
 * `ExecutionService.prepare` and both runtime adapters, and stop before the spawn.
 *
 * The composition is the real one — the shipped `agentRegistry`, a `PolicyEngine` with its
 * own default canonicalizer, both adapters — because that is the only thing the two 2026-09-04
 * blockers were invisible to: `test/policy/` authorizes a fake registry whose roots are
 * absolute, and `test/e2e/harness.ts` handed the engine a canonicalizer that resolved a
 * relative root against the project. Both are reasonable inside their own suite and both
 * hide the same defect, which is that a workspace grant only holds where the launcher
 * happened to be standing.
 *
 * The workspace here is therefore a fresh temporary directory, never `process.cwd()`.
 */
export interface AgentDryRunOptions {
  readonly role: AgentId;
  readonly parent?: AgentId | "principal";
  readonly workspaceMode?: "read-only" | "workspace-write";
  readonly task?: string;
  readonly interactive?: boolean;
}

export interface AgentDryRun {
  readonly execution: PreparedExecution;
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

const roots: string[] = [];

export async function cleanupDryRuns(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => removeTemporary(root)));
}

export async function dryRunAgent(options: AgentDryRunOptions): Promise<AgentDryRun> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "alp-dry-run-")));
  roots.push(root);
  const workspace = join(root, "project");
  const memoryRoot = join(root, "memory");
  const executionsRoot = join(root, "executions");
  await Promise.all([workspace, memoryRoot, executionsRoot].map((directory) => mkdir(directory, { recursive: true })));

  const policy = new PolicyEngine({ registry: agentRegistry });
  const memory = new MemoryService({
    store: new MarkdownFileStore({ root: memoryRoot }),
    policy,
    audit: { record() {} },
  });
  const executionService = new ExecutionService({
    registry: agentRegistry,
    policy,
    memory,
    workflowRunner: new WorkflowRunner(),
    store: new FileExecutionStore({ root: executionsRoot }),
  });
  const adapterEnv = {
    HOME: root,
    PATH: process.env.PATH ?? "",
    ALP_REPO_ROOT: root,
    ALP_MEMORY_ROOT: memoryRoot,
  };
  const hooksDirectory = join(process.cwd(), "hooks");
  const adapters = new Map<RuntimeId, RuntimeAdapter>([
    ["claude", new ClaudeRuntimeAdapter({ env: adapterEnv, hooksDirectory })],
    ["codex", new CodexRuntimeAdapter({ env: adapterEnv, hooksDirectory })],
  ]);

  const definition = agentRegistry.get(options.role);
  const execution = await executionService.prepare({
    executionId: `exec_dry_${options.role.replaceAll("-", "_")}`,
    parent: options.parent ?? (definition.reportsTo === "principal" ? "principal" : definition.reportsTo),
    target: options.role,
    task: options.task ?? `Dry-run ${options.role}`,
    workspace,
    workspaceMode: options.workspaceMode ?? "read-only",
    memoryQueries: [],
    characterBudget: 0,
    invariantContext: "ALP execution policy is authoritative and fails closed.",
    policyContext: "Use only the tools and workspace granted by the immutable execution snapshot.",
  });

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
    workspace,
    memoryRoot,
    launch: launch as Readonly<Record<RuntimeId, RuntimeLaunchSpec>>,
    sessionContext,
    claudeSettings,
    mcpConfig,
    codexConfig,
  };
}

import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition, AgentId } from "../../src/agents/types";
import type { ExecutionPolicy, PreparedExecution } from "../../src/execution/types";
import { removeTemporary } from "./temporary-root";

/**
 * The synthetic role, policy and prepared execution the unit-level suites build on.
 *
 * Shared rather than copied per file: these three shapes have to grow a field every time
 * `AgentDefinition` or `ExecutionPolicy` does, and a second copy is a second place to
 * forget — the kind of drift that leaves a test asserting against a policy the code no
 * longer produces. Tier 2 (`agent-dry-run.ts`) stays separate on purpose: it runs the real
 * registry through the real service, and its whole point is not being a fixture.
 */

const roots: string[] = [];

export async function cleanupExecutionFixtures(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => removeTemporary(root)));
}

export function probeDefinition(
  overrides: Partial<AgentDefinition<unknown>> = {},
): AgentDefinition<unknown> {
  const id = (overrides.id ?? "probe") as AgentId;
  return {
    id,
    displayName: "Probe",
    // Model thật, vì `createExecutionPolicy` giải luôn runtime từ model: một tên không có
    // trong `MODEL_RUNTIMES` bây giờ chết ngay lúc dựng policy, không đợi tới lúc phóng.
    model: { claude: "claude-haiku-4-5", codex: "gpt-5.6-luna" },
    reasoningEffort: { claude: "low", codex: "low" },
    reportsTo: "principal",
    delegatesTo: [],
    capabilities: {
      tools: ["Read"],
      skills: [],
      skillRoots: [],
      subagents: [],
      mcpServers: [],
      memory: { read: ["shared"], write: [] },
      workspace: { readRoots: ["/workspace"], writeRoots: [] },
    },
    instructions: { role: "Probe", purpose: "Probe instructions", rules: [] },
    workflow: {
      id: "probe-workflow",
      initial: "REPORT",
      states: { REPORT: { allowedTools: [], transitions: [], terminal: true } },
    },
    output: { name: "probe-output", schema: {}, validate: () => ({ ok: true }) },
    ...overrides,
  };
}

export function policyFixture(overrides: Partial<ExecutionPolicy> = {}): ExecutionPolicy {
  return {
    executionId: "exec-capability",
    role: "probe",
    workspace: "/workspace",
    workspaceMode: "read-only",
    model: "claude-haiku-4-5",
    reasoningEffort: "low",
    runtime: "claude",
    mode: "medium",
    workspaceAccess: "granted",
    allowedTools: ["Read", "Skill"],
    skills: ["git"],
    skillRoots: [],
    subagents: [],
    mcpServers: [],
    autoCompactTokens: { claude: null, codex: null },
    memory: { read: ["shared"], write: [] },
    delegatesTo: [],
    createdAt: "2026-09-04T00:00:00.000Z",
    definitionHash: "definition-hash",
    policyHash: "policy-hash",
    ...overrides,
  };
}

/**
 * A `PreparedExecution` on a real temporary tree, so an adapter can write its runtime files
 * where it expects to. The workspace replaces whatever the policy carried — an adapter's
 * `cwd` has to exist.
 */
export async function runtimeFixture(
  policy: ExecutionPolicy,
): Promise<{ root: string; prepared: PreparedExecution }> {
  const root = await mkdtemp(join(tmpdir(), "alp-capability-"));
  roots.push(root);
  const project = join(root, "project");
  const directory = join(root, "executions", "exec-capability");
  const runtimeDirectory = join(directory, "runtime");
  const contextDirectory = join(directory, "context");
  await mkdir(project, { recursive: true });
  await mkdir(runtimeDirectory, { recursive: true });
  await mkdir(contextDirectory, { recursive: true });
  const resolved = { ...policy, workspace: project };
  return {
    root,
    prepared: {
      capsule: {
        executionId: "exec-capability",
        definitionHash: resolved.definitionHash,
        policyHash: resolved.policyHash,
        role: resolved.role,
        displayName: "Probe",
        instructions: "Probe instructions",
        task: "probe the grant",
        activeWorkspace: project,
        memoryContext: {
          invariantContext: "invariants",
          policyContext: "policy",
          entries: [],
          diagnostics: { characterBudget: 0, charactersUsed: 0, truncated: false, omittedEntryIds: [] },
        },
        workflowState: { workflowId: "probe-workflow", currentState: "REPORT", status: "running", repairAttempts: 0 },
        allowedTools: resolved.allowedTools,
        outputContract: { name: "probe-output", schema: {} },
      },
      policy: resolved,
      state: {
        executionId: "exec-capability",
        status: "prepared",
        workflow: { workflowId: "probe-workflow", currentState: "REPORT", status: "running", repairAttempts: 0 },
        policyHash: resolved.policyHash,
        createdAt: resolved.createdAt,
      },
      artifacts: {
        directory,
        stateFile: join(directory, "state.json"),
        policyFile: join(directory, "policy.json"),
        runtimeDirectory,
        contextDirectory,
        checkpointFile: join(contextDirectory, "checkpoint.json"),
        continuityFile: join(contextDirectory, "continuity.md"),
        compactEventsFile: join(contextDirectory, "compact-events.jsonl"),
      },
    },
  };
}

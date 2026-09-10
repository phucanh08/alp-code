import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dryRunAgent as prepareDryRun,
  removeDryRun,
  type AgentDryRun,
} from "../../src/agent-test/dry-run";
import { agentRegistry } from "../../src/agents/registry";
import type { ModeId } from "../../src/agents/modes";
import type { AgentId } from "../../src/agents/types";

/**
 * Tier 2 of the agent test tooling (vision §10.3), bound to the shipped registry.
 *
 * The composition lives in `src/agents/agent-test/dry-run.ts` because `alp agent test` runs
 * exactly the same thing: a dry run the suite trusts but the command does not would be two
 * answers to one question. This wrapper only supplies the registry, the repo's hooks and an
 * isolated environment, and remembers the temporary roots so `cleanupDryRuns` can remove them.
 *
 * The composition is the real one — the shipped `agentRegistry`, a `PolicyEngine` with its
 * own default canonicalizer, both adapters — because that is the only thing the two 2026-09-04
 * blockers were invisible to: `test/policy/` authorizes a fake registry whose roots are
 * absolute, and `test/e2e/harness.ts` handed the engine a canonicalizer that resolved a
 * relative root against the project. Both are reasonable inside their own suite and both
 * hide the same defect, which is that a workspace grant only holds where the launcher
 * happened to be standing.
 */
export type { AgentDryRun };

export interface AgentDryRunOptions {
  readonly role: AgentId;
  readonly parent?: AgentId | "principal";
  readonly workspaceMode?: "read-only" | "workspace-write";
  readonly mode?: ModeId;
  readonly task?: string;
  readonly interactive?: boolean;
}

const roots: string[] = [];

export async function cleanupDryRuns(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => removeDryRun(root)));
}

export async function dryRunAgent(options: AgentDryRunOptions): Promise<AgentDryRun> {
  const run = await prepareDryRun({
    ...options,
    registry: agentRegistry,
    hooksDirectory: join(process.cwd(), "hooks"),
    // No `ALP_REPO_ROOT`: the suite must not pick up skill roots from the checkout it happens
    // to run in.
    env: { HOME: tmpdir(), PATH: process.env.PATH ?? "" },
  });
  roots.push(run.root);
  return run;
}

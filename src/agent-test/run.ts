import { capabilityCatalog, type CapabilityCatalog } from "../agents/capability-catalog";
import { DEFAULT_MODE, type ModeId } from "../agents/modes";
import type { AgentId, AgentRegistry } from "../agents/types";
import { dryRunAgent, removeDryRun } from "./dry-run";
import { runTier1 } from "./tier1";
import { runTier2 } from "./tier2";
import { runTier3 } from "./tier3";
import { AGENT_TEST_TIERS, type AgentTestCheck, type AgentTestDisclosure, type AgentTestReport, type AgentTestTier } from "./types";

export interface AgentTestOptions {
  readonly role: AgentId;
  readonly registry: AgentRegistry;
  readonly hooksDirectory: string;
  /** Where `Skill(<name>)` resolves — `<assetRoot>/skills`. */
  readonly skillsRoot: string;
  readonly assetRoot?: string;
  readonly stableCommand?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly catalog?: CapabilityCatalog;
  readonly mode?: ModeId;
  /** Defaults to every tier. Tier 4 (live) is not run from here — it costs a model call. */
  readonly tiers?: readonly AgentTestTier[];
}

/**
 * Runs the tiers cheapest first and **stops at the first red one**.
 *
 * Ordering is the point, not an optimisation: a definition that fails tier 1 has a grant
 * that does not mean what it says, so tier 2's snapshot would be a faithful rendering of a
 * broken definition and tier 3's denials would be right for the wrong reason. Reporting all
 * three would bury the one finding that has to be fixed first under a wall of consequences.
 */
export async function testAgent(options: AgentTestOptions): Promise<AgentTestReport> {
  const { registry } = options;
  const definition = registry.get(options.role);
  const mode = options.mode ?? DEFAULT_MODE;
  const tiers = options.tiers ?? AGENT_TEST_TIERS;
  const checks: AgentTestCheck[] = [];
  let disclosure: AgentTestDisclosure | null = null;
  let stoppedAt: AgentTestTier | null = null;

  const red = (tier: AgentTestTier): boolean => checks.some((check) => check.tier === tier && check.status === "fail");

  if (tiers.includes(1)) {
    checks.push(...runTier1({
      definition,
      registry,
      catalog: options.catalog ?? capabilityCatalog,
      skillsRoot: options.skillsRoot,
    }));
    if (red(1)) stoppedAt = 1;
  }

  if (stoppedAt === null && tiers.includes(2)) {
    let root: string | null = null;
    try {
      const run = await dryRunAgent({
        role: options.role,
        registry,
        hooksDirectory: options.hooksDirectory,
        mode,
        ...(options.assetRoot ? { assetRoot: options.assetRoot } : {}),
        ...(options.stableCommand ? { stableCommand: options.stableCommand } : {}),
        ...(options.env ? { env: options.env } : {}),
      });
      root = run.root;
      const tier2 = await runTier2({ definition, run, mode, skillsRoot: options.skillsRoot });
      checks.push(...tier2.checks);
      disclosure = tier2.disclosure;
    } catch (error) {
      // A prepare that throws is the finding. Reported as one check rather than raised,
      // because the operator asked what is wrong with this role, not for a stack trace.
      checks.push({
        tier: 2,
        id: "prepare",
        status: "fail",
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (root !== null) await removeDryRun(root);
    }
    if (red(2)) stoppedAt = 2;
  }

  if (stoppedAt === null && tiers.includes(3)) {
    // Probed against the same relative-root shape a delegated execution sees: an absolute
    // path that is not the launcher's own cwd.
    checks.push(...runTier3({ definition, registry, workspace: "/alp-probe/workspace" }));
    if (red(3)) stoppedAt = 3;
  }

  return {
    role: definition.id,
    displayName: definition.displayName,
    mode,
    checks: Object.freeze(checks),
    disclosure,
    stoppedAt,
    ok: !checks.some((check) => check.status === "fail"),
  };
}

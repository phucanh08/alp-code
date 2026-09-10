import type { AgentId, RuntimeId } from "../agents/types";

/**
 * The tiers of vision §10.3, cheapest first. Tier 4 (live, costs a model call) is not here:
 * it runs against a paid endpoint on a schedule, not inside a command whose whole promise is
 * that it can be run before every trust decision.
 */
export const AGENT_TEST_TIERS = [1, 2, 3] as const;
export type AgentTestTier = (typeof AGENT_TEST_TIERS)[number];

export const TIER_TITLES: Readonly<Record<AgentTestTier, string>> = Object.freeze({
  1: "static",
  2: "dry-run prepare",
  3: "deny paths",
});

export interface AgentTestCheck {
  readonly tier: AgentTestTier;
  /** Stable id so a red check can be named in a commit message or a plan. */
  readonly id: string;
  readonly status: "pass" | "fail";
  /** One line of evidence — what was checked and what was found, not a verdict alone. */
  readonly detail: string;
}

export interface AgentTestLaunchFacts {
  readonly model: string;
  readonly reasoningEffort: string;
  readonly cwd: string;
  readonly argv: readonly string[];
}

/**
 * The three things §10.3 says tier 2 must print before a principal is asked to trust a role:
 * what it may do, what leaves the machine, and what it costs.
 */
export interface AgentTestDisclosure {
  /** The Authority table exactly as the role will read it in its session context. */
  readonly authority: readonly string[];
  readonly egress: readonly string[];
  readonly cost: readonly string[];
  readonly launch: Readonly<Record<RuntimeId, AgentTestLaunchFacts>>;
}

export interface AgentTestReport {
  readonly role: AgentId;
  readonly displayName: string;
  /** Which mode the cost lines were computed for — the same choice a real launch makes. */
  readonly mode: string;
  readonly checks: readonly AgentTestCheck[];
  readonly disclosure: AgentTestDisclosure | null;
  /** The tier that stopped the run, or `null` when every requested tier ran. */
  readonly stoppedAt: AgentTestTier | null;
  readonly ok: boolean;
}

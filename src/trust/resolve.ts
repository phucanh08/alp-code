import type { LoadedAgent } from "../agents/loader";
import { hashAgentDefinition } from "../execution/execution-policy";
import { trustRecordFor, type TrustRecord } from "./trusted-agents-store";

export type TrustStatus = "trusted" | "untrusted" | "changed";

export interface TrustDecision {
  readonly agent: LoadedAgent;
  readonly status: TrustStatus;
  readonly currentHash: string;
  /** Present when a record exists — the hash the principal actually approved. */
  readonly record?: TrustRecord;
}

/**
 * Which loaded agents may be reached, decided against the approvals on disk.
 *
 * Three outcomes, not two. `changed` is the one that matters: the file was approved once and
 * is not the same file now, and §5.6 makes that a **deny**, not a warning. A warning would
 * put the decision back on whoever is reading the terminal at that moment, which is exactly
 * the moment an edited agent file is counting on.
 *
 * The hash is `hashAgentDefinition` — the same function the built-ins go through (§5.2), so
 * what is trusted here is what `policy.json` will record later.
 */
export function resolveTrust(
  agents: readonly LoadedAgent[],
  records: readonly TrustRecord[],
  projectRoot: string,
): readonly TrustDecision[] {
  return agents.map((agent) => {
    const currentHash = hashAgentDefinition(agent.definition);
    const record = trustRecordFor(records, projectRoot, agent.id);
    if (record === null) return { agent, status: "untrusted", currentHash };
    return {
      agent,
      record,
      currentHash,
      status: record.definitionHash === currentHash ? "trusted" : "changed",
    };
  });
}

export function trustedAgents(decisions: readonly TrustDecision[]): readonly LoadedAgent[] {
  return decisions.filter((decision) => decision.status === "trusted").map((decision) => decision.agent);
}

import { relative } from "node:path";
import { createTrustedRegistry, loadProjectAgents } from "../agents/loader";
import type { AgentRegistry } from "../agents/types";
import { resolveTrust, trustedAgents, type TrustDecision } from "./resolve";
import { readTrustedAgents } from "./trusted-agents-store";

export interface ProjectRegistry {
  readonly registry: AgentRegistry;
  readonly decisions: readonly TrustDecision[];
  /** One line per agent a session will not be able to reach, and why. */
  readonly notices: readonly string[];
}

/**
 * The registry a session in this project runs against.
 *
 * Everything an agent file could be is answered here, and only one of the answers grants
 * anything: loaded **and** trusted at the hash the principal approved. A file that never got
 * past the loader, one nobody has approved, and one that changed after approval all end in
 * the same place — not in the registry — because the alternative in each case is a role
 * running with authority nobody granted it.
 *
 * The difference between them is what the principal is told, which is why the notices exist:
 * an agent that silently stops being reachable after an edit is indistinguishable from a bug
 * in ALP, and the person who edited it is the only one who can say whether the edit was theirs.
 */
export async function trustedRegistryFor(
  projectRoot: string,
  options: { readonly trustFile?: string } = {},
): Promise<ProjectRegistry> {
  const load = await loadProjectAgents({ projectRoot });
  const records = readTrustedAgents(options.trustFile).records;
  const decisions = resolveTrust(load.loaded, records, projectRoot);
  // An overlay changes the prompt of a role that was already trusted, so it needs its own
  // approval (§5.7.5) — and its own outcome when it lacks one. A refused overlay does not
  // deny the role: `review` without the project's conventions is still `review`, and denying
  // a built-in because of a file beside it would take the team down over an unreviewed extra.
  const overlayDecisions = resolveTrust(load.overlays, records, projectRoot);
  const where = (path: string): string => relative(projectRoot, path) || path;

  const notices = [
    ...load.failed.map((failure) =>
      `AGENT-FILE ${failure.id} did not load (${where(failure.sourcePath)}): ${failure.issues[0]}`),
    ...decisions.flatMap((decision) => {
      if (decision.status === "trusted") return [];
      const source = where(decision.agent.sourcePath);
      return [decision.status === "changed"
        ? `DENIED     ${decision.agent.id} changed after it was trusted (${source}); run \`alp agent add ${decision.agent.id}\` to review and approve it again`
        : `UNTRUSTED  ${decision.agent.id} is not approved (${source}); run \`alp agent add ${decision.agent.id}\` to review it`];
    }),
    ...overlayDecisions.flatMap((decision) => decision.status === "trusted" ? [] : [
      `${decision.status === "changed" ? "DENIED    " : "UNTRUSTED "} skill overlay for ${decision.agent.id} (${where(decision.agent.sourcePath)}) is not approved; ${decision.agent.id} runs with its shipped skills until \`alp agent add ${decision.agent.id}\``,
    ]),
  ];

  return {
    registry: createTrustedRegistry(trustedAgents(decisions), undefined, trustedAgents(overlayDecisions)),
    decisions: [...decisions, ...overlayDecisions],
    notices,
  };
}

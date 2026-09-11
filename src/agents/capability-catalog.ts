import type { RuntimeModelMap, ToolId } from "./types";

/**
 * What a capability grant is allowed to name.
 *
 * §5.3: `skills`, `subagents` and `mcpServers` are declared **by name, never by path or
 * command**. A definition that could spell out `command: "npx …"` would be writing its own
 * egress, which is the one thing a declarative agent file must not be able to do. The name
 * resolves here — against a catalog the principal maintains — and the resolution is what
 * ends up in the policy snapshot, so `policy.json` records the command that actually ran
 * rather than pointing at machine config that can change underneath it.
 *
 * The two runtime-backed catalogs ship empty on purpose (§5.5): a subagent grant opens only
 * after the tier 2–3 agent tests exist, and an MCP server is a trust decision the principal
 * makes, one server at a time, with its egress printed. Empty is the fail-closed default,
 * not a placeholder — a definition naming anything at all is refused at registry load.
 */

export type SkillName = string;
export type SubagentName = string;
export type McpServerName = string;

export interface SubagentCatalogEntry {
  /** Shown to the granting model so it can decide when the subagent is the right move. */
  readonly description: string;
  readonly prompt: string;
  /** Never wider than the granting role's own tools — a subagent is not a way around a limit. */
  readonly tools: readonly ToolId[];
  readonly model?: RuntimeModelMap;
}

export interface McpServerCatalogEntry {
  readonly description: string;
  /**
   * What the server can reach once connected. Printed wherever the grant is (§5.6), because
   * "which MCP servers" is really the question "what leaves this machine".
   */
  readonly egress: "none" | "network";
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface CapabilityCatalog {
  readonly skills: readonly SkillName[];
  readonly subagents: Readonly<Record<SubagentName, SubagentCatalogEntry>>;
  readonly mcpServers: Readonly<Record<McpServerName, McpServerCatalogEntry>>;
}

/**
 * The skills in project scope (§5.7) — one entry per directory under `<repo>/skills`, kept
 * in sync by a test. A skill on disk that is not listed here is granted to nobody, which is
 * what makes adding one a deliberate step rather than a side effect of a `git pull`.
 */
export const SKILL_CATALOG = Object.freeze([
  "agent-memory",
  "alp-debug",
  "alp-plan",
  "alp-predict",
  "alp-scenario",
  "code-review",
  "delegation",
  "docs-seeker",
  "git",
  "gkg",
  "problem-solving",
  "repomix",
  "research",
  "security-scan",
  "test-quality-guard",
]);

/** Empty at v1 — §5.5. */
export const SUBAGENT_CATALOG: Readonly<Record<SubagentName, SubagentCatalogEntry>> =
  Object.freeze({});

/** Empty until the principal trusts a server by name, with its egress printed. */
export const MCP_SERVER_CATALOG: Readonly<Record<McpServerName, McpServerCatalogEntry>> =
  Object.freeze({});

export const capabilityCatalog: CapabilityCatalog = Object.freeze({
  skills: SKILL_CATALOG,
  subagents: SUBAGENT_CATALOG,
  mcpServers: MCP_SERVER_CATALOG,
});

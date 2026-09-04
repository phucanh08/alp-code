import type { AgentDefinition } from "../agents/types";
import { ALLOW, deny, type Authorization } from "./types";

/**
 * The three grants a definition declares by name: skills, in-process subagents, MCP servers.
 *
 * Each is answered from the definition, the same way tools and memory are — the grant is a
 * list of names, and anything not on it is denied with the name in the message, so a blocked
 * run says which grant would unblock it rather than only that something was refused.
 */
export class CapabilityPolicy {
  authorize(
    actor: AgentDefinition<unknown>,
    kind: "skill" | "subagent" | "mcp server",
    name: string,
    granted: readonly string[],
    code: "SKILL_NOT_GRANTED" | "SUBAGENT_NOT_GRANTED" | "MCP_SERVER_NOT_GRANTED",
  ): Authorization {
    return granted.includes(name)
      ? ALLOW
      : deny(code, `${kind} \`${name}\` is not granted to \`${actor.id}\``);
  }
}

/**
 * Both runtimes name an MCP tool `mcp__<server>__<tool>`. The server segment is what policy
 * decided on, so the tool request is routed to that grant rather than to `TOOL_CATALOG`,
 * which does not contain it and could only ever answer `TOOL_NOT_GRANTED` — true today, and
 * still true on the day the server *is* granted.
 */
export function mcpServerOf(tool: string): string | null {
  return /^mcp__(.+?)__(.+)$/.exec(tool)?.[1] ?? null;
}

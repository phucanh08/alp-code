import type { AgentRegistry } from "../agents/types";
import { ALLOW, deny, type Authorization } from "./types";

export class DelegationPolicy {
  constructor(private readonly registry: AgentRegistry) {}

  authorize(actor: string, target: string): Authorization {
    const parent = this.registry.get(actor);
    if (!this.registry.has(target)) {
      return deny("UNKNOWN_TARGET", `unknown delegation target \`${target}\``);
    }
    if (!parent.delegatesTo.includes(target)) {
      return deny(
        "DELEGATION_NOT_ALLOWED",
        `\`${actor}\` cannot delegate to \`${target}\``,
      );
    }

    const child = this.registry.get(target);
    if (child.reportsTo !== actor) {
      return deny(
        "DELEGATION_PARENT_MISMATCH",
        `\`${target}\` reports to \`${child.reportsTo}\`, not \`${actor}\``,
      );
    }
    return ALLOW;
  }
}

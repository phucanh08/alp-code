import type {
  AgentDefinition,
  MemoryScopeGrant,
} from "../agents/types";
import { memoryGrantCovers } from "../agents/memory-grant";
import { ALLOW, deny, type Authorization } from "./types";

function privateOwner(scope: MemoryScopeGrant): string | null {
  return scope.startsWith("private:") ? scope.split(":")[1] ?? null : null;
}

export class MemoryPolicy {
  authorize(
    actor: AgentDefinition<unknown>,
    operation: "read" | "write",
    scope: MemoryScopeGrant,
  ): Authorization {
    const owner = privateOwner(scope);
    if (owner !== null && owner !== actor.id) {
      return deny(
        "PRIVATE_MEMORY_DENIED",
        `\`${actor.id}\` cannot ${operation} private memory for \`${owner}\``,
      );
    }

    const grants = actor.capabilities.memory[operation];
    if (!grants.some((grant) => memoryGrantCovers(grant, scope))) {
      return deny(
        "MEMORY_NOT_GRANTED",
        `\`${actor.id}\` has no ${operation} grant for \`${scope}\``,
      );
    }
    return ALLOW;
  }
}

import { isAbsolute, relative } from "node:path";
import type { AgentDefinition, AgentId, AgentRegistry } from "../agents/types";
import { InvalidPolicyStateError } from "./errors";
import {
  ALLOW,
  deny,
  type Authorization,
  type ExecutionWorkspaceScope,
  type PathCanonicalizer,
} from "./types";

interface CanonicalWorkspaceGrants {
  readonly readRoots: readonly string[];
  readonly writeRoots: readonly string[];
}

function within(root: string, target: string): boolean {
  const relation = relative(root, target);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function canonicalizeRoots(
  definition: AgentDefinition<unknown>,
  canonicalizePath: PathCanonicalizer,
): CanonicalWorkspaceGrants {
  try {
    return Object.freeze({
      readRoots: Object.freeze(
        definition.capabilities.workspace.readRoots.map(canonicalizePath),
      ),
      writeRoots: Object.freeze(
        definition.capabilities.workspace.writeRoots.map(canonicalizePath),
      ),
    });
  } catch (error) {
    throw new InvalidPolicyStateError(
      `cannot canonicalize workspace grants for \`${definition.id}\``,
      { cause: error },
    );
  }
}

export class WorkspacePolicy {
  private readonly grants = new Map<AgentId, CanonicalWorkspaceGrants>();

  constructor(
    registry: AgentRegistry,
    private readonly canonicalizePath: PathCanonicalizer,
  ) {
    for (const definition of registry.list()) {
      this.grants.set(
        definition.id,
        canonicalizeRoots(definition, canonicalizePath),
      );
    }
  }

  authorize(
    actor: AgentId,
    operation: "read" | "write",
    inputPath: string,
    execution: ExecutionWorkspaceScope,
  ): Authorization {
    if (operation === "write" && execution.workspaceMode === "read-only") {
      return deny(
        "WORKSPACE_READ_ONLY",
        `execution workspace \`${execution.activeWorkspace}\` is read-only`,
      );
    }

    let target: string;
    let activeWorkspace: string;
    try {
      target = this.canonicalizePath(inputPath);
      activeWorkspace = this.canonicalizePath(execution.activeWorkspace);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return deny("PATH_RESOLUTION_FAILED", `cannot canonicalize workspace path: ${reason}`);
    }

    const grants = this.grants.get(actor);
    if (!grants) {
      throw new InvalidPolicyStateError(`missing workspace grants for \`${actor}\``);
    }

    if (execution.delegated && !within(activeWorkspace, target)) {
      return deny(
        "WORKSPACE_SCOPE_MISMATCH",
        `delegated execution is scoped to \`${activeWorkspace}\`, not \`${target}\``,
      );
    }
    if (!grants.readRoots.some((root) => within(root, target))) {
      return deny(
        "WORKSPACE_NOT_GRANTED",
        `\`${actor}\` cannot read workspace path \`${target}\``,
      );
    }
    if (
      operation === "write" &&
      !grants.writeRoots.some((root) => within(root, target))
    ) {
      return deny(
        "WORKSPACE_NOT_GRANTED",
        `\`${actor}\` cannot write workspace path \`${target}\``,
      );
    }
    return ALLOW;
  }
}

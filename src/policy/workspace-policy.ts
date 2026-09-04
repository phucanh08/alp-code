import { isAbsolute, join, relative } from "node:path";
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

/**
 * Resolves a role's declared roots for *this* execution.
 *
 * A relative root — `"."`, which every code-native role declares — means "the workspace
 * this execution was launched against", not "wherever the launcher process happened to be
 * standing". Resolving it once, at construction, against the launcher's cwd is what made
 * `alp delegate review --project ~/code/api` deny every path inside the project it was
 * pointed at, from any directory but the launcher's own. Absolute roots are unaffected and
 * still mean exactly what they say.
 *
 * Per-request rather than cached: an execution's active workspace is what a grant is
 * relative to, so there is nothing stable to cache under the role's id.
 */
function canonicalizeRoots(
  definition: AgentDefinition<unknown>,
  activeWorkspace: string,
  canonicalizePath: PathCanonicalizer,
): CanonicalWorkspaceGrants {
  const resolve = (root: string): string =>
    canonicalizePath(isAbsolute(root) ? root : join(activeWorkspace, root));
  try {
    return Object.freeze({
      readRoots: Object.freeze(definition.capabilities.workspace.readRoots.map(resolve)),
      writeRoots: Object.freeze(definition.capabilities.workspace.writeRoots.map(resolve)),
    });
  } catch (error) {
    throw new InvalidPolicyStateError(
      `cannot canonicalize workspace grants for \`${definition.id}\``,
      { cause: error },
    );
  }
}

export class WorkspacePolicy {
  private readonly definitions = new Map<AgentId, AgentDefinition<unknown>>();

  constructor(
    registry: AgentRegistry,
    private readonly canonicalizePath: PathCanonicalizer,
  ) {
    for (const definition of registry.list()) {
      this.definitions.set(definition.id, definition);
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

    const definition = this.definitions.get(actor);
    if (!definition) {
      throw new InvalidPolicyStateError(`missing workspace grants for \`${actor}\``);
    }
    const grants = canonicalizeRoots(definition, activeWorkspace, this.canonicalizePath);

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

import { join } from "node:path";
import { TOOL_CATALOG, type AgentId, type ToolId } from "../agents/types";
import type { ExecutionPolicy } from "../execution/types";

/**
 * Declarative ACL derived from an immutable `ExecutionPolicy`, one shape per runtime.
 *
 * This replaces the old `PreToolUse` guard hook, which spawned a Node process and loaded
 * `dist/` on *every* tool call. Both runtimes can express tool and path restrictions in
 * their own config, so the enforcement moves to where the runtime already checks it and
 * costs nothing per call.
 *
 * What is deliberately NOT covered, because neither runtime can express it declaratively:
 *  - the indirect-command guardrail (`$(...)`, backticks, `eval`, `bash -c`, `xargs`)
 *  - workflow-state tool gating (a tool allowed in EXECUTE but not in REPORT)
 *  - on Codex, read-side isolation of other roles' private memory: its sandbox restricts
 *    writes only, so that grant is instruction-level there. Claude still enforces it.
 * `PolicyEngine` still runs at `prepare` time; only the per-call interception is gone.
 */

export interface RuntimePermissionInput {
  readonly policy: ExecutionPolicy;
  readonly memoryRoot: string;
  /** Every role in the registry — needed to enumerate siblings for the deny list. */
  readonly allRoles: readonly AgentId[];
  /**
   * Whether the runtime can actually sandbox the filesystem here. False on Windows, whose
   * sandbox Claude Code does not currently activate — see `sandboxAvailable` in the Claude
   * adapter for why that changes the tool grant rather than the workspace guarantee.
   */
  readonly sandboxed?: boolean;
}

export interface ClaudePermissions {
  readonly defaultMode: "default";
  readonly additionalDirectories: readonly string[];
  readonly deny: readonly string[];
}

/**
 * Claude Code reads an absolute path in a permission rule as relative to the directory
 * holding the settings file unless it carries a DOUBLE leading slash. A single slash
 * silently matches nothing, which disables the rule with no warning at all.
 */
function absoluteRule(verb: string, path: string): string {
  return `${verb}(//${path.replace(/\\/g, "/").replace(/^\/+/, "")}/**)`;
}

export function claudePermissions(input: RuntimePermissionInput): ClaudePermissions {
  const { policy } = input;
  const ownPrivate = join(input.memoryRoot, "private", policy.role);
  const additionalDirectories = [
    policy.workspace,
    join(input.memoryRoot, "shared"),
    join(input.memoryRoot, "projects"),
    ownPrivate,
  ];

  // `deny` beats `allow` in Claude Code, and there is no "deny X except Y". Every sibling
  // must therefore be listed explicitly — a role added without regenerating this list
  // leaks, because the missing deny line reads as permission.
  const deny = input.allRoles
    .filter((role) => role !== policy.role)
    .flatMap((role) => {
      const directory = join(input.memoryRoot, "private", role);
      return [absoluteRule("Read", directory), absoluteRule("Edit", directory)];
    });

  // Tools outside the policy are denied by bare name. Claude Code only honours a path
  // argument on Read and Edit; on the others a bare name is the only rule that applies.
  for (const tool of TOOL_CATALOG) {
    if (!policy.allowedTools.includes(tool as ToolId)) deny.push(tool);
  }

  // A read-only role keeps that property through two independent mechanisms: no Write/Edit
  // grant, and a sandbox that denies writes to the workspace. Only the second one stops a
  // shell redirect, so where no sandbox exists the shell has to go instead. Losing Bash
  // makes a specialist less capable; losing read-only makes its policy a lie.
  if (policy.workspaceMode === "read-only" && input.sandboxed === false && !deny.includes("Bash")) {
    deny.push("Bash");
  }

  // Defence in depth: a delegated role must never shell out to a raw runtime, whatever
  // its tool grant says. Mirrors `src/policy/invariants.ts`.
  deny.push("Bash(herdr:*)", "Bash(paseo:*)");

  return {
    defaultMode: "default",
    additionalDirectories: Object.freeze(additionalDirectories),
    deny: Object.freeze(deny),
  };
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

/**
 * Codex config fragment. Returns TOML lines to append to `codex-config.toml`.
 * `sandbox_mode` is emitted by the adapter itself and is not repeated here.
 */
export function codexSandboxLines(input: RuntimePermissionInput): readonly string[] {
  const { policy } = input;
  const writableRoots = policy.workspaceMode === "workspace-write"
    ? [policy.workspace, join(input.memoryRoot, "private", policy.role)]
    : [];
  return Object.freeze([
    // Nothing in a delegated execution should need an approval prompt: the policy already
    // decided what is allowed, and a prompt in a background pane just hangs forever.
    `approval_policy = "never"`,
    ...(policy.allowedTools.includes("WebSearch") ? [] : [`web_search = "disabled"`]),
    "",
    "[sandbox_workspace_write]",
    `writable_roots = ${tomlStringArray(writableRoots)}`,
    `network_access = ${policy.allowedTools.includes("WebFetch") || policy.allowedTools.includes("WebSearch")}`,
    "",
    // Command-prefix rules are Codex's equivalent of Claude's `Bash(x:*)` deny entries.
    "[[rules]]",
    `prefix = ["herdr"]`,
    "allow = false",
    "",
    "[[rules]]",
    `prefix = ["paseo"]`,
    "allow = false",
    "",
  ]);
}

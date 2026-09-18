import { dirname, isAbsolute, join, relative } from "node:path";
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
 *  - on Codex, **the shell itself**. `--sandbox` picks what a model-generated command may
 *    touch, never whether commands exist, so a role holding no `Bash` can still run one.
 *    Measured 2026-09-10: `link-auditor`, granted `Read, Glob, Grep, Skill`, executed
 *    `/bin/zsh -lc "… node -e …"` on Codex and the run succeeded.
 *  - on Codex, **read-side isolation of anything** — its read-only sandbox permits reading
 *    any path on the machine, so `workspace.readRoots` and other roles' private memory are
 *    instruction-level there. Claude enforces both. Measured the same day by running
 *    `codex sandbox -c sandbox_mode='"read-only"' -- cat <path outside the workspace>`,
 *    which printed the file.
 *
 * What Codex's sandbox *does* enforce, measured the same way: writes outside the writable
 * roots (`Operation not permitted`) and network egress (`curl` → no connection). So a
 * read-only role on Codex cannot change anything or reach the network; it can read and it
 * can run commands.
 *
 * These measurements are the table in `capabilities.ts` (`capabilitiesFor`), which is what
 * `policy.json` snapshots and what `alp agent test` prints and probes — a disclosure that
 * lists grants without saying which runtime honours them is the half-truth that matters
 * most at exactly the moment a principal decides to trust an agent.
 * `PolicyEngine` still runs at `prepare` time; only the per-call interception is gone.
 */

export interface RuntimePermissionInput {
  readonly policy: ExecutionPolicy;
  readonly memoryRoot: string;
  /**
   * Where ALP wrote this execution's own files — `task.md`, `session-context.md`, the
   * identity capsule. The agent is told to read its task from there, so without this grant
   * it is being asked to open a path it has no permission for.
   *
   * A read-only role survived the omission by accident: `--permission-mode plan` lets read
   * tools through without prompting. A `workspace-write` role gets no such mode, so its very
   * first `Read` was refused and the run ended having done nothing — measured 2026-09-03 on
   * a delegated `main`.
   */
  readonly runtimeDirectory: string;
  /** Every role in the registry — needed to enumerate siblings for the deny list. */
  readonly allRoles: readonly AgentId[];
  /**
   * Whether the runtime can actually sandbox the filesystem here. False on Windows, whose
   * sandbox Claude Code does not currently activate — see `sandboxAvailable` in the Claude
   * adapter for why that changes the tool grant rather than the workspace guarantee.
   */
  readonly sandboxed?: boolean;
  /**
   * Paths that a scoped `workspace-write` policy must not write although they sit in the
   * workspace — the enumerated siblings of the scope, from `writeScopeDenyPaths`. Each one
   * becomes an `Edit` deny rule (the verb Claude Code also applies to Write, NotebookEdit and
   * MultiEdit). Absent or empty for an unscoped policy.
   */
  readonly writeScopeDenyPaths?: readonly string[];
}

function pathWithin(root: string, target: string): boolean {
  const relation = relative(root, target);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

/**
 * What must be denied so that, inside `workspace`, only `writableRoots` can be written —
 * measured for Claude Code 2.1.269 (`research/claude-sandbox-precedence.md`): `denyWrite`
 * beats `allowWrite`, so the scope cannot be *allowed*; its siblings must be *denied*.
 *
 * Every directory on the way from the workspace down to each writable root has its entries
 * listed, and each entry that is not itself on the way to some writable root is denied. A
 * writable root outside the workspace (private memory) contributes nothing: it is outside
 * the tree being confined. The result is sorted and duplicate-free so the same scope on the
 * same tree yields the same config.
 *
 * Partial by construction — hence `writeScope: "partial"` for Claude in the capability
 * table: an entry created *after* this list was generated, beside the scope, is not in it.
 */
export async function writeScopeDenyPaths(
  workspace: string,
  writableRoots: readonly string[],
  listDirectory: (directory: string) => Promise<readonly string[]>,
): Promise<readonly string[]> {
  const roots = writableRoots.filter((root) => pathWithin(workspace, root));
  const onTheWay = (path: string): boolean => roots.some((root) => pathWithin(path, root) || pathWithin(root, path));
  const ancestors = new Set<string>();
  for (const root of roots) {
    for (let directory = dirname(root); pathWithin(workspace, directory); directory = dirname(directory)) {
      ancestors.add(directory);
      if (directory === workspace || dirname(directory) === directory) break;
    }
  }
  const denied = new Set<string>();
  for (const directory of ancestors) {
    for (const entry of await listDirectory(directory)) {
      const path = join(directory, entry);
      if (!onTheWay(path)) denied.add(path);
    }
  }
  return Object.freeze([...denied].sort());
}

export interface ClaudePermissions {
  readonly defaultMode: "default";
  readonly additionalDirectories: readonly string[];
  /**
   * The named half of the ACL. `deny` can only remove a whole tool — a bare `Skill` deny
   * takes the tool out of the model's context entirely — so "these skills and no others" is
   * expressible only as an allow list under `defaultMode: "default"`: a name that is not
   * here needs approval, and a delegated execution has nobody to give it.
   */
  readonly allow: readonly string[];
  readonly deny: readonly string[];
}

/**
 * Claude Code reads an absolute path in a permission rule as relative to the directory
 * holding the settings file unless it carries a DOUBLE leading slash. A single slash
 * silently matches nothing, which disables the rule with no warning at all. Exactly two
 * is the whole contract, so the path's own leading separator has to go: a POSIX path is
 * already `/…`, and concatenating it after `//` yields three slashes — a rule that is
 * just as silently dead as one slash.
 *
 * Exported so tests can assert against this format rather than restate it. The one
 * assertion that did restate it agreed only on Windows, where `C:\…` carries no leading
 * separator to strip, and so was red on every POSIX machine from the day it was written.
 */
export function absoluteRule(verb: string, path: string): string {
  return `${verb}(//${path.replace(/\\/g, "/").replace(/^\/+/, "")}/**)`;
}

export function claudePermissions(input: RuntimePermissionInput): ClaudePermissions {
  const { policy } = input;
  const allow = [
    ...policy.skills.map((skill) => `Skill(${skill})`),
    ...policy.subagents.map((subagent) => `Agent(${subagent.name})`),
    // Whole-server rule: `--strict-mcp-config` already means these are the only servers
    // connected, so the grant is the server, not each tool it happens to expose.
    ...policy.mcpServers.map((server) => `mcp__${server.name}`),
  ];
  const ownPrivate = join(input.memoryRoot, "private", policy.role);
  const additionalDirectories = [
    // A role with no declared root gets no read grant on the tree it happens to stand in.
    // The ACL is the enforcement, so listing the workspace here would hand read-thread,
    // compaction and titling exactly what their own instructions forbid.
    ...(policy.workspaceAccess === "none" ? [] : [policy.workspace]),
    input.runtimeDirectory,
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
  // Inside a scoped workspace, what stands beside the scope is denied by name. `Edit` is
  // the verb: Claude Code reads it for Write, NotebookEdit and MultiEdit too, while a
  // `Write(...)` rule is ignored (measured 2026-09-12).
  for (const path of input.writeScopeDenyPaths ?? []) deny.push(absoluteRule("Edit", path));

  // Tools outside the policy are denied by bare name, and tools inside it are allowed the
  // same way — without this half, a `workspace-write` role had no CLI bypass (see the Claude
  // adapter: only `interactive` and `read-only` launches get one) and no allow rule either,
  // so `defaultMode: "default"` left every Write/Edit/Bash call waiting on a prompt that a
  // headless run can never answer. Reported 2026-09-11 (GitHub #18) against a delegated
  // `worker`: `exitCode: 0` with an empty transcript and no workspace change. Claude Code
  // only honours a path argument on Read and Edit; on the others a bare name is the only
  // rule that applies.
  for (const tool of TOOL_CATALOG) {
    if (policy.allowedTools.includes(tool as ToolId)) allow.push(tool);
    else deny.push(tool);
  }

  // The loop above can only deny what ALP itself defines. The runtime's own in-process agent
  // tool is not in `TOOL_CATALOG` and so was never denied at all — the house rule forbidding
  // it was prompt text and nothing more. Named explicitly here so the split rule in
  // `house-rules.ts` is enforced rather than merely stated. No role is granted a subagent
  // today (§4.6); a definition that can declare one is what will take it off this list.
  // `Task` is the tool's older name and ALP never grants it under that spelling. `Agent` is
  // withheld only from a role holding no subagent grant: a bare deny would remove the tool
  // from the model's context, so a role that *is* granted one gets the narrow `Agent(name)`
  // allow rules above instead.
  deny.push("Task");
  if (policy.subagents.length === 0) deny.push("Agent");

  // A read-only role keeps that property through two independent mechanisms: no Write/Edit
  // grant, and a sandbox that denies writes to the workspace. Only the second one stops a
  // shell redirect, so where no sandbox exists the shell has to go instead. Losing Bash
  // makes a specialist less capable; losing read-only makes its policy a lie.
  //
  // Except the role that delegates through Bash (§ `delegationSection` in
  // render-session-context.ts uses this exact condition to decide whether to print
  // `alp delegate` instructions): for a coordinator like `main`, Bash is not incidental
  // capability, it is the only way to reach `worker` at all. Stripping it here left the
  // rendered session context instructing a shell call the ACL then silently denied —
  // `allow` and `deny` both carrying bare `Bash`, deny winning. `main`'s own read-only
  // guarantee already rests on holding no Write/Edit, same as every delegated role.
  const delegatesViaBash = policy.delegatesTo.length > 0 && policy.allowedTools.includes("Bash");
  if (policy.workspaceMode === "read-only" && input.sandboxed === false && !delegatesViaBash && !deny.includes("Bash")) {
    deny.push("Bash");
  }

  // Defence in depth: a delegated role must never shell out to a raw runtime, whatever
  // its tool grant says. Mirrors `src/policy/invariants.ts`.
  deny.push("Bash(herdr:*)", "Bash(paseo:*)");

  return {
    defaultMode: "default",
    additionalDirectories: Object.freeze(additionalDirectories),
    allow: Object.freeze(allow),
    deny: Object.freeze(deny),
  };
}

/**
 * The single TOML basic-string serializer for everything ALP writes into Codex config.
 *
 * `JSON.stringify` is the right primitive rather than a coincidence: TOML basic strings use
 * the same double-quote delimiter and the same `\"`, `\\`, `\n`, `\t`, `\uXXXX` escapes, so
 * the output is valid TOML for any input — including Windows paths full of backslashes and
 * non-ASCII text. It lived in two copies before; keeping one means an escaping bug can only
 * be fixed once.
 */
export function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

/**
 * Codex config fragment. Returns TOML lines to append to `codex-config.toml`.
 * `sandbox_mode` is emitted by the adapter itself and is not repeated here.
 */
export function codexSandboxLines(input: RuntimePermissionInput): readonly string[] {
  const { policy } = input;
  // The scope replaces the workspace as what Codex may write — never widens it. Codex
  // enforces `writable_roots` in its own sandbox, so this line alone is the enforcement.
  const writableRoots = codexWriteRoots(input);
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

/** Name of the one permission profile ALP hands Codex on argv. */
export const CODEX_PERMISSION_PROFILE = "alp";

/**
 * Write roots of a launch, the same list `codexSandboxLines` records: the scope (or the
 * whole workspace) plus the role's private memory, and nothing for a read-only role.
 */
function codexWriteRoots(input: RuntimePermissionInput): readonly string[] {
  const { policy } = input;
  return policy.workspaceMode === "workspace-write"
    ? [...(policy.writeScope ?? [policy.workspace]), join(input.memoryRoot, "private", policy.role)]
    : [];
}

/**
 * The Codex sandbox, as `-c` overrides — the only form Codex reads from ALP (the config
 * file the adapter writes is ALP's own record; measured 2026-09-18 on codex-cli 0.154.0,
 * `plans/260918-0700-execution-relay/research/alp-inside-sandbox.md`).
 *
 * A `default_permissions` profile wins over `sandbox_mode` outright, and under it a path is
 * writable only when listed: the relay directory (where `alp` inside the sandbox leaves its
 * request — the one opening under the executions root), the write roots, and for a
 * `workspace-write` role the temp directories Codex's own mode opens, and the machine's
 * toolchain caches (GitHub #25) for either mode — they stand outside the workspace, which
 * `authorize()` checked. `.git`, `.agents` and `.codex` under each write root stay
 * read-only, again as Codex's own mode keeps them. An entry created *beside* a scope is
 * refused too, which is what makes `writeScope` `enforced` on this runtime.
 * `approval_policy = "never"`: the policy already decided, and a prompt in a background pane
 * hangs forever — the interactive session runs the same profile, with only the prompts gone.
 */
export function codexPermissionOverrides(input: RuntimePermissionInput & {
  readonly relayDirectory: string;
  readonly tmpdir: string | undefined;
}): readonly string[] {
  const writeRoots = codexWriteRoots(input);
  type Entry = readonly [path: string, access: "read" | "write"];
  const entries: readonly Entry[] = [
    [":root", "read"],
    [input.relayDirectory, "write"],
    ...(input.policy.workspaceMode === "workspace-write"
      ? [["/tmp", "write"] satisfies Entry, ...(input.tmpdir ? [[input.tmpdir, "write"] satisfies Entry] : [])]
      : []),
    ...input.policy.toolchainWritePaths.map((root): Entry => [root, "write"]),
    ...writeRoots.map((root): Entry => [root, "write"]),
    ...writeRoots.flatMap((root): Entry[] =>
      [".git", ".agents", ".codex"].map((protectedName): Entry => [join(root, protectedName), "read"])),
  ];
  const table = `{${entries.map(([path, access]) => `${tomlString(path)}=${tomlString(access)}`).join(",")}}`;
  return Object.freeze([
    "-c", `default_permissions=${tomlString(CODEX_PERMISSION_PROFILE)}`,
    "-c", `permissions.${CODEX_PERMISSION_PROFILE}.filesystem=${table}`,
    "-c", `approval_policy="never"`,
  ]);
}

/**
 * Granted MCP servers as `-c` overrides for Codex.
 *
 * They go on argv rather than into `codex-config.toml`, because that file is ALP's own
 * record — Codex loads `$CODEX_HOME/config.toml`, which ALP does not write — and a server
 * declared only there would be documentation of a connection that never happened.
 *
 * Codex has no `--strict-mcp-config`: whatever the principal configured on the machine
 * stays connected alongside these. That asymmetry is real and is stated in §4.6 rather than
 * papered over — the grant adds servers here, where on Claude it also removes them.
 */
export function codexMcpOverrides(policy: ExecutionPolicy): readonly string[] {
  return Object.freeze(policy.mcpServers.flatMap((server) => {
    const fields = [
      `command = ${tomlString(server.command)}`,
      `args = [${server.args.map(tomlString).join(", ")}]`,
      ...(server.env === undefined ? [] : [
        `env = { ${Object.entries(server.env).map(([key, value]) => `${key} = ${tomlString(value)}`).join(", ")} }`,
      ]),
    ];
    return ["-c", `mcp_servers.${server.name}={ ${fields.join(", ")} }`];
  }));
}

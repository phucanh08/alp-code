import type { ExecutionPolicy, IdentityCapsule } from "../execution/types";

/**
 * Renders what is true for the whole session, regardless of what the principal asks next.
 *
 * This is the half of the old `renderCapsulePrompt` that must never become a user turn.
 * It reaches both runtimes the same way — written to `session-context.md`, pointed at by
 * `ALP_SESSION_CONTEXT`, and emitted by the SessionStart hook as `additionalContext`.
 * Claude and Codex both land it as a developer-role message ahead of turn 1, so an
 * interactive session is fully briefed while still waiting for its first real input.
 *
 * Nothing per-task belongs here: the current task and the memory selected for it live in
 * `renderTaskInput`, because those do create a turn.
 */
/**
 * The `Delegates to` row grants the roles; this says how to reach them.
 *
 * Neither runtime carries a delegation tool — `DelegationService` is reachable only through
 * the `alp delegate` CLI, so the shell is the channel. Left unsaid, a role reads its grant,
 * finds no tool matching it, and correctly reports itself blocked rather than inventing a
 * command: the line above forbids exactly that guess. Naming the command is what turns the
 * grant into something usable.
 *
 * Gated on the session-wide `Bash` grant rather than `capsule.allowedTools`, which is
 * narrowed to the opening workflow state and would hide the section from a role that gets a
 * shell one state later. Runtime enforcement reads the same session-wide grant.
 *
 * No identity appears in the command. `alp delegate` takes the caller from
 * `ALP_DELEGATED_ROLE` in the inherited environment and rejects `--role` and
 * `--parent-role`, so a role cannot delegate as anyone but itself.
 */
function delegationSection(
  capsule: IdentityCapsule,
  policy: ExecutionPolicy,
): readonly string[] {
  if (policy.delegatesTo.length === 0 || !policy.allowedTools.includes("Bash")) return [];
  return [
    "## Delegation",
    "",
    "Specialists are separate executions, launched from your shell — there is no delegation tool. One role per call, task after `--`:",
    "",
    "```",
    `alp delegate <role> --project ${capsule.activeWorkspace} -- "<task>"`,
    "```",
    "",
    "Add `--background` to keep working while it runs, then follow it with `alp delegation status <id>` and `alp delegation wait <id>`.",
    "",
    "Pass no identity flag — the call inherits yours, and the roles in the table above are the only ones policy accepts. What comes back is a report to verify, not a result to forward unchecked.",
    "",
  ];
}

/**
 * Teaches how to keep continuity alive across a runtime's own compaction.
 *
 * Gated on the same session-wide `Bash` grant as `delegationSection`, for the same reason:
 * a read-only role (search, librarian, compaction…) has no shell to run `alp context pin`
 * from, and a section it cannot act on would just be noise. `source: "agent"` therefore only
 * ever shows up where the command is actually reachable.
 */
function continuitySection(policy: ExecutionPolicy): readonly string[] {
  if (!policy.allowedTools.includes("Bash")) return [];
  return [
    "## Continuity",
    "",
    "Record decisions and constraints the moment you settle them, not at the end of the session. After the runtime compacts, only what you pinned survives:",
    "",
    "```",
    'alp context pin decision -- "chose X over Y because Z"',
    'alp context pin constraint -- "do not touch Z"',
    'alp context pin open-item -- "..."',
    'alp context pin next-action -- "..."',
    "```",
    "",
    "A pin is one sentence, not a summary. Never pin a secret or a file's contents.",
    "",
  ];
}

export function renderSessionContext(
  capsule: IdentityCapsule,
  policy: ExecutionPolicy,
): string {
  const list = (values: readonly string[]): string => values.length === 0 ? "—" : values.join(", ");
  return [
    `# ${capsule.displayName} — \`${capsule.role}\``,
    "",
    capsule.instructions,
    "",
    "## Authority",
    "",
    "| | |",
    "| --- | --- |",
    `| Workspace | \`${capsule.activeWorkspace}\` (${policy.workspaceMode}) |`,
    // Workflow-state filtered, so this is narrower than the definition's full grant and is
    // the list that actually applies right now.
    `| Tools | ${list(capsule.allowedTools)} |`,
    `| Memory read | ${list(policy.memory.read)} |`,
    `| Memory write | ${list(policy.memory.write)} |`,
    `| Delegates to | ${list(policy.delegatesTo)} |`,
    "",
    "That table is the whole of your authority. If something you need is blocked, report it — do not route around it.",
    "",
    ...delegationSection(capsule, policy),
    ...continuitySection(policy),
    "## Invariants",
    "",
    capsule.memoryContext.invariantContext,
    "",
    "## Policy",
    "",
    capsule.memoryContext.policyContext,
    "",
    "## Reporting",
    "",
    "Answer in prose. Close with your status, what you actually did, and the evidence for it — commands you ran, files you changed, output you saw. Do not claim a step you skipped.",
    "",
  ].join("\n");
}

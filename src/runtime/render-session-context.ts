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

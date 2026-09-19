import type { IdentityCapsule } from "../execution/types";

/**
 * Renders the half of an execution that is *meant* to create a turn.
 *
 * Only a headless run has one. An interactive session gets its first turn from the
 * principal, so no adapter may render this into a positional prompt there — that is the
 * synthetic turn this split exists to remove.
 *
 * Memory sits here rather than in the session context because it is selected per task:
 * `MemoryService.buildContext` runs against the task's queries and budget, and what it
 * returns is state, not identity.
 *
 * The report trailer sits here too, *after* the task, on every headless run: `parseOutcome`
 * reads every child's last message (master plan 2a), so the trailer is a per-execution
 * machine contract, not a trait of one role — the worker's identity states it as one rule
 * among ten, the four specialists' identities not at all. What the model reads last is what
 * it does last.
 */
export function renderTaskInput(capsule: IdentityCapsule): string {
  const memory = capsule.memoryContext.entries.length === 0
    ? "(no memory entries selected)"
    : capsule.memoryContext.entries
      .map((entry) => `### ${entry.id}\n\n${entry.content}`)
      .join("\n\n");
  return [
    `# ALP execution ${capsule.executionId}`,
    "",
    "## Relevant memory",
    "",
    memory,
    "",
    "## Task",
    "",
    capsule.task,
    "",
    "## Report",
    "",
    "End your final message with this trailer, one field per line, nothing after it:",
    "",
    "```",
    "Disposition: done | blocked | reopen-request | dependency-request",
    "Reason: <one sentence>",
    "Evidence: <comma-separated paths, commands or request IDs>",
    "```",
    "",
    "`done` only when the task as written is finished and verified; `reopen-request` when the premise is wrong (leave the workspace unchanged); `dependency-request` when an input is missing; `blocked` when something outside your authority stops you. Without the trailer the outcome is recorded as `unknown`, not as done.",
    "",
  ].join("\n");
}

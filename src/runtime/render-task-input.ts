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
  ].join("\n");
}

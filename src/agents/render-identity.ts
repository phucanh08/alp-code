import type { AgentDefinition } from "./types";

/**
 * Renders a role's static identity as a standalone Markdown document.
 *
 * This is what `alp identity sync` writes to `.alp/agents/<role>.md` and what the
 * SessionStart hook injects verbatim. Keeping it a flat file is the point: the hook can
 * read it with one `readFileSync` and no `dist/` load, so identity is present at turn 1
 * instead of costing the agent a tool round-trip.
 *
 * Only static facts belong here. Anything that varies per execution (task, active
 * workspace, selected memory) is rendered into `prompt.md` by `renderCapsulePrompt`.
 */
export function renderIdentityDocument(definition: AgentDefinition<unknown>): string {
  const list = (values: readonly string[]): string => values.length === 0 ? "—" : values.join(", ");
  return [
    `# ${definition.displayName} — \`${definition.id}\``,
    "",
    definition.instructions(),
    "",
    "## Authority",
    "",
    "| | |",
    "| --- | --- |",
    `| Reports to | \`${definition.reportsTo}\` |`,
    `| Delegates to | ${list(definition.delegatesTo)} |`,
    `| Tools | ${list(definition.capabilities.tools)} |`,
    `| Memory read | ${list(definition.capabilities.memory.read)} |`,
    `| Memory write | ${list(definition.capabilities.memory.write)} |`,
    `| Workspace read | ${list(definition.capabilities.workspace.readRoots)} |`,
    `| Workspace write | ${list(definition.capabilities.workspace.writeRoots)} |`,
    "",
    "That table is the whole of your authority. If something you need is blocked, report it — do not route around it.",
    "",
  ].join("\n");
}

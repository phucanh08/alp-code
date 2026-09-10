import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { removeTemporary } from "./temporary-root";

/**
 * One agent file that passes every gate, shared by the loader, command and trust suites.
 *
 * Kept in one place because most tests about it are one deviation from green — `variant`
 * makes that deviation the whole content of the test, and three copies of this fixture would
 * drift into three different definitions of "valid".
 */
export const VALID_AGENT_FILE = `
schemaVersion: 1
id: migrator
displayName: "Migrator 🔧"
model: { claude: claude-opus-5, codex: gpt-5.6-terra }
reasoningEffort: { claude: high, codex: medium }
instructions:
  role: "Migrator, the framework migration specialist"
  purpose: "Migrate one module per execution and prove the migration with tests."
  rules:
    - "Never migrate more than one module per execution."
capabilities:
  tools: [Read, Glob, Grep, Bash]
  memory:
    read: [shared, "project:*", "private:migrator"]
    write: ["private:migrator"]
  workspace:
    readRoots: ["."]
workflow:
  - { id: ASSESS, allowedTools: [Read, Glob, Grep] }
  - { id: REPORT, allowedTools: [] }
output:
  kind: text
`.trimStart();

/** The valid file with lines replaced. A missing anchor fails loudly rather than silently. */
export function variant(replacements: Readonly<Record<string, string>>): string {
  let source = VALID_AGENT_FILE;
  for (const [from, to] of Object.entries(replacements)) {
    expect(source, `\`${from}\` must appear in the fixture`).toContain(from);
    source = source.replace(from, to);
  }
  return source;
}

const roots: string[] = [];

export async function cleanupAgentProjects(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => removeTemporary(root)));
}

/** A throwaway project holding `.alp/agents/<id>/agent.yaml` for each entry given. */
export async function agentProject(
  files: Readonly<Record<string, string>> = { migrator: VALID_AGENT_FILE },
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "alp-agent-project-"));
  roots.push(root);
  for (const [id, source] of Object.entries(files)) {
    await mkdir(join(root, ".alp", "agents", id), { recursive: true });
    await writeFile(join(root, ".alp", "agents", id, "agent.yaml"), source, "utf8");
  }
  return root;
}

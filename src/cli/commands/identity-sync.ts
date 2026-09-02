import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderIdentityDocument } from "../../agents/render-identity";
import type { AgentDefinition, AgentRegistry } from "../../agents/types";

/** Directory holding the generated per-role identity documents, relative to the repo root. */
export const AGENT_DOCUMENT_DIRECTORY = join(".alp", "agents");

export function agentDocumentPath(repoRoot: string, role: string): string {
  return join(repoRoot, AGENT_DOCUMENT_DIRECTORY, `${role}.md`);
}

export interface SyncIdentityInput {
  readonly repoRoot: string;
}

export interface SyncIdentityDependencies {
  readonly registry: Pick<AgentRegistry, "list">;
}

/**
 * Regenerates `.alp/agents/<role>.md` for every role in the registry.
 *
 * The registry stays the single source of truth; these files are a derived, machine-local
 * cache that exists purely so the SessionStart hook can stay fast and dependency-free.
 * Safe to run repeatedly — it always overwrites.
 */
export async function syncIdentityDocuments(
  input: SyncIdentityInput,
  dependencies: SyncIdentityDependencies,
): Promise<readonly string[]> {
  const directory = join(input.repoRoot, AGENT_DOCUMENT_DIRECTORY);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const written: string[] = [];
  for (const definition of dependencies.registry.list()) {
    const file = agentDocumentPath(input.repoRoot, definition.id);
    await writeFile(file, renderIdentityDocument(definition as AgentDefinition<unknown>), {
      encoding: "utf8",
      mode: 0o600,
    });
    written.push(file);
  }
  return Object.freeze(written);
}

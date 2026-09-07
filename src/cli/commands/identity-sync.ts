import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderIdentityDocument } from "../../agents/render-identity";
import type { AgentDefinition, AgentRegistry } from "../../agents/types";

export function agentDocumentPath(directory: string, role: string): string {
  return join(directory, `${role}.md`);
}

export interface SyncIdentityInput {
  /**
   * Nơi đặt tài liệu identity — `~/.alp/agents` khi chạy thật (`agentsDirectory()`).
   *
   * Trước v0.9.0 đây là `<repoRoot>/.alp/agents`, tức nằm trong thư mục cài. Thư mục cài giờ
   * là artifact bị thay nguyên khối mỗi lần update, nên tài liệu sinh ở đó sẽ biến mất đúng
   * lúc hook SessionStart cần đọc chúng.
   */
  readonly directory: string;
}

export interface SyncIdentityDependencies {
  readonly registry: Pick<AgentRegistry, "list">;
}

/**
 * Regenerates `<directory>/<role>.md` for every role in the registry.
 *
 * The registry stays the single source of truth; these files are a derived, machine-local
 * cache that exists purely so the SessionStart hook can stay fast and dependency-free.
 * Safe to run repeatedly — it always overwrites.
 */
export async function syncIdentityDocuments(
  input: SyncIdentityInput,
  dependencies: SyncIdentityDependencies,
): Promise<readonly string[]> {
  const directory = input.directory;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const written: string[] = [];
  for (const definition of dependencies.registry.list()) {
    const file = agentDocumentPath(directory, definition.id);
    await writeFile(file, renderIdentityDocument(definition as AgentDefinition<unknown>), {
      encoding: "utf8",
      mode: 0o600,
    });
    written.push(file);
  }
  return Object.freeze(written);
}

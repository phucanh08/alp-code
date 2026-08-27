import {
  MemoryEntryAlreadyExistsError,
  MemoryEntryNotFoundError,
  MemoryVersionConflictError,
} from "../../src/memory/errors";
import { parseMemoryId } from "../../src/memory/memory-service";
import type { MemoryApiClient } from "../../src/memory/adapters/memory-api-client";
import type { CreateMemoryInput, MemoryEntry, MemoryQuery, UpdateMemoryInput } from "../../src/memory/types";

/** In-memory stand-in for a remote memory API, shared by store-contract and e2e tests. */
export class FakeMemoryApiClient implements MemoryApiClient {
  readonly calls: string[] = [];
  private readonly entries = new Map<string, MemoryEntry>();
  private tick = 0;

  async search(query: MemoryQuery): Promise<readonly MemoryEntry[]> {
    this.calls.push("search");
    return [...this.entries.values()]
      .filter((entry) => entry.id.startsWith(`${query.scope}:`))
      .filter((entry) => !query.text || `${entry.id}\n${entry.content}`.includes(query.text))
      .filter((entry) => !query.kinds || query.kinds.includes(entry.kind))
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, query.limit);
  }

  async get(id: string): Promise<MemoryEntry | null> {
    this.calls.push("get");
    return this.entries.get(id) ?? null;
  }

  async create(input: CreateMemoryInput): Promise<MemoryEntry> {
    this.calls.push("create");
    if (this.entries.has(input.id)) throw new MemoryEntryAlreadyExistsError(input.id);
    const parsed = parseMemoryId(input.id);
    const timestamp = new Date(++this.tick).toISOString();
    const entry: MemoryEntry = {
      ...input,
      scope: parsed.scope,
      ...(parsed.ownerRole === undefined ? {} : { ownerRole: parsed.ownerRole }),
      ...(parsed.projectId === undefined ? {} : { projectId: parsed.projectId }),
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.entries.set(input.id, entry);
    return entry;
  }

  async update(id: string, input: UpdateMemoryInput): Promise<MemoryEntry> {
    this.calls.push("update");
    const current = this.entries.get(id);
    if (!current) throw new MemoryEntryNotFoundError(id);
    if (current.version !== input.expectedVersion) {
      throw new MemoryVersionConflictError(id, input.expectedVersion, current.version);
    }
    const entry: MemoryEntry = {
      ...current,
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.content === undefined ? {} : { content: input.content }),
      version: current.version + 1,
      updatedAt: new Date(++this.tick).toISOString(),
    };
    this.entries.set(id, entry);
    return entry;
  }

  async delete(id: string, expectedVersion: number): Promise<void> {
    this.calls.push("delete");
    const current = this.entries.get(id);
    if (!current) throw new MemoryEntryNotFoundError(id);
    if (current.version !== expectedVersion) {
      throw new MemoryVersionConflictError(id, expectedVersion, current.version);
    }
    this.entries.delete(id);
  }
}

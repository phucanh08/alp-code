import type { MemoryStore } from "../memory-store";
import type {
  CreateMemoryInput,
  MemoryEntry,
  MemoryQuery,
  UpdateMemoryInput,
} from "../types";
import type { MemoryApiClient } from "./memory-api-client";

export class RemoteApiStore implements MemoryStore {
  constructor(private readonly client: MemoryApiClient) {}

  search(query: MemoryQuery): Promise<readonly MemoryEntry[]> {
    return this.client.search(query);
  }

  get(id: string): Promise<MemoryEntry | null> {
    return this.client.get(id);
  }

  create(input: CreateMemoryInput): Promise<MemoryEntry> {
    return this.client.create(input);
  }

  update(id: string, input: UpdateMemoryInput): Promise<MemoryEntry> {
    return this.client.update(id, input);
  }

  delete(id: string, expectedVersion: number): Promise<void> {
    return this.client.delete(id, expectedVersion);
  }
}

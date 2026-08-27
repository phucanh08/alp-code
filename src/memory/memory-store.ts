import type {
  CreateMemoryInput,
  MemoryEntry,
  MemoryQuery,
  UpdateMemoryInput,
} from "./types";

export interface MemoryStore {
  search(query: MemoryQuery): Promise<readonly MemoryEntry[]>;
  get(id: string): Promise<MemoryEntry | null>;
  create(input: CreateMemoryInput): Promise<MemoryEntry>;
  update(id: string, input: UpdateMemoryInput): Promise<MemoryEntry>;
  delete(id: string, expectedVersion: number): Promise<void>;
}

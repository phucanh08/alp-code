import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, parse } from "node:path";
import {
  MemoryEntryAlreadyExistsError,
  MemoryEntryNotFoundError,
  MemoryVersionConflictError,
} from "../errors";
import type { MemoryStore } from "../memory-store";
import { parseMemoryId } from "../memory-service";
import type {
  CreateMemoryInput,
  MemoryEntry,
  MemoryKind,
  MemoryQuery,
  UpdateMemoryInput,
} from "../types";
import { MemoryPathMapper } from "./memory-path-mapper";
import { memoryGrantCovers } from "../../agents/memory-grant";
import type { MemoryScopeGrant } from "../../agents/types";

interface MetadataEntry {
  readonly version: number;
  readonly kind: MemoryKind;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface MetadataIndex {
  readonly formatVersion: 1;
  readonly entries: Record<string, MetadataEntry>;
}

export interface MarkdownFileStoreOptions {
  readonly root: string;
  readonly now?: () => Date;
}

const MEMORY_KINDS = new Set<MemoryKind>([
  "fact",
  "decision",
  "reference",
  "log",
  "draft",
]);
let temporarySequence = 0;

function inferKind(content: string): MemoryKind {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  const value = frontmatter?.match(/^kind:\s*([^\s#]+)\s*$/m)?.[1] as MemoryKind | undefined;
  return value && MEMORY_KINDS.has(value) ? value : "reference";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${++temporarySequence}.tmp`,
  );
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export class MarkdownFileStore implements MemoryStore {
  private readonly mapper: MemoryPathMapper;
  private readonly metadataPath: string;
  private readonly now: () => Date;
  private metadata: MetadataIndex | undefined;
  private initializing: Promise<void> | undefined;
  private mutations: Promise<void> = Promise.resolve();

  constructor(options: MarkdownFileStoreOptions) {
    this.mapper = new MemoryPathMapper(options.root);
    this.metadataPath = join(this.mapper.root, ".alp-memory-index.json");
    this.now = options.now ?? (() => new Date());
  }

  private async initialize(): Promise<void> {
    if (this.metadata) return;
    if (!this.initializing) {
      this.initializing = (async () => {
        await mkdir(this.mapper.root, { recursive: true });
        try {
          const parsed = JSON.parse(await readFile(this.metadataPath, "utf8")) as MetadataIndex;
          if (parsed.formatVersion !== 1 || !parsed.entries || typeof parsed.entries !== "object") {
            throw new Error("unsupported memory metadata index");
          }
          this.metadata = { formatVersion: 1, entries: { ...parsed.entries } };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          this.metadata = await this.rebuildMetadata();
          await this.persistMetadata();
        }
      })();
    }
    await this.initializing;
  }

  private async rebuildMetadata(): Promise<MetadataIndex> {
    const entries: Record<string, MetadataEntry> = {};
    const addFile = async (id: string, path: string): Promise<void> => {
      const [content, metadata] = await Promise.all([readFile(path, "utf8"), stat(path)]);
      entries[id] = {
        version: 1,
        kind: inferKind(content),
        createdAt: metadata.birthtime.toISOString(),
        updatedAt: metadata.mtime.toISOString(),
      };
    };
    const nestedMarkdown = async (
      directory: string,
      idPrefix: readonly string[],
    ): Promise<void> => {
      let directoryMetadata;
      try {
        directoryMetadata = await lstat(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) return;
      for (const item of await readdir(directory, { withFileTypes: true })) {
        if (item.isFile() && extname(item.name) === ".md") {
          await addFile([...idPrefix, parse(item.name).name].join(":"), join(directory, item.name));
        } else if (item.isDirectory() && !item.isSymbolicLink()) {
          await nestedMarkdown(join(directory, item.name), [...idPrefix, item.name]);
        }
      }
    };

    await nestedMarkdown(join(this.mapper.root, "shared"), ["shared"]);
    for (const scope of ["projects", "private"] as const) {
      const scopeRoot = join(this.mapper.root, scope);
      let scopeMetadata;
      try {
        scopeMetadata = await lstat(scopeRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!scopeMetadata.isDirectory() || scopeMetadata.isSymbolicLink()) continue;
      for (const owner of await readdir(scopeRoot, { withFileTypes: true })) {
        if (!owner.isDirectory() || owner.isSymbolicLink()) continue;
        await nestedMarkdown(
          join(scopeRoot, owner.name),
          [scope === "projects" ? "project" : "private", owner.name],
        );
      }
    }
    return { formatVersion: 1, entries };
  }

  private async persistMetadata(): Promise<void> {
    await atomicWrite(this.metadataPath, `${JSON.stringify(this.metadata, null, 2)}\n`);
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(action, action);
    this.mutations = result.then(() => undefined, () => undefined);
    return result;
  }

  private async settledMetadata(): Promise<MetadataIndex> {
    await this.initialize();
    await this.mutations;
    return this.metadata!;
  }

  private async entry(id: string, metadata: MetadataEntry): Promise<MemoryEntry> {
    const parsed = parseMemoryId(id);
    const path = await this.mapper.safePathFor(id);
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new MemoryEntryNotFoundError(id);
      throw error;
    }
    return Object.freeze({
      id,
      scope: parsed.scope,
      ...(parsed.ownerRole === undefined ? {} : { ownerRole: parsed.ownerRole }),
      ...(parsed.projectId === undefined ? {} : { projectId: parsed.projectId }),
      kind: metadata.kind,
      content,
      version: metadata.version,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
    });
  }

  async search(query: MemoryQuery): Promise<readonly MemoryEntry[]> {
    const metadata = await this.settledMetadata();
    const needle = query.text?.toLocaleLowerCase();
    const results: MemoryEntry[] = [];
    for (const id of Object.keys(metadata.entries).sort()) {
      if (!memoryGrantCovers(query.scope, id as MemoryScopeGrant)) continue;
      const item = metadata.entries[id];
      if (query.kinds && !query.kinds.includes(item.kind)) continue;
      const entry = await this.entry(id, item);
      if (needle && !`${entry.id}\n${entry.content}`.toLocaleLowerCase().includes(needle)) continue;
      results.push(entry);
      if (query.limit !== undefined && results.length >= query.limit) break;
    }
    return Object.freeze(results);
  }

  async get(id: string): Promise<MemoryEntry | null> {
    parseMemoryId(id);
    const metadata = await this.settledMetadata();
    const item = metadata.entries[id];
    return item ? this.entry(id, item) : null;
  }

  async create(input: CreateMemoryInput): Promise<MemoryEntry> {
    return this.exclusive(async () => {
      await this.initialize();
      const path = await this.mapper.safePathFor(input.id, true);
      if (this.metadata!.entries[input.id] || (await pathExists(path))) {
        throw new MemoryEntryAlreadyExistsError(input.id);
      }
      const timestamp = this.now().toISOString();
      await atomicWrite(path, input.content);
      const item: MetadataEntry = {
        version: 1,
        kind: input.kind,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.metadata!.entries[input.id] = item;
      await this.persistMetadata();
      return this.entry(input.id, item);
    });
  }

  async update(id: string, input: UpdateMemoryInput): Promise<MemoryEntry> {
    return this.exclusive(async () => {
      await this.initialize();
      parseMemoryId(id);
      const current = this.metadata!.entries[id];
      if (!current) throw new MemoryEntryNotFoundError(id);
      if (current.version !== input.expectedVersion) {
        throw new MemoryVersionConflictError(id, input.expectedVersion, current.version);
      }
      const path = await this.mapper.safePathFor(id);
      const content = input.content ?? (await readFile(path, "utf8"));
      await atomicWrite(path, content);
      const item: MetadataEntry = {
        version: current.version + 1,
        kind: input.kind ?? current.kind,
        createdAt: current.createdAt,
        updatedAt: this.now().toISOString(),
      };
      this.metadata!.entries[id] = item;
      await this.persistMetadata();
      return this.entry(id, item);
    });
  }

  async delete(id: string, expectedVersion: number): Promise<void> {
    return this.exclusive(async () => {
      await this.initialize();
      parseMemoryId(id);
      const current = this.metadata!.entries[id];
      if (!current) throw new MemoryEntryNotFoundError(id);
      if (current.version !== expectedVersion) {
        throw new MemoryVersionConflictError(id, expectedVersion, current.version);
      }
      const path = await this.mapper.safePathFor(id);
      await rm(path);
      delete this.metadata!.entries[id];
      await this.persistMetadata();
    });
  }
}

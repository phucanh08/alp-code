import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ThreadError } from "./errors";
import {
  ARTIFACT_KINDS,
  artifactRefFor,
  assertThreadDocument,
  validateThreadWrite,
  type ArtifactKind,
} from "./invariants";
import {
  freezeThread,
  matchesQuery,
  newArtifacts,
  newThreadDocument,
  referencedArtifacts,
  requireThreadId,
  sortNewestFirst,
  type ThreadLease,
  type ThreadStore,
} from "./thread-store";
import {
  summarizeThread,
  THREAD_ID_PATTERN,
  type CreateThreadInput,
  type ThreadDocumentV1,
  type ThreadId,
  type ThreadListQuery,
  type ThreadSummary,
} from "./types";

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;
const LOCK_POLL_MS = 25;
const INDEX_FILE = "thread.json";
const LOCK_DIRECTORY = ".lock";
const QUARANTINE_DIRECTORY = ".quarantine";

interface LockOwner {
  readonly pid: number;
  readonly host: string;
  readonly acquiredAt: string;
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((settle) => setTimeout(settle, milliseconds));
}

/**
 * Process này còn sống không, xét từ góc nhìn của một khoá. Cùng luật với graph store:
 * `null` là **không chứng minh được** và chỗ gọi phải coi là còn sống.
 */
function ownerAlive(owner: LockOwner): boolean | null {
  if (owner.host !== hostname()) return null;
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) return null;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM" ? true : false;
  }
}

/**
 * Thread dưới `~/.alp/threads/<id>/`, một thư mục cho mỗi Thread.
 *
 * Cùng khuôn khoá với `FileExecutionGraphStore` — thư mục khoá vì `mkdir` là nguyên tử,
 * ghi tạm rồi `rename` vì `rename` nguyên tử trong một thư mục, khoá quá hạn chỉ bị thu
 * hồi khi chứng minh được chủ nó đã chết. Khác một chỗ: mỗi Thread là một thư mục chứ
 * không phải một file, vì payload (context/message/compaction) bất biến sống cạnh index
 * và không được nhét vào index cho nó phình.
 *
 * `get(id)` mở thẳng `<id>/thread.json` — không quét `threads/`.
 */
export class FileThreadStore implements ThreadStore {
  private readonly root: string;
  private readonly lockTimeoutMs: number;
  private readonly now: () => Date;
  /** Hàng đợi trong process, trên cùng một Thread — như graph store, vì cùng lý do. */
  private readonly queues = new Map<ThreadId, Promise<unknown>>();

  constructor(options: { readonly root: string; readonly lockTimeoutMs?: number; readonly now?: () => Date }) {
    this.root = resolve(options.root);
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
  }

  async create(input: CreateThreadInput): Promise<ThreadDocumentV1> {
    const document = newThreadDocument(input, this.now);
    await this.ensureRoot();
    if (document.parentThreadId !== null && (await this.get(document.parentThreadId)) === null) {
      throw new ThreadError("THREAD_NOT_FOUND", `parent thread \`${document.parentThreadId}\` does not exist`);
    }
    const directory = this.threadDirectory(document.id);
    try {
      // `mkdir` không recursive là chỗ duy nhất không đi qua temp+rename: nó phải hỏng khi
      // thư mục đã có — hai process cùng tạo một ID sẽ có một bên mất Thread nếu không.
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ThreadError("THREAD_EXISTS", `thread \`${document.id}\` already exists`);
      }
      throw error;
    }
    for (const kind of ARTIFACT_KINDS) await mkdir(join(directory, kind), { mode: 0o700 });
    await writeFile(join(directory, INDEX_FILE), serialize(document), { encoding: "utf8", mode: 0o600, flag: "wx" });
    return freezeThread(document);
  }

  async get(id: ThreadId): Promise<ThreadDocumentV1 | null> {
    requireThreadId(id);
    return this.readIndex(id);
  }

  async list(query: ThreadListQuery = {}): Promise<readonly ThreadSummary[]> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze([]);
      throw error;
    }
    const summaries: ThreadSummary[] = [];
    for (const entry of entries) {
      if (!THREAD_ID_PATTERN.test(entry)) continue;
      // Một Thread hỏng làm `list` hỏng theo, đúng như `get` — fail đóng, và thông báo nói
      // rõ file nào, để người dùng biết dọn gì thay vì thấy một danh sách thiếu.
      const thread = await this.readIndex(entry);
      if (!thread) continue;
      const summary = summarizeThread(thread);
      if (matchesQuery(summary, query)) summaries.push(summary);
    }
    return Object.freeze(sortNewestFirst(summaries));
  }

  async withExclusiveLease<T>(id: ThreadId, operation: (lease: ThreadLease) => Promise<T>): Promise<T> {
    requireThreadId(id);
    const previous = this.queues.get(id) ?? Promise.resolve();
    const run = previous.then(
      () => this.runLeased(id, operation),
      () => this.runLeased(id, operation),
    );
    this.queues.set(id, run.then(() => undefined, () => undefined));
    return run;
  }

  async collectOrphans(id: ThreadId): Promise<readonly string[]> {
    return this.withExclusiveLease(id, async (lease) => {
      const directory = this.threadDirectory(id);
      const referenced = referencedArtifacts(lease.current());
      const orphans: string[] = [];
      for (const kind of ARTIFACT_KINDS) {
        let files: string[];
        try {
          files = await readdir(join(directory, kind));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        for (const file of files) {
          const ref = `${kind}/${file}`;
          if (referenced.has(ref)) continue;
          await mkdir(join(directory, QUARANTINE_DIRECTORY), { recursive: true, mode: 0o700 });
          await rename(join(directory, kind, file), join(directory, QUARANTINE_DIRECTORY, `${kind}-${file}`));
          orphans.push(ref);
        }
      }
      return orphans.sort();
    });
  }

  /** Payload theo ref, đã kiểm nằm trong thư mục Thread. */
  async readPayload(id: ThreadId, ref: string): Promise<unknown> {
    requireThreadId(id);
    const file = await this.resolveArtifact(id, ref);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ThreadError("THREAD_NOT_FOUND", `payload \`${ref}\` of thread \`${id}\` does not exist`);
      }
      throw error;
    }
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw new ThreadError("THREAD_STORE_CORRUPT", `payload ${file} is not valid JSON`, { cause: error });
    }
  }

  private async runLeased<T>(id: ThreadId, operation: (lease: ThreadLease) => Promise<T>): Promise<T> {
    const directory = this.threadDirectory(id);
    if (!(await this.readIndex(id))) {
      throw new ThreadError("THREAD_NOT_FOUND", `thread \`${id}\` does not exist`);
    }
    const release = await this.acquireLock(id);
    try {
      // Đọc lại **sau** khi cầm khoá. Bản caller đã đọc trước đó có thể đã cũ.
      const initial = await this.readIndex(id);
      if (!initial) throw new ThreadError("THREAD_NOT_FOUND", `thread \`${id}\` does not exist`);
      let current = initial;
      const lease: ThreadLease = {
        threadId: id,
        current: () => freezeThread(current),
        writePayload: async (kind: ArtifactKind, name: string, body: unknown) => {
          const ref = artifactRefFor(kind, name);
          await mkdir(join(directory, kind), { recursive: true, mode: 0o700 });
          try {
            await writeFile(join(directory, ref), serialize(body), { encoding: "utf8", mode: 0o600, flag: "wx" });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") {
              throw new ThreadError("THREAD_INVARIANT_VIOLATION", `payload \`${ref}\` already exists and is immutable`);
            }
            throw error;
          }
          return ref;
        },
        commit: async (next) => {
          const document = validateThreadWrite(current, next);
          // Invariant 9, nửa filesystem: ref mới phải có thật và không được là symlink ra ngoài.
          for (const ref of newArtifacts(current, document)) await this.resolveArtifact(id, ref);
          await this.writeJson(join(directory, INDEX_FILE), document);
          current = freezeThread(document);
          return current;
        },
      };
      return await operation(lease);
    } finally {
      await release();
    }
  }

  /**
   * Path thật của một artifact, sau khi chứng minh nó nằm trong thư mục Thread.
   *
   * `realpath` cả hai đầu: một symlink trong `context/` trỏ ra ngoài vẫn có path chữ nằm
   * trong Thread, và chỉ path thật mới nói lên nó đọc gì.
   */
  private async resolveArtifact(id: ThreadId, ref: string): Promise<string> {
    const directory = this.threadDirectory(id);
    const candidate = join(directory, ref);
    let target: string;
    let base: string;
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) {
        throw new ThreadError("THREAD_INVARIANT_VIOLATION", `payload \`${ref}\` of thread \`${id}\` is a symlink`);
      }
      if (!info.isFile()) {
        throw new ThreadError("THREAD_INVARIANT_VIOLATION", `payload \`${ref}\` of thread \`${id}\` is not a file`);
      }
      target = await realpath(candidate);
      base = await realpath(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ThreadError("THREAD_INVARIANT_VIOLATION", `index references missing payload \`${ref}\``);
      }
      throw error;
    }
    const inside = relative(base, target);
    if (inside === "" || inside.startsWith("..") || inside.includes(`..${sep}`) || resolve(base, inside) !== target) {
      throw new ThreadError("THREAD_INVARIANT_VIOLATION", `payload \`${ref}\` escapes thread \`${id}\``);
    }
    return target;
  }

  private async acquireLock(id: ThreadId): Promise<() => Promise<void>> {
    const lockDirectory = join(this.threadDirectory(id), LOCK_DIRECTORY);
    const ownerFile = join(lockDirectory, "owner.json");
    const owner: LockOwner = { pid: process.pid, host: hostname(), acquiredAt: new Date().toISOString() };
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        await mkdir(lockDirectory, { mode: 0o700 });
        await writeFile(ownerFile, serialize(owner), { encoding: "utf8", mode: 0o600 });
        return async () => { await rm(lockDirectory, { recursive: true, force: true }); };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await this.reclaimIfDead(lockDirectory, ownerFile)) continue;
        if (Date.now() >= deadline) {
          throw new ThreadError(
            "THREAD_LOCK_TIMEOUT",
            `timed out after ${this.lockTimeoutMs}ms waiting for the lease on thread \`${id}\``,
          );
        }
        await sleep(LOCK_POLL_MS);
      }
    }
  }

  /** Đúng khi khoá vừa được thu hồi vì chủ nó đã chết và nó đã quá hạn. */
  private async reclaimIfDead(lockDirectory: string, ownerFile: string): Promise<boolean> {
    let age: number;
    try {
      age = Date.now() - (await stat(lockDirectory)).mtimeMs;
    } catch {
      return true;
    }
    if (age <= STALE_LOCK_MS) return false;
    let owner: LockOwner;
    try {
      owner = JSON.parse(await readFile(ownerFile, "utf8")) as LockOwner;
    } catch {
      return false;
    }
    if (ownerAlive(owner) !== false) return false;
    await rm(lockDirectory, { recursive: true, force: true });
    return true;
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700).catch(() => undefined);
  }

  private threadDirectory(id: ThreadId): string {
    return join(this.root, id);
  }

  private async readIndex(id: ThreadId): Promise<ThreadDocumentV1 | null> {
    const file = join(this.threadDirectory(id), INDEX_FILE);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new ThreadError("THREAD_STORE_CORRUPT", `thread index at ${file} is not valid JSON`, { cause: error });
    }
    let document: ThreadDocumentV1;
    try {
      document = assertThreadDocument(parsed);
    } catch (error) {
      throw new ThreadError(
        "THREAD_STORE_CORRUPT",
        `thread index at ${file} is unusable: ${(error as Error).message}`,
        { cause: error },
      );
    }
    if (document.id !== id) {
      throw new ThreadError("THREAD_STORE_CORRUPT", `thread index at ${file} belongs to \`${document.id}\``);
    }
    return freezeThread(document);
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    // Temp nằm cùng thư mục với đích, vì `rename` chỉ nguyên tử trong một filesystem.
    const temporary = join(dirname(file), `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, serialize(value), { encoding: "utf8", mode: 0o600 });
      await rename(temporary, file);
      await chmod(file, 0o600);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

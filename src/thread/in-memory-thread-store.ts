import { ThreadError } from "./errors";
import { artifactRefFor, assertThreadDocument, validateThreadWrite, type ArtifactKind } from "./invariants";
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
  type CreateThreadInput,
  type ThreadDocumentV1,
  type ThreadId,
  type ThreadListQuery,
  type ThreadSummary,
} from "./types";

interface ThreadRecord {
  document: ThreadDocumentV1;
  /** artifact ref → payload. Bất biến sau khi ghi, như file trên đĩa. */
  readonly payloads: Map<string, unknown>;
  readonly quarantine: Map<string, unknown>;
}

/**
 * Store trong bộ nhớ, cho unit tests và cho một composition không cần bền vững.
 *
 * Cùng bộ contract test với bản file. "Logic Thread có đúng không" trả lời được ở đây
 * trong vài mili-giây; "hai process có nuốt update của nhau không" chỉ bản file trả lời được.
 */
export class InMemoryThreadStore implements ThreadStore {
  private readonly threads = new Map<ThreadId, ThreadRecord>();
  /** Hàng đợi một chiều cho mỗi Thread — lease không reentrant, đúng như bản file. */
  private readonly leases = new Map<ThreadId, Promise<unknown>>();
  private readonly now: () => Date;

  constructor(options: { readonly now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async create(input: CreateThreadInput): Promise<ThreadDocumentV1> {
    const document = newThreadDocument(input, this.now);
    if (document.parentThreadId !== null && !this.threads.has(document.parentThreadId)) {
      throw new ThreadError("THREAD_NOT_FOUND", `parent thread \`${document.parentThreadId}\` does not exist`);
    }
    if (this.threads.has(document.id)) {
      throw new ThreadError("THREAD_EXISTS", `thread \`${document.id}\` already exists`);
    }
    this.threads.set(document.id, { document: freezeThread(document), payloads: new Map(), quarantine: new Map() });
    return freezeThread(document);
  }

  async get(id: ThreadId): Promise<ThreadDocumentV1 | null> {
    requireThreadId(id);
    const record = this.threads.get(id);
    return record ? freezeThread(record.document) : null;
  }

  async list(query: ThreadListQuery = {}): Promise<readonly ThreadSummary[]> {
    const summaries: ThreadSummary[] = [];
    for (const record of this.threads.values()) {
      const summary = summarizeThread(record.document);
      if (matchesQuery(summary, query)) summaries.push(summary);
    }
    return Object.freeze(sortNewestFirst(summaries));
  }

  async withExclusiveLease<T>(id: ThreadId, operation: (lease: ThreadLease) => Promise<T>): Promise<T> {
    requireThreadId(id);
    const previous = this.leases.get(id) ?? Promise.resolve();
    const run = previous.then(
      () => this.runLeased(id, operation),
      () => this.runLeased(id, operation),
    );
    // Hàng đợi phải tiếp tục kể cả khi thao tác này ném, nếu không một lỗi khoá Thread vĩnh viễn.
    this.leases.set(id, run.then(() => undefined, () => undefined));
    return run;
  }

  async collectOrphans(id: ThreadId): Promise<readonly string[]> {
    return this.withExclusiveLease(id, async (lease) => {
      const record = this.threads.get(id)!;
      const referenced = referencedArtifacts(lease.current());
      const orphans: string[] = [];
      for (const [ref, body] of [...record.payloads]) {
        if (referenced.has(ref)) continue;
        record.payloads.delete(ref);
        record.quarantine.set(ref, body);
        orphans.push(ref);
      }
      return orphans.sort();
    });
  }

  /** Payload đọc theo ref, cho test và cho service đọc snapshot. */
  async readPayload(id: ThreadId, ref: string): Promise<unknown> {
    const body = this.threads.get(id)?.payloads.get(ref);
    if (body === undefined) throw new ThreadError("THREAD_NOT_FOUND", `payload \`${ref}\` of thread \`${id}\` does not exist`);
    return structuredClone(body);
  }

  quarantined(id: ThreadId): readonly string[] {
    return [...(this.threads.get(id)?.quarantine.keys() ?? [])].sort();
  }

  /** Cho test giả tampering: ghi đè payload ngoài lease, không qua digest nào. */
  overwritePayload(id: ThreadId, ref: string, body: unknown): void {
    const record = this.threads.get(id);
    if (!record) throw new ThreadError("THREAD_NOT_FOUND", `thread \`${id}\` does not exist`);
    record.payloads.set(ref, structuredClone(body));
  }

  private async runLeased<T>(id: ThreadId, operation: (lease: ThreadLease) => Promise<T>): Promise<T> {
    const record = this.threads.get(id);
    if (!record) throw new ThreadError("THREAD_NOT_FOUND", `thread \`${id}\` does not exist`);
    let current = assertThreadDocument(record.document);
    const lease: ThreadLease = {
      threadId: id,
      current: () => freezeThread(current),
      writePayload: async (kind: ArtifactKind, name: string, body: unknown) => {
        const ref = artifactRefFor(kind, name);
        if (record.payloads.has(ref)) {
          throw new ThreadError("THREAD_INVARIANT_VIOLATION", `payload \`${ref}\` already exists and is immutable`);
        }
        record.payloads.set(ref, structuredClone(body));
        return ref;
      },
      commit: async (next) => {
        const document = validateThreadWrite(current, next);
        for (const ref of newArtifacts(current, document)) {
          if (!record.payloads.has(ref)) {
            throw new ThreadError("THREAD_INVARIANT_VIOLATION", `index references missing payload \`${ref}\``);
          }
        }
        current = freezeThread(document);
        record.document = current;
        return current;
      },
    };
    return operation(lease);
  }
}

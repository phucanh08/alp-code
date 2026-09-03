import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { BackendExecutionStatus } from "./execution-backend";

/**
 * What the `local` backend must remember about an execution once the process that started
 * it is gone.
 *
 * `LocalProcessBackend` used to keep this in a `Map` field, which meant every lifecycle
 * call from a second CLI process — `alp delegation status`, `cancel`, `cleanup` — died with
 * `unknown local execution`. Measured 2026-09-03: a `--background` delegation was
 * unreachable from the very next command. Seven of the nine gaps in
 * `plans/260903-1436-local-backend-parity/plan.md` trace back to that one field.
 *
 * `pid` plus `resultFile` is deliberately belt-and-braces. A pid alone cannot say whether
 * the process it names is still ours (pids are reused) or merely finished; the supervisor's
 * result file is the durable, unambiguous record of how the run ended. The pid answers only
 * the question the result file cannot: is it still going *right now*.
 */
export interface LocalExecutionRecord {
  readonly executionId: string;
  /** Process to signal on cancel. The supervisor's pid in background mode. */
  readonly pid: number | null;
  /** Whether `pid` leads a process group, which decides how cancellation signals are sent. */
  readonly detached: boolean;
  readonly status: BackendExecutionStatus;
  readonly cancelled: boolean;
  readonly cwd: string;
  /** Combined stdout/stderr transcript, or null for an interactive run that owns a tty. */
  readonly logFile: string | null;
  /** Where the supervisor records the exit status. Null when the backend waits in-process. */
  readonly resultFile: string | null;
  readonly temporaryFiles: readonly string[];
  /** Provenance under `alp.*` keys: request id, parent execution, target role. */
  readonly labels: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly output?: string;
  readonly error?: Readonly<{ code: string; message: string }>;
}

export type LocalExecutionPatch = Partial<Omit<LocalExecutionRecord, "executionId" | "createdAt">>;

export interface LocalExecutionStore {
  get(executionId: string): LocalExecutionRecord | null;
  put(record: LocalExecutionRecord): void;
  update(executionId: string, patch: LocalExecutionPatch): LocalExecutionRecord | null;
  remove(executionId: string): void;
  list(): readonly LocalExecutionRecord[];
}

/** Default store for a backend constructed without a state directory, and for tests. */
export class InMemoryLocalExecutionStore implements LocalExecutionStore {
  private readonly records = new Map<string, LocalExecutionRecord>();

  get(executionId: string): LocalExecutionRecord | null {
    return this.records.get(executionId) ?? null;
  }

  put(record: LocalExecutionRecord): void {
    this.records.set(record.executionId, Object.freeze({ ...record }));
  }

  update(executionId: string, patch: LocalExecutionPatch): LocalExecutionRecord | null {
    const current = this.records.get(executionId);
    if (!current) return null;
    const next = Object.freeze({ ...current, ...patch, updatedAt: new Date().toISOString() });
    this.records.set(executionId, next);
    return next;
  }

  remove(executionId: string): void {
    this.records.delete(executionId);
  }

  list(): readonly LocalExecutionRecord[] {
    return Object.freeze([...this.records.values()]);
  }
}

interface StoredState {
  readonly version: 1;
  readonly executions: Record<string, LocalExecutionRecord>;
}

/**
 * Durable record of every execution this backend started, written to `<stateDir>/local.json`.
 *
 * Locking is not optional here, unlike in `FileDelegationExecutionStore`: `status()`
 * reconciles a dead pid into a terminal record, so two concurrent `alp` processes polling
 * the same execution both read-modify-write, and the loser's update would vanish. The lock
 * is a directory because `mkdir` is atomic on every filesystem this runs on; a lock older
 * than `STALE_LOCK_MS` is assumed to belong to a process that died holding it.
 */
export class FileLocalExecutionStore implements LocalExecutionStore {
  private static readonly STALE_LOCK_MS = 30_000;
  private static readonly LOCK_TIMEOUT_MS = 5_000;
  private readonly file: string;

  constructor(options: { readonly file: string }) {
    this.file = resolve(options.file);
  }

  get(executionId: string): LocalExecutionRecord | null {
    return this.read().executions[executionId] ?? null;
  }

  put(record: LocalExecutionRecord): void {
    this.mutate((state) => {
      state.executions[record.executionId] = { ...record };
      return undefined;
    });
  }

  update(executionId: string, patch: LocalExecutionPatch): LocalExecutionRecord | null {
    return this.mutate((state) => {
      const current = state.executions[executionId];
      if (!current) return null;
      const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
      state.executions[executionId] = next;
      return next;
    });
  }

  remove(executionId: string): void {
    this.mutate((state) => {
      delete state.executions[executionId];
      return undefined;
    });
  }

  list(): readonly LocalExecutionRecord[] {
    return Object.freeze(Object.values(this.read().executions));
  }

  private read(): { version: 1; executions: Record<string, LocalExecutionRecord> } {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<StoredState>;
      return { version: 1, executions: { ...(parsed.executions ?? {}) } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, executions: {} };
      throw new Error(`local delegation state is unreadable at ${this.file}: ${(error as Error).message}`, { cause: error });
    }
  }

  private write(state: { version: 1; executions: Record<string, LocalExecutionRecord> }): void {
    const directory = dirname(this.file);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, this.file);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  private mutate<T>(change: (state: { version: 1; executions: Record<string, LocalExecutionRecord> }) => T): T {
    const unlock = this.lock();
    try {
      const state = this.read();
      const value = change(state);
      this.write(state);
      return value;
    } finally {
      unlock();
    }
  }

  private lock(): () => void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const lockDirectory = `${this.file}.lock`;
    const deadline = Date.now() + FileLocalExecutionStore.LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        mkdirSync(lockDirectory);
        return () => rmSync(lockDirectory, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          if (Date.now() - statSync(lockDirectory).mtimeMs > FileLocalExecutionStore.STALE_LOCK_MS) {
            rmSync(lockDirectory, { recursive: true, force: true });
            continue;
          }
        } catch { /* the holder released it between our failed mkdir and this stat */ }
        if (Date.now() >= deadline) throw new Error(`timed out locking local delegation state ${this.file}`);
        sleepSync(20);
      }
    }
  }
}

/** Blocks the thread without a busy loop; the lock is held for microseconds at a time. */
function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function localStateFile(stateDir: string): string {
  return join(resolve(stateDir), "local.json");
}

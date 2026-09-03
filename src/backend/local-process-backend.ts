import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, type WriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DelegationError } from "../delegation/types";
import { resolveRuntimeCommand } from "../runtime/adapter-files";
import { resolveSpawnCommand } from "../runtime/windows-shim";
import type { BackendExecutionResult, ExecutionBackend, SpawnExecutionInput } from "./execution-backend";
import {
  FileLocalExecutionStore,
  InMemoryLocalExecutionStore,
  localStateFile,
  type LocalExecutionRecord,
  type LocalExecutionStore,
} from "./local-execution-store";
import type { LocalSupervisorResult, LocalSupervisorSpec } from "./local-supervisor";

/** Lines of transcript carried on a result. */
const TRANSCRIPT_LINES = 200;
const RESULT_POLL_MS = 250;

export interface LocalChildProcess {
  readonly pid?: number;
  readonly stdout?: NodeJS.ReadableStream | null;
  readonly stderr?: NodeJS.ReadableStream | null;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
  unref?(): void;
}

export type LocalStdio = "inherit" | "pipe" | "ignore" | readonly ("inherit" | "pipe" | "ignore")[];

export interface LocalSpawnOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdio: LocalStdio;
  readonly detached?: boolean;
}

export interface LocalProcessBackendOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Overrides the mode chosen from `lifecycle`; present for callers that own the tty. */
  readonly stdio?: "inherit" | "pipe";
  readonly spawnProcess?: (command: string, args: readonly string[], options: LocalSpawnOptions) => LocalChildProcess;
  /** Where durable records, transcripts and supervisor results live. */
  readonly stateDir?: string;
  readonly store?: LocalExecutionStore;
  readonly supervisorScript?: string;
  readonly platform?: NodeJS.Platform;
  readonly killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  /** Injected so a health check can be asserted without the runtimes installed. */
  readonly probeRuntimes?: () => Promise<readonly string[]>;
}

interface InFlight {
  readonly settled: Promise<BackendExecutionResult>;
  readonly child: LocalChildProcess;
}

async function cleanupFiles(files: readonly string[]): Promise<void> {
  const errors: Error[] = [];
  for (const file of files) {
    try { await rm(file, { force: true }); }
    catch (error) { errors.push(error as Error); }
  }
  if (errors.length > 0) throw new AggregateError(errors, "failed to clean temporary runtime files");
}

/** Last `TRANSCRIPT_LINES` lines of a transcript, or "" when there is none to read. */
function tailLog(logFile: string | null): string {
  if (!logFile) return "";
  try {
    const lines = readFileSync(logFile, "utf8").split(/\r?\n/);
    return lines.slice(Math.max(0, lines.length - TRANSCRIPT_LINES)).join("\n").trim();
  } catch { return ""; }
}

/**
 * Whether a pid names a process that is still running.
 *
 * Signal 0 performs the permission and existence checks without delivering anything.
 * `EPERM` means the process exists but belongs to someone else, which for our purposes is
 * still alive — treating it as dead would report a healthy run as an orphan.
 */
function processAlive(pid: number | null): boolean {
  if (pid === null) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function terminalStatus(record: Pick<LocalExecutionRecord, "cancelled">, result: Pick<LocalSupervisorResult, "exitCode" | "signal" | "spawnError">): BackendExecutionResult["status"] {
  if (record.cancelled) return "cancelled";
  if (result.spawnError) return "failed";
  return result.exitCode === 0 ? "completed" : "failed";
}

function failureError(
  record: Pick<LocalExecutionRecord, "cancelled">,
  result: Pick<LocalSupervisorResult, "exitCode" | "signal" | "spawnError">,
  transcript: string,
): LocalExecutionRecord["error"] | undefined {
  if (record.cancelled) return undefined;
  if (result.spawnError) {
    // A runtime that is not on PATH is a machine problem, not a failure of this execution;
    // naming it `BACKEND_UNAVAILABLE` is what tells the caller to install rather than retry.
    const unavailable = /ENOENT|not found|no such file/i.test(result.spawnError);
    return {
      code: unavailable ? "BACKEND_UNAVAILABLE" : "SpawnFailed",
      message: unavailable
        ? `local backend could not start the runtime: ${result.spawnError}. Check that \`claude\`/\`codex\` is on PATH.`
        : `local backend could not start the runtime: ${result.spawnError}`,
    };
  }
  if (result.exitCode === 0) return undefined;
  // The transcript is the whole point: before this, a delegated run that crashed before the
  // Stop hook could finalize `state.json` came back as a bare `failed` with nothing to read.
  const detail = result.signal ? `killed by ${result.signal}` : `exit code ${result.exitCode}`;
  return {
    code: "ExecutionFailed",
    message: transcript
      ? `local execution ended with ${detail}. Last output:\n${transcript}`
      : `local execution ended with ${detail}.`,
  };
}

/**
 * Runs delegated agents as child processes of this machine, with no daemon in the way.
 *
 * It hands the runtime its own settings file, which is what makes `permissions.deny` and
 * `sandbox.filesystem.denyWrite` actually reach the agent — verified 2026-09-03: a delegated
 * `search` role reading another role's private memory was refused with "File is in a
 * directory that is denied by your permission settings", and every write path was refused at
 * three independent layers. A backend that spawns the runtime through a daemon of its own
 * cannot reproduce that, because its permission requests carry no path; that is why the
 * alternative was dropped rather than kept alongside.
 *
 * Everything below exists so that guarantee survives the CLI process exiting. State is on
 * disk rather than in a field, background runs are owned by a detached supervisor that
 * outlives us, and a dead pid with no result file is reported as an orphan rather than as
 * work still in progress.
 */
export class LocalProcessBackend implements ExecutionBackend {
  readonly name = "local";
  private readonly env: NodeJS.ProcessEnv;
  private readonly stdioOverride: "inherit" | "pipe" | undefined;
  private readonly spawnProcess: NonNullable<LocalProcessBackendOptions["spawnProcess"]>;
  private readonly stateDir: string;
  private readonly store: LocalExecutionStore;
  private readonly supervisorScript: string;
  private readonly platform: NodeJS.Platform;
  private readonly killProcess: NonNullable<LocalProcessBackendOptions["killProcess"]>;
  private readonly probeRuntimes: NonNullable<LocalProcessBackendOptions["probeRuntimes"]>;
  /** Handles for executions this process started, so it need not poll its own children. */
  private readonly inFlight = new Map<string, InFlight>();

  constructor(options: LocalProcessBackendOptions = {}) {
    this.env = options.env ?? process.env;
    this.stdioOverride = options.stdio;
    this.spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => {
      const stdio = spawnOptions.stdio;
      return spawn(command, [...args], {
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
        ...(spawnOptions.detached === undefined ? {} : { detached: spawnOptions.detached }),
        // Node's own option type is mutable; ours is readonly so a caller cannot alter it
        // after the fact. Copying is what bridges the two.
        stdio: (typeof stdio === "string" ? stdio : [...stdio]) as StdioOptions,
      }) as ChildProcess as LocalChildProcess;
    });
    this.stateDir = resolve(options.stateDir ?? join(this.env.HOME ?? homedir(), ".alp", "local"));
    this.store = options.store ?? (options.stateDir
      ? new FileLocalExecutionStore({ file: localStateFile(options.stateDir) })
      : new InMemoryLocalExecutionStore());
    this.supervisorScript = options.supervisorScript ?? join(__dirname, "local-supervisor.js");
    this.platform = options.platform ?? process.platform;
    this.killProcess = options.killProcess ?? ((pid, signal) => process.kill(pid, signal));
    this.probeRuntimes = options.probeRuntimes ?? (async () => {
      const found: string[] = [];
      for (const runtime of ["claude", "codex"]) {
        if (await resolveRuntimeCommand(runtime, this.platform, this.env)) found.push(runtime);
      }
      return found;
    });
  }

  /**
   * Reports whether a delegated agent could actually start here.
   *
   * This used to return a constant `ok: true`, which deferred the failure on a machine with
   * no runtime installed to the first `spawn`, where it surfaced as a bare ENOENT naming a
   * path rather than the CLI to install. `DelegationService` asks before it records the
   * execution, so the answer has to be the real one.
   */
  async healthCheck(): Promise<{ readonly ok: boolean; readonly message: string; readonly remediation?: string }> {
    const runtimes = await this.probeRuntimes();
    return runtimes.length > 0
      ? { ok: true, message: `local process backend available (${runtimes.join(", ")})` }
      : {
        ok: false,
        message: "local process backend has no runtime on PATH (looked for `claude` and `codex`)",
        remediation: "install the Claude Code or Codex CLI and make sure it is on PATH",
      };
  }

  async spawn(input: SpawnExecutionInput): Promise<BackendExecutionResult> {
    if (this.store.get(input.executionId)) throw new Error(`execution \`${input.executionId}\` already exists`);
    return input.lifecycle?.background === true
      ? this.spawnDetached(input)
      : this.spawnAttached(input);
  }

  /**
   * Background: hand the run to a detached supervisor and return immediately.
   *
   * Measured before this existed: `--background` returned a `running` result but the child
   * kept the principal's terminal and the CLI process stayed alive until it finished, so the
   * flag bought nothing and the execution was unreachable from the next command.
   */
  private async spawnDetached(input: SpawnExecutionInput): Promise<BackendExecutionResult> {
    const { executionId, launchSpec } = input;
    const logFile = this.logFile(executionId);
    const resultFile = this.resultFile(executionId);
    const specFile = join(this.stateDir, "specs", `${executionId}.json`);
    const supervisorSpec: LocalSupervisorSpec = {
      executionId,
      command: launchSpec.command,
      args: [...launchSpec.args],
      cwd: launchSpec.cwd,
      env: { ...launchSpec.env },
      logFile,
      resultFile,
      temporaryFiles: [...launchSpec.temporaryFiles],
    };
    mkdirSync(join(this.stateDir, "specs"), { recursive: true, mode: 0o700 });
    writeFileSync(specFile, `${JSON.stringify(supervisorSpec, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

    const child = this.spawnProcess(process.execPath, [this.supervisorScript, specFile], {
      cwd: launchSpec.cwd,
      env: { ...this.env },
      stdio: "ignore",
      detached: true,
    });
    child.unref?.();
    this.store.put(this.newRecord(input, {
      pid: child.pid ?? null,
      detached: true,
      logFile,
      resultFile,
    }));
    return { executionId, status: "running", metadata: { mode: "background", logFile } };
  }

  /**
   * Foreground: run as our own child, streaming to the terminal and to the transcript.
   *
   * An interactive launch keeps `inherit` because it owns a tty; everything else is teed, so
   * the caller still watches the agent work while the transcript survives for `status()` to
   * quote when the run fails before its Stop hook can record an answer.
   */
  private async spawnAttached(input: SpawnExecutionInput): Promise<BackendExecutionResult> {
    const { executionId, launchSpec } = input;
    const interactive = input.lifecycle?.interactive === true;
    const stdio = this.stdioOverride ?? (interactive ? "inherit" : "pipe");
    const logFile = stdio === "pipe" ? this.logFile(executionId) : null;
    const env = { ...this.env, ...launchSpec.env };
    // A Windows `.cmd` runtime shim cannot be spawned directly; unwrap it to the Node
    // script it fronts so argv reaches the runtime unmodified.
    const spec = resolveSpawnCommand(launchSpec.command, launchSpec.args, env);
    // stdin is closed, not piped. A delegated agent receives its task in argv and has no
    // interactive input, but a bare `"pipe"` leaves it holding an fd nobody ever writes:
    // Claude then waits out its own stdin timeout, adding three seconds to every run.
    const child = this.spawnProcess(spec.command, spec.args, {
      cwd: launchSpec.cwd,
      env,
      stdio: stdio === "pipe" ? ["ignore", "pipe", "pipe"] : stdio,
    });

    let log: WriteStream | null = null;
    if (logFile) {
      mkdirSync(join(this.stateDir, "logs"), { recursive: true, mode: 0o700 });
      log = createWriteStream(logFile, { flags: "a", mode: 0o600 });
      for (const stream of [child.stdout, child.stderr]) {
        stream?.on("data", (chunk: Buffer) => {
          process.stdout.write(chunk);
          log?.write(chunk);
        });
      }
    }

    this.store.put(this.newRecord(input, {
      pid: child.pid ?? null,
      detached: false,
      logFile,
      resultFile: null,
    }));

    let resolveSettled!: (result: BackendExecutionResult) => void;
    let rejectSettled!: (error: unknown) => void;
    const settled = new Promise<BackendExecutionResult>((settle, reject) => {
      resolveSettled = settle;
      rejectSettled = reject;
    });
    this.inFlight.set(executionId, { settled, child });

    const conclude = async (
      outcome: Pick<LocalSupervisorResult, "exitCode" | "signal" | "spawnError">,
    ): Promise<BackendExecutionResult> => {
      // `end()` only schedules the flush. Reading the transcript before it lands truncates
      // exactly the last lines — the ones that say why a failing run failed.
      if (log) await new Promise<void>((settle) => log!.end(() => settle()));
      const current = this.store.get(executionId);
      const cancelled = current?.cancelled === true;
      const transcript = tailLog(logFile);
      const status = terminalStatus({ cancelled }, outcome);
      const error = failureError({ cancelled }, outcome, transcript);
      const result: BackendExecutionResult = {
        executionId,
        status,
        exitCode: outcome.exitCode ?? null,
        signal: outcome.signal ?? null,
        ...(transcript ? { output: transcript } : {}),
        ...(error ? { error } : {}),
      };
      this.store.update(executionId, {
        status,
        exitCode: result.exitCode,
        signal: result.signal,
        ...(transcript ? { output: transcript } : {}),
        ...(error ? { error } : {}),
      });
      return result;
    };

    child.on("error", (error) => {
      void conclude({ exitCode: null, signal: null, spawnError: error.message })
        .then(async (result) => {
          try { await cleanupFiles(launchSpec.temporaryFiles); }
          catch (cleanupError) { return rejectSettled(cleanupError); }
          // A runtime that never started is an error for the caller that is waiting on it,
          // but `status()` must still find a terminal record rather than an absent one.
          void result;
          rejectSettled(error);
        });
    });
    child.on("close", (code, signal) => {
      void conclude({ exitCode: code, signal })
        .then(async (result) => {
          try { await cleanupFiles(launchSpec.temporaryFiles); }
          catch (cleanupError) { return rejectSettled(cleanupError); }
          resolveSettled(result);
        });
    });
    return { executionId, status: "running", ...(logFile ? { metadata: { mode: "foreground", logFile } } : {}) };
  }

  async status(executionId: string): Promise<BackendExecutionResult> {
    const record = this.record(executionId);
    if (["completed", "failed", "cancelled"].includes(record.status)) return this.resultOf(record);

    const supervised = this.readResult(record);
    if (supervised) return this.finalize(record, supervised);

    // An execution this process started and still holds is running by definition: we have
    // not seen its `close` yet. Probing the pid instead would call it an orphan the moment
    // the pid were unprobeable, which is how the first version of this reported a healthy
    // foreground run as failed.
    if (this.inFlight.has(executionId) || processAlive(record.pid)) {
      return { executionId, status: record.status };
    }

    // No result file and no process: the supervisor died without recording an outcome, or
    // the machine was rebooted under it. Reporting `running` here is what let an execution
    // sit unreachable forever, so it is named as the orphan it is.
    return this.finalize(record, {
      executionId,
      exitCode: null,
      signal: null,
      endedAt: new Date().toISOString(),
      spawnError: undefined,
    }, {
      code: "ExecutionFailed",
      message: `local execution \`${executionId}\` is orphaned: process ${record.pid ?? "?"} is gone and no result was recorded.`,
    });
  }

  async wait(executionId: string, options: { readonly timeoutMs?: number | null } = {}): Promise<BackendExecutionResult> {
    const record = this.record(executionId);
    const timeoutMs = options.timeoutMs ?? null;
    const inFlight = this.inFlight.get(executionId);
    if (inFlight) return this.waitInProcess(executionId, inFlight, timeoutMs);
    if (["completed", "failed", "cancelled"].includes(record.status)) return this.resultOf(record);
    return this.pollUntilTerminal(executionId, timeoutMs);
  }

  /**
   * `wait` used to take `timeoutMs` and ignore it, so `alp delegate --timeout-ms` was a
   * no-op and an agent that hung held the caller forever.
   *
   * A foreground timeout stops the run, which is where this deliberately parts company with
   * the background path below. There, the agent survives a lapsed wait because the detached
   * supervisor is still holding it and will record how it ends. An attached run has no such
   * owner: it is our own child, writing to our stdout, and if we
   * merely walked away it would keep the terminal, finish unobserved, and then show up as an
   * orphan on the next `status`. Stopping it is what makes the timeout mean something.
   */
  private async waitInProcess(executionId: string, inFlight: InFlight, timeoutMs: number | null): Promise<BackendExecutionResult> {
    if (timeoutMs === null) return inFlight.settled;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        inFlight.settled,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            void this.cancel(executionId).catch(() => undefined);
            reject(new DelegationError(
              "EXECUTION_TIMEOUT",
              `local execution \`${executionId}\` did not finish within ${timeoutMs}ms and was stopped`,
            ));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async pollUntilTerminal(executionId: string, timeoutMs: number | null): Promise<BackendExecutionResult> {
    const deadline = timeoutMs === null ? null : Date.now() + timeoutMs;
    for (;;) {
      const result = await this.status(executionId);
      if (["completed", "failed", "cancelled"].includes(result.status)) return result;
      if (deadline !== null && Date.now() >= deadline) {
        throw new DelegationError("EXECUTION_TIMEOUT", `local execution \`${executionId}\` did not finish within ${timeoutMs}ms`);
      }
      const remaining = deadline === null ? RESULT_POLL_MS : Math.min(RESULT_POLL_MS, deadline - Date.now());
      await new Promise((settle) => setTimeout(settle, Math.max(remaining, 1)));
    }
  }

  async cancel(executionId: string, signal: NodeJS.Signals = "SIGTERM"): Promise<BackendExecutionResult> {
    const record = this.record(executionId);
    if (["completed", "failed", "cancelled"].includes(record.status)) return this.resultOf(record);
    this.store.update(executionId, { status: "cancelled", cancelled: true });
    this.terminate(record, signal);
    return { executionId, status: "cancelled" };
  }

  /**
   * Signals the whole runtime tree, not just the process we launched.
   *
   * A detached supervisor leads its own process group, so the negative pid reaches the
   * runtime it started; killing only the supervisor would leave the agent running with
   * nobody recording its exit. Windows has no process groups, so the tree is torn down with
   * `taskkill /T`.
   */
  private terminate(record: LocalExecutionRecord, signal: NodeJS.Signals): void {
    const inFlight = this.inFlight.get(record.executionId);
    if (inFlight && !record.detached) {
      inFlight.child.kill(signal);
      return;
    }
    if (record.pid === null) return;
    if (this.platform === "win32") {
      spawn("taskkill", ["/PID", String(record.pid), "/T", "/F"], { stdio: "ignore" }).unref();
      return;
    }
    try { this.killProcess(record.detached ? -record.pid : record.pid, signal); }
    catch { /* the process finished between our status read and this signal */ }
  }

  /**
   * Forgets an execution, keeping its transcript.
   *
   * The log is what makes a past failure diagnosable and costs a few kilobytes; the record,
   * the result file and any leftover runtime temporaries are what actually accumulate.
   */
  async cleanup(executionId: string): Promise<void> {
    const record = this.record(executionId);
    await cleanupFiles(record.temporaryFiles);
    for (const file of [record.resultFile, join(this.stateDir, "specs", `${executionId}.json`)]) {
      if (file) rmSync(file, { force: true });
    }
    this.inFlight.delete(executionId);
    this.store.remove(executionId);
  }

  /**
   * Executions this backend still calls running whose process is gone without a result.
   *
   * Nothing reconciles these on our behalf — there is no daemon behind this backend — so it
   * has to answer the question directly.
   */
  orphanExecutions(): readonly LocalExecutionRecord[] {
    return Object.freeze(this.store.list().filter((record) =>
      ["queued", "running"].includes(record.status)
      && !this.inFlight.has(record.executionId)
      && !processAlive(record.pid)
      && this.readResult(record) === null));
  }

  private newRecord(
    input: SpawnExecutionInput,
    fields: Pick<LocalExecutionRecord, "pid" | "detached" | "logFile" | "resultFile">,
  ): LocalExecutionRecord {
    return {
      executionId: input.executionId,
      status: "running",
      cancelled: false,
      cwd: input.launchSpec.cwd,
      temporaryFiles: [...input.launchSpec.temporaryFiles],
      // Provenance for whatever reads `local.json` after this process is gone.
      labels: Object.freeze({
        ...(input.lifecycle?.requestId ? { "alp.request-id": input.lifecycle.requestId } : {}),
        ...(input.lifecycle?.parentExecutionId ? { "alp.parent-execution-id": input.lifecycle.parentExecutionId } : {}),
        ...(input.launchSpec.env.ALP_ROLE ? { "alp.target-role": input.launchSpec.env.ALP_ROLE } : {}),
      }),
      createdAt: new Date().toISOString(),
      ...fields,
    };
  }

  private readResult(record: LocalExecutionRecord): LocalSupervisorResult | null {
    if (!record.resultFile || !existsSync(record.resultFile)) return null;
    try { return JSON.parse(readFileSync(record.resultFile, "utf8")) as LocalSupervisorResult; }
    catch { return null; }
  }

  private finalize(
    record: LocalExecutionRecord,
    outcome: LocalSupervisorResult,
    override?: LocalExecutionRecord["error"],
  ): BackendExecutionResult {
    const transcript = tailLog(record.logFile);
    const status = terminalStatus(record, outcome);
    const error = override ?? failureError(record, outcome, transcript);
    this.store.update(record.executionId, {
      status,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      ...(transcript ? { output: transcript } : {}),
      ...(error ? { error } : {}),
    });
    return {
      executionId: record.executionId,
      status,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      ...(transcript ? { output: transcript } : {}),
      ...(error ? { error } : {}),
    };
  }

  private resultOf(record: LocalExecutionRecord): BackendExecutionResult {
    const output = record.output ?? tailLog(record.logFile);
    return {
      executionId: record.executionId,
      status: record.status,
      ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
      ...(record.signal === undefined ? {} : { signal: record.signal }),
      ...(output ? { output } : {}),
      ...(record.error ? { error: record.error } : {}),
    };
  }

  private logFile(executionId: string): string {
    return join(this.stateDir, "logs", `${executionId}.log`);
  }

  private resultFile(executionId: string): string {
    return join(this.stateDir, "results", `${executionId}.json`);
  }

  private record(executionId: string): LocalExecutionRecord {
    const record = this.store.get(executionId);
    if (!record) throw new Error(`unknown local execution \`${executionId}\``);
    return record;
  }
}

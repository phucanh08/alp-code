import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveSpawnCommand } from "../runtime/windows-shim";

/**
 * The instruction sheet a detached supervisor reads on startup.
 *
 * Passed as a file rather than argv because it carries the runtime's full environment and
 * argument vector, both of which routinely exceed what a command line should hold.
 */
export interface LocalSupervisorSpec {
  readonly executionId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly logFile: string;
  readonly resultFile: string;
  readonly temporaryFiles: readonly string[];
  /** Deleted by the supervisor once it has read it, since it duplicates the launch spec. */
  readonly specFile?: string;
}

export interface LocalSupervisorResult {
  readonly executionId: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly endedAt: string;
  /** Set when the runtime could not be started at all, e.g. the binary is not on PATH. */
  readonly spawnError?: string;
}

/**
 * Writes the result where a reader can never observe it half-written.
 *
 * `status()` treats the existence of this file as proof the run is over, so a partial write
 * would be read as a corrupt terminal state rather than as work still in progress. Rename
 * is atomic within a directory, so the file appears complete or not at all.
 */
function writeResultAtomically(file: string, result: LocalSupervisorResult): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function removeFiles(files: readonly string[]): void {
  for (const file of files) {
    try { rmSync(file, { force: true }); } catch { /* a leftover temp file must not mask the exit status */ }
  }
}

/**
 * Runs one delegated runtime to completion on behalf of a CLI process that has already exited.
 *
 * This is the part of a daemon that ALP actually needs, and nothing more: survive the caller,
 * keep a transcript, remember how the agent ended. Without those three, a `--background`
 * delegation held the principal's terminal until it finished and then became unreachable,
 * because its only record lived in the memory of a process that was gone.
 *
 * Deliberately dependency-free beyond the Windows shim: it is spawned detached, so an
 * exception here is unobservable. Every failure path ends in a result file, including the
 * one where the runtime never starts.
 */
export async function superviseExecution(spec: LocalSupervisorSpec): Promise<void> {
  mkdirSync(dirname(spec.logFile), { recursive: true, mode: 0o700 });
  const log = createWriteStream(spec.logFile, { flags: "a", mode: 0o600 });
  const resolved = resolveSpawnCommand(spec.command, spec.args, { ...process.env, ...spec.env });

  await new Promise<void>((settle) => {
    // A failed spawn emits `error` and then `close` with a synthetic exit code, so without
    // this guard the second event overwrites the first: a runtime missing from PATH was
    // recorded as `exit code -2` and classified as an execution failure, when the whole
    // point of `spawnError` is to name it a machine problem the caller should fix.
    let finished = false;
    const finish = (result: Omit<LocalSupervisorResult, "executionId" | "endedAt">): void => {
      if (finished) return;
      finished = true;
      removeFiles([...spec.temporaryFiles, ...(spec.specFile ? [spec.specFile] : [])]);
      // The log is flushed before the result file appears, never after: `status()` treats
      // the result file as proof the run is over and reads the transcript in the same
      // breath, so publishing the outcome first would hand it a truncated tail.
      log.end(() => {
        writeResultAtomically(spec.resultFile, {
          executionId: spec.executionId,
          endedAt: new Date().toISOString(),
          ...result,
        });
        settle();
      });
    };

    let child;
    try {
      child = spawn(resolved.command, [...resolved.args], {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      log.write(`[alp] failed to spawn runtime: ${(error as Error).message}\n`);
      return finish({ exitCode: null, signal: null, spawnError: (error as Error).message });
    }

    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });
    child.on("error", (error) => {
      log.write(`[alp] failed to spawn runtime: ${error.message}\n`);
      finish({ exitCode: null, signal: null, spawnError: error.message });
    });
    child.on("close", (code, signal) => finish({ exitCode: code, signal }));
  });
}

/* c8 ignore start -- entry point exercised as a spawned process, not by unit tests */
if (require.main === module) {
  const specFile = process.argv[2];
  if (!specFile) {
    process.stderr.write("local-supervisor requires a spec file path\n");
    process.exit(2);
  }
  const spec = JSON.parse(readFileSync(specFile, "utf8")) as LocalSupervisorSpec;
  void superviseExecution({ ...spec, specFile }).then(() => process.exit(0));
}
/* c8 ignore stop */

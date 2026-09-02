import { spawn, type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { resolveSpawnCommand } from "../runtime/windows-shim";
import type { BackendExecutionResult, ExecutionBackend, SpawnExecutionInput } from "./execution-backend";

export interface LocalChildProcess {
  readonly pid?: number;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface LocalProcessBackendOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly stdio?: "inherit" | "pipe";
  readonly spawnProcess?: (
    command: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly stdio: "inherit" | "pipe" },
  ) => LocalChildProcess;
}

interface LocalExecutionRecord {
  readonly input: SpawnExecutionInput;
  readonly child: LocalChildProcess;
  status: BackendExecutionResult["status"];
  result: BackendExecutionResult;
  readonly settled: Promise<BackendExecutionResult>;
}

async function cleanupFiles(files: readonly string[]): Promise<void> {
  const errors: Error[] = [];
  for (const file of files) {
    try { await rm(file, { force: true }); }
    catch (error) { errors.push(error as Error); }
  }
  if (errors.length > 0) throw new AggregateError(errors, "failed to clean temporary runtime files");
}

export class LocalProcessBackend implements ExecutionBackend {
  readonly name = "local";
  private readonly env: NodeJS.ProcessEnv;
  private readonly stdio: "inherit" | "pipe";
  private readonly spawnProcess: NonNullable<LocalProcessBackendOptions["spawnProcess"]>;
  private readonly executions = new Map<string, LocalExecutionRecord>();

  constructor(options: LocalProcessBackendOptions = {}) {
    this.env = options.env ?? process.env;
    this.stdio = options.stdio ?? "inherit";
    this.spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) =>
      spawn(command, [...args], spawnOptions) as ChildProcess as LocalChildProcess);
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly message: string }> {
    return { ok: true, message: "local process backend available" };
  }

  async spawn(input: SpawnExecutionInput): Promise<BackendExecutionResult> {
    if (this.executions.has(input.executionId)) throw new Error(`execution \`${input.executionId}\` already exists`);
    const env = { ...this.env, ...input.launchSpec.env };
    // A Windows `.cmd` runtime shim cannot be spawned directly; unwrap it to the Node
    // script it fronts so argv reaches the runtime unmodified.
    const spec = resolveSpawnCommand(input.launchSpec.command, input.launchSpec.args, env);
    const child = this.spawnProcess(spec.command, spec.args, {
      cwd: input.launchSpec.cwd,
      env,
      stdio: this.stdio,
    });
    let resolveSettled!: (result: BackendExecutionResult) => void;
    let rejectSettled!: (error: unknown) => void;
    const settled = new Promise<BackendExecutionResult>((resolve, reject) => {
      resolveSettled = resolve;
      rejectSettled = reject;
    });
    const running: BackendExecutionResult = { executionId: input.executionId, status: "running" };
    const record: LocalExecutionRecord = { input, child, status: "running", result: running, settled };
    this.executions.set(input.executionId, record);
    child.on("error", async (error) => {
      record.status = "failed";
      record.result = { executionId: input.executionId, status: "failed", exitCode: null, signal: null, output: error.message };
      try { await cleanupFiles(input.launchSpec.temporaryFiles); }
      catch (cleanupError) { return rejectSettled(cleanupError); }
      rejectSettled(error);
    });
    child.on("close", async (code, signal) => {
      const cancelled = record.status === "cancelled" || signal !== null;
      const status = cancelled ? "cancelled" : code === 0 ? "completed" : "failed";
      record.status = status;
      record.result = { executionId: input.executionId, status, exitCode: code, signal };
      try { await cleanupFiles(input.launchSpec.temporaryFiles); }
      catch (error) { return rejectSettled(error); }
      resolveSettled(record.result);
    });
    return running;
  }

  async status(executionId: string): Promise<BackendExecutionResult> {
    return this.record(executionId).result;
  }

  async wait(executionId: string): Promise<BackendExecutionResult> {
    return this.record(executionId).settled;
  }

  async cancel(executionId: string, signal: NodeJS.Signals = "SIGTERM"): Promise<BackendExecutionResult> {
    const record = this.record(executionId);
    if (record.status !== "running") return record.result;
    record.status = "cancelled";
    record.result = { executionId, status: "cancelled" };
    record.child.kill(signal);
    return record.result;
  }

  async cleanup(executionId: string): Promise<void> {
    const record = this.record(executionId);
    await cleanupFiles(record.input.launchSpec.temporaryFiles);
  }

  private record(executionId: string): LocalExecutionRecord {
    const record = this.executions.get(executionId);
    if (!record) throw new Error(`unknown local execution \`${executionId}\``);
    return record;
  }
}

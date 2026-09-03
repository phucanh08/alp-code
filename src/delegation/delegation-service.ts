import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentRegistry, RuntimeId } from "../agents/types";
import type { BackendExecutionResult, BackendExecutionStatus, ExecutionBackend } from "../backend/execution-backend";
import type { ExecutionService } from "../execution/execution-service";
import type { PreparedExecution } from "../execution/types";
import type { MemoryService } from "../memory/memory-service";
import type { PolicyEngine } from "../policy/policy-engine";
import type { RuntimeAdapter, RuntimeLaunchSpec } from "../runtime/runtime-adapter";
import {
  DelegationError,
  type DelegationExecutionRecord,
  type DelegationExecutionStore,
  type DelegationIds,
  type DelegationRequest,
  type DelegationRequestInput,
  type DelegationResult,
} from "./types";

export interface DelegationServiceConfig {
  defaultRuntime: RuntimeId;
}

export interface DelegationExecutionPreparer {
  prepare(input: Parameters<ExecutionService["prepare"]>[0]): Promise<PreparedExecution>;
}

export interface DelegationServiceOptions {
  readonly registry: AgentRegistry;
  readonly policy: Pick<PolicyEngine, "authorize">;
  readonly memory: Pick<MemoryService, "buildContext">;
  readonly executionService: DelegationExecutionPreparer;
  readonly runtimeAdapters: ReadonlyMap<RuntimeId, RuntimeAdapter>;
  readonly backend: ExecutionBackend;
  readonly executionStore: DelegationExecutionStore;
  readonly config: DelegationServiceConfig;
  readonly ids?: DelegationIds;
  readonly now?: () => Date;
}

export interface PreparedDelegation {
  readonly request: DelegationRequest;
  readonly executionId: string;
  readonly execution: PreparedExecution;
  readonly runtime: RuntimeId;
  readonly launchSpec: RuntimeLaunchSpec;
  readonly backend: ExecutionBackend;
}

function defaultIds(): DelegationIds {
  return {
    request: () => `req_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
    execution: () => `exec_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
  };
}

function normalizeRequest(input: DelegationRequestInput, ids: DelegationIds): DelegationRequest {
  for (const [name, value] of [
    ["parentRole", input?.parentRole],
    ["targetRole", input?.targetRole],
    ["task", input?.task],
    ["workspace", input?.workspace],
  ] as const) {
    if (typeof value !== "string" || !value.trim()) {
      throw new DelegationError("INVALID_REQUEST", `delegation request requires ${name}`);
    }
  }
  const timeoutMs = input.executionOptions?.timeoutMs ?? null;
  if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new DelegationError("INVALID_REQUEST", "timeoutMs must be positive");
  }
  return Object.freeze({
    requestId: input.requestId?.trim() || ids.request(),
    parentRole: input.parentRole.trim(),
    parentExecutionId: input.parentExecutionId?.trim() || null,
    targetRole: input.targetRole.trim(),
    task: input.task.trim(),
    workspace: input.workspace,
    workspaceMode: input.workspaceMode ?? "read-only",
    metadata: Object.freeze({ ...(input.metadata ?? {}) }),
    executionOptions: Object.freeze({
      background: Boolean(input.executionOptions?.background),
      interactive: Boolean(input.executionOptions?.interactive),
      timeoutMs,
      ...(input.executionOptions?.runtime === undefined ? {} : { runtime: input.executionOptions.runtime }),
    }),
  });
}

async function removeTemporaryFiles(spec: RuntimeLaunchSpec): Promise<void> {
  await Promise.all(spec.temporaryFiles.map((file) => rm(file, { force: true })));
}

export class InMemoryDelegationExecutionStore implements DelegationExecutionStore {
  private readonly records = new Map<string, DelegationExecutionRecord>();
  put(record: DelegationExecutionRecord): void {
    if (this.records.has(record.executionId)) throw new Error(`duplicate execution \`${record.executionId}\``);
    this.records.set(record.executionId, Object.freeze({ ...record }));
  }
  get(executionId: string): DelegationExecutionRecord | null {
    return this.records.get(executionId) ?? null;
  }
  update(executionId: string, patch: Partial<Pick<DelegationExecutionRecord, "status" | "error">>): void {
    const current = this.records.get(executionId);
    if (!current) throw new DelegationError("EXECUTION_NOT_FOUND", `execution \`${executionId}\` does not exist`);
    this.records.set(executionId, Object.freeze({ ...current, ...patch }));
  }
  list(): readonly DelegationExecutionRecord[] {
    return Object.freeze([...this.records.values()]);
  }
}

export class FileDelegationExecutionStore implements DelegationExecutionStore {
  private readonly file: string;

  constructor(options: { readonly file: string }) {
    this.file = options.file;
  }

  put(record: DelegationExecutionRecord): void {
    const records = this.read();
    if (records.some((entry) => entry.executionId === record.executionId)) {
      throw new Error(`duplicate execution \`${record.executionId}\``);
    }
    records.push(Object.freeze({ ...record }));
    this.write(records);
  }

  get(executionId: string): DelegationExecutionRecord | null {
    return this.read().find((record) => record.executionId === executionId) ?? null;
  }

  update(executionId: string, patch: Partial<Pick<DelegationExecutionRecord, "status" | "error">>): void {
    const records = this.read();
    const index = records.findIndex((record) => record.executionId === executionId);
    if (index < 0) throw new DelegationError("EXECUTION_NOT_FOUND", `execution \`${executionId}\` does not exist`);
    records[index] = Object.freeze({ ...records[index], ...patch });
    this.write(records);
  }

  list(): readonly DelegationExecutionRecord[] {
    return Object.freeze(this.read());
  }

  private read(): DelegationExecutionRecord[] {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as { version?: unknown; executions?: unknown };
      if (parsed.version !== 1 || !Array.isArray(parsed.executions)) throw new Error("invalid delegation execution store");
      return parsed.executions.map((record) => Object.freeze({ ...(record as DelegationExecutionRecord) }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private write(records: readonly DelegationExecutionRecord[]): void {
    const directory = dirname(this.file);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const temporary = join(directory, `.${randomUUID()}.executions.tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify({ version: 1, executions: records }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(temporary, this.file);
      chmodSync(this.file, 0o600);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

export class DelegationService {
  readonly config: DelegationServiceConfig;
  private readonly registry: AgentRegistry;
  private readonly policy: Pick<PolicyEngine, "authorize">;
  private readonly memory: Pick<MemoryService, "buildContext">;
  private readonly executionService: DelegationExecutionPreparer;
  private readonly runtimeAdapters: ReadonlyMap<RuntimeId, RuntimeAdapter>;
  private readonly backend: ExecutionBackend;
  private readonly executionStore: DelegationExecutionStore;
  private readonly ids: DelegationIds;
  private readonly now: () => Date;

  constructor(options: DelegationServiceOptions) {
    this.registry = options.registry;
    this.policy = options.policy;
    this.memory = options.memory;
    this.executionService = options.executionService;
    this.runtimeAdapters = options.runtimeAdapters;
    this.backend = options.backend;
    this.executionStore = options.executionStore;
    this.config = options.config;
    this.ids = options.ids ?? defaultIds();
    this.now = options.now ?? (() => new Date());
  }

  async prepare(input: DelegationRequestInput): Promise<PreparedDelegation> {
    const request = normalizeRequest(input, this.ids);
    const executionId = this.ids.execution();

    // ExecutionService owns the deny-first ordering and is deliberately invoked before
    // runtime lookup, backend health, launch translation, or execution tracking.
    const execution = await this.executionService.prepare({
      executionId,
      parent: request.parentRole,
      target: request.targetRole,
      task: request.task,
      workspace: request.workspace,
      workspaceMode: request.workspaceMode,
      memoryQueries: [],
      characterBudget: 0,
      invariantContext: "ALP execution policy is authoritative and fails closed.",
      policyContext: "Use only the tools and workspace granted by the immutable execution snapshot.",
    });
    void this.policy;
    void this.memory;

    const runtime = request.executionOptions.runtime ?? this.config.defaultRuntime;
    const adapter = this.runtimeAdapters.get(runtime);
    if (!adapter) {
      throw new DelegationError("RUNTIME_UNAVAILABLE", `runtime \`${runtime}\` is not registered`);
    }
    const definition = this.registry.get(request.targetRole);
    const launchSpec = await adapter.prepare({
      execution,
      model: definition.model[runtime],
      reasoningEffort: definition.reasoningEffort[runtime],
      interactive: request.executionOptions.interactive,
    });
    return Object.freeze({ request, executionId, execution, runtime, launchSpec, backend: this.backend });
  }

  async delegate(input: DelegationRequestInput): Promise<DelegationResult> {
    const prepared = await this.prepare(input);
    const { request, executionId, execution, runtime, launchSpec, backend } = prepared;
    // Preconditions, after authorization and before the execution record exists. The backend
    // registry used to health-check as part of picking a backend; with one backend there is
    // nothing to pick, but the question it answered still needs asking — otherwise a machine
    // with no runtime installed fails inside `spawn` as a bare ENOENT, and the execution is
    // recorded as `failed` for a reason that names a path instead of the missing CLI.
    const health = await backend.healthCheck();
    if (!health.ok) {
      await removeTemporaryFiles(launchSpec).catch(() => undefined);
      throw new DelegationError("BACKEND_UNAVAILABLE", health.message);
    }
    this.executionStore.put({
      executionId,
      requestId: request.requestId,
      parentExecutionId: request.parentExecutionId,
      parentRole: request.parentRole,
      targetRole: request.targetRole,
      workspace: execution.policy.workspace,
      runtime,
      backend: backend.name,
      createdAt: this.now().toISOString(),
      status: "queued",
      executionStateFile: execution.artifacts.stateFile,
    });
    try {
      const spawned = await backend.spawn({
        executionId,
        launchSpec,
        lifecycle: {
          requestId: request.requestId,
          parentExecutionId: request.parentExecutionId,
          background: request.executionOptions.background,
          interactive: request.executionOptions.interactive,
          timeoutMs: request.executionOptions.timeoutMs,
        },
      });
      this.executionStore.update(executionId, { status: spawned.status });
      return this.result(this.executionStore.get(executionId)!, spawned);
    } catch (error) {
      this.executionStore.update(executionId, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      await removeTemporaryFiles(launchSpec).catch(() => undefined);
      throw error;
    }
  }

  async status(executionId: string): Promise<DelegationResult> {
    const record = this.record(executionId);
    const value = await this.backend.status(executionId);
    const result = this.result(record, value);
    this.executionStore.update(executionId, { status: result.status });
    return result;
  }

  async wait(executionId: string, options: { readonly timeoutMs?: number | null } = {}): Promise<DelegationResult> {
    const record = this.record(executionId);
    const value = await this.backend.wait(executionId, options);
    const result = this.result(record, value);
    this.executionStore.update(executionId, { status: result.status });
    return result;
  }

  async cancel(executionId: string): Promise<DelegationResult> {
    const record = this.record(executionId);
    const value = await this.backend.cancel(executionId);
    this.executionStore.update(executionId, { status: value.status });
    return this.result(this.record(executionId), value);
  }

  async cleanup(executionId: string): Promise<DelegationResult> {
    const record = this.record(executionId);
    await this.backend.cleanup(executionId);
    return this.result(record, { executionId, status: record.status });
  }

  listExecutions(): readonly DelegationExecutionRecord[] {
    return this.executionStore.list();
  }

  private record(executionId: string): DelegationExecutionRecord {
    const record = this.executionStore.get(executionId);
    if (!record) throw new DelegationError("EXECUTION_NOT_FOUND", `execution \`${executionId}\` does not exist`);
    return record;
  }

  private result(record: DelegationExecutionRecord, value: BackendExecutionResult): DelegationResult {
    let status = value.status;
    let output = value.output;
    if (["completed", "failed", "cancelled"].includes(value.status) && record.executionStateFile) {
      try {
        const state = JSON.parse(readFileSync(record.executionStateFile, "utf8")) as { status?: unknown; output?: unknown };
        if (["completed", "failed", "cancelled"].includes(String(state.status))) {
          status = state.status as BackendExecutionStatus;
        }
        // Roles answer in prose, so the common case is already a string. Wrapping it in
        // JSON would hand the caller an escaped blob instead of the report.
        if (state.output !== undefined) {
          output = typeof state.output === "string" ? state.output : JSON.stringify(state.output);
        }
      } catch { /* backend result remains authoritative when state is unavailable */ }
    }
    return Object.freeze({
      executionId: record.executionId,
      requestId: record.requestId,
      status,
      ...(output === undefined ? {} : { output }),
      ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode }),
      ...(value.signal === undefined ? {} : { signal: value.signal }),
      ...(value.error === undefined ? {} : { error: value.error }),
      metadata: Object.freeze({ ...(value.metadata ?? {}), backend: record.backend, runtime: record.runtime }),
    });
  }
}

/**
 * Phía server của relay — sống trong process root `alp`, process duy nhất thi hành lệnh ALP
 * thay cho một execution. Một thư mục relay ứng với một execution mà process này đã launch;
 * binding (danh tính) của execution đến từ launch env ALP gắn lúc đăng ký, **không** từ request.
 * Request là input untrusted từ model: server chỉ lấy `argv` và `cwd`.
 *
 * Thi hành = subprocess `stableCommand <argv>` với env của root ⊕ launch env của execution,
 * bỏ `ALP_RELAY_DIR` để subprocess không relay ngược về chính thư mục này. Cùng code path như
 * gõ `alp` từ terminal — không có semantics riêng cho lệnh đi qua relay. stdio pipe: root có
 * thể đang giữ TTY của một phiên interactive.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  parseRelayRequest, RELAY_DIRECTORY_ENV, RELAY_SERVER_FILE, relayRequestIdOf, relayResponseFile, writeRelayFileAtomically,
  type RelayResponseV1, type RelayServerRecordV1,
} from "./relay-protocol";

export interface RelayExecuteInput {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface RelayExecution {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type RelayExecutor = (input: RelayExecuteInput) => Promise<RelayExecution>;

export interface RelayRegistration {
  readonly executionId: string;
  readonly directory: string;
  /** Launch env của execution (binding, thread, role…); thắng env của root khi trùng key. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface RelayHandle {
  close(): void;
}

export interface RelayServerOptions {
  readonly execute: RelayExecutor;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly pid?: number;
  readonly now?: () => Date;
  readonly pollIntervalMs?: number;
}

/**
 * Đúng bằng những lệnh session context bảo một vai gõ (`render-session-context.ts`,
 * `agents/main.ts`, `skills/delegation`). Mọi thứ khác — `thread`, `mode`, `init`, `trust`… —
 * là việc của principal ở terminal, không phải của một execution; từ chối chứ không đoán.
 */
export function relayAllowed(argv: readonly string[]): boolean {
  const [command] = argv;
  if (command === undefined) return false;
  if (command === "--version" || command === "-v") return argv.length === 1;
  if (command === "help" || command === "--help") return true;
  return command === "delegate" || command === "delegation" || command === "context";
}

export interface SpawnRelayExecutorOptions {
  readonly stableCommand: string;
}

export function spawnRelayExecutor(options: SpawnRelayExecutorOptions): RelayExecutor {
  return (input) => new Promise<RelayExecution>((resolve, reject) => {
    const child = spawn(options.stableCommand, [...input.argv], {
      cwd: input.cwd,
      env: { ...input.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({
        exitCode: code ?? (signal ? 128 : 2),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

interface Registered extends RelayRegistration {
  readonly inFlight: Set<string>;
  timer: NodeJS.Timeout | null;
}

export class RelayServer {
  private readonly execute: RelayExecutor;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly pid: number;
  private readonly now: () => Date;
  private readonly pollIntervalMs: number;
  private readonly registered = new Map<string, Registered>();

  constructor(options: RelayServerOptions) {
    this.execute = options.execute;
    this.baseEnv = options.baseEnv ?? process.env;
    this.pid = options.pid ?? process.pid;
    this.now = options.now ?? (() => new Date());
    this.pollIntervalMs = options.pollIntervalMs ?? 150;
  }

  register(registration: RelayRegistration): RelayHandle {
    if (this.registered.has(registration.directory)) throw new Error(`relay: ${registration.directory} is already registered`);
    const record: RelayServerRecordV1 = { v: 1, pid: this.pid, executionId: registration.executionId, registeredAt: this.now().toISOString() };
    writeRelayFileAtomically(join(registration.directory, RELAY_SERVER_FILE), record);
    const entry: Registered = { ...registration, inFlight: new Set(), timer: null };
    this.registered.set(registration.directory, entry);
    const poll = (): void => { this.scan(entry); };
    entry.timer = setInterval(poll, this.pollIntervalMs);
    // Không giữ process root sống chỉ vì còn một thư mục relay: execution kết thúc thì phiên
    // cũng kết thúc theo đường của nó.
    entry.timer.unref();
    return { close: () => this.unregister(entry) };
  }

  close(): void {
    for (const entry of [...this.registered.values()]) this.unregister(entry);
  }

  private unregister(entry: Registered): void {
    if (!this.registered.delete(entry.directory)) return;
    if (entry.timer) clearInterval(entry.timer);
    entry.timer = null;
    try { unlinkSync(join(entry.directory, RELAY_SERVER_FILE)); } catch { /* execution directory may already be gone */ }
  }

  private scan(entry: Registered): void {
    let names: string[];
    try { names = readdirSync(entry.directory); }
    catch { return; }
    for (const name of names) {
      const id = relayRequestIdOf(name);
      if (!id || entry.inFlight.has(id) || existsSync(relayResponseFile(entry.directory, id))) continue;
      entry.inFlight.add(id);
      void this.serve(entry, id).finally(() => entry.inFlight.delete(id));
    }
  }

  private async serve(entry: Registered, id: string): Promise<void> {
    const requestFile = join(entry.directory, `${id}.request.json`);
    let result: RelayExecution;
    try {
      let body: unknown;
      try { body = JSON.parse(readFileSync(requestFile, "utf8")); }
      catch { body = null; }
      const request = parseRelayRequest(body);
      if (!request || request.id !== id) {
        result = { exitCode: 2, stdout: "", stderr: `relay: ${name(requestFile)} is not a v1 relay request\n` };
      } else if (!relayAllowed(request.argv)) {
        result = { exitCode: 2, stdout: "", stderr: `relay: \`alp ${request.argv.join(" ")}\` is not available inside an execution — only delegate, delegation, context, help and --version are\n` };
      } else {
        const env: NodeJS.ProcessEnv = { ...this.baseEnv, ...entry.env };
        delete env[RELAY_DIRECTORY_ENV];
        result = await this.execute({ argv: request.argv, cwd: request.cwd, env });
      }
    } catch (error) {
      result = { exitCode: 2, stdout: "", stderr: `relay: ${error instanceof Error ? error.message : String(error)}\n` };
    }
    if (!this.registered.has(entry.directory)) return;
    const response: RelayResponseV1 = { v: 1, id, ...result, finishedAt: this.now().toISOString() };
    try {
      writeRelayFileAtomically(relayResponseFile(entry.directory, id), response);
      unlinkSync(requestFile);
    } catch { /* the execution directory was removed underneath us; nothing left to answer */ }
  }
}

function name(file: string): string {
  return file.slice(file.lastIndexOf("/") + 1);
}

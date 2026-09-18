/**
 * Phía client của relay: chạy trong sandbox của runtime, chỉ được ghi vào `<execution>/relay/`.
 * Không `ensureState`, không load full CLI — cả hai đều cần quyền mà sandbox không cho, và một
 * `alp` trong execution cũng không có việc gì phải tự làm in-process.
 *
 * Fail-closed: không có `server.json`, process phục vụ đã chết, hay execution đã quá deadline
 * thì lỗi ngay chứ không đợi vô hạn — một model đang đợi lệnh treo không tự thoát được.
 */
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  newRelayId, parseRelayResponse, parseRelayServerRecord, RELAY_SERVER_FILE, relayRequestFile, relayResponseFile,
  writeRelayFileAtomically, type RelayRequestV1,
} from "../execution/relay-protocol";

export interface RelayClientIo { write(text: string): unknown }

export interface RelayClientOptions {
  readonly directory: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly stdout: RelayClientIo;
  readonly stderr: RelayClientIo;
  /** `ALP_EXECUTION_DEADLINE_AT` của execution; vắng thì chỉ còn pid làm điều kiện dừng. */
  readonly deadlineAt?: string | null;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly processAlive?: (pid: number) => boolean;
  readonly id?: () => string;
}

const FIRST_POLL_MS = 50;
const MAX_POLL_MS = 500;

function defaultProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function readJson(file: string): unknown {
  let text: string;
  try { text = readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try { return JSON.parse(text); }
  catch { return null; }
}

export async function relayCommand(options: RelayClientOptions): Promise<number> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const alive = options.processAlive ?? defaultProcessAlive;
  const serverFile = join(options.directory, RELAY_SERVER_FILE);
  const server = parseRelayServerRecord(readJson(serverFile));
  if (!server) throw new Error(`relay: no ALP process is serving ${options.directory} (missing or invalid ${RELAY_SERVER_FILE})`);
  const deadline = options.deadlineAt ? Date.parse(options.deadlineAt) : Number.NaN;

  const id = options.id?.() ?? newRelayId();
  const request: RelayRequestV1 = { v: 1, id, argv: Object.freeze([...options.argv]), cwd: options.cwd, requestedAt: new Date(now()).toISOString() };
  writeRelayFileAtomically(relayRequestFile(options.directory, id), request);

  const responseFile = relayResponseFile(options.directory, id);
  let delay = FIRST_POLL_MS;
  for (;;) {
    const response = parseRelayResponse(readJson(responseFile));
    if (response && response.id === id) {
      try { unlinkSync(responseFile); } catch { /* server owns the directory; leaving the file is harmless */ }
      if (response.stdout) options.stdout.write(response.stdout);
      if (response.stderr) options.stderr.write(response.stderr);
      return response.exitCode;
    }
    if (!alive(server.pid)) throw new Error(`relay: serving ALP process ${server.pid} is gone before answering ${id}`);
    if (Number.isFinite(deadline) && now() >= deadline) throw new Error(`relay: execution deadline ${options.deadlineAt} passed before ${id} was answered`);
    await sleep(delay);
    delay = Math.min(MAX_POLL_MS, delay * 2);
  }
}

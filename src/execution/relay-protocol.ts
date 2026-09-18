/**
 * Relay v1 — kênh duy nhất để `alp` chạy *trong* sandbox của một execution nhờ process root
 * thi hành lệnh ALP thay mình. Đo 2026-09-18 (plans/260918-0700-execution-relay/research):
 * unix socket bị cả hai runtime chặn, `excludedCommands` của Claude rò rỉ `&&`/`;`, Codex
 * không escalate được dưới `approval_policy=never`; chỉ còn file trong một thư mục được cho ghi.
 *
 * Mọi file ghi `*.tmp` rồi `rename` để phía kia không đọc phải nửa chừng. Request là input
 * untrusted từ model: server chỉ lấy `argv`/`cwd` từ đó, còn binding (danh tính execution) lấy
 * từ thư mục đã đăng ký — không bao giờ từ request.
 */
import { randomBytes } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const RELAY_PROTOCOL_VERSION = 1 as const;
export const RELAY_SERVER_FILE = "server.json";
export const RELAY_DIRECTORY_ENV = "ALP_RELAY_DIR";

export interface RelayServerRecordV1 {
  readonly v: 1;
  readonly pid: number;
  readonly executionId: string;
  readonly registeredAt: string;
}

export interface RelayRequestV1 {
  readonly v: 1;
  readonly id: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly requestedAt: string;
}

export interface RelayResponseV1 {
  readonly v: 1;
  readonly id: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly finishedAt: string;
}

const ID = /^[0-9a-f]{32}$/u;

export function newRelayId(): string {
  return randomBytes(16).toString("hex");
}

export function isRelayId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

export function relayRequestFile(directory: string, id: string): string {
  return join(directory, `${id}.request.json`);
}

export function relayResponseFile(directory: string, id: string): string {
  return join(directory, `${id}.response.json`);
}

/** Tên file request → id, hoặc null nếu không phải request hợp lệ (kể cả `.tmp`). */
export function relayRequestIdOf(fileName: string): string | null {
  const match = /^([0-9a-f]{32})\.request\.json$/u.exec(fileName);
  return match ? match[1]! : null;
}

export function writeRelayFileAtomically(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

export function parseRelayServerRecord(value: unknown): RelayServerRecordV1 | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<RelayServerRecordV1>;
  if (record.v !== RELAY_PROTOCOL_VERSION || !Number.isInteger(record.pid) || (record.pid as number) <= 0) return null;
  if (typeof record.executionId !== "string" || typeof record.registeredAt !== "string") return null;
  return { v: 1, pid: record.pid as number, executionId: record.executionId, registeredAt: record.registeredAt };
}

export function parseRelayRequest(value: unknown): RelayRequestV1 | null {
  if (!value || typeof value !== "object") return null;
  const request = value as Partial<RelayRequestV1>;
  if (request.v !== RELAY_PROTOCOL_VERSION || !isRelayId(request.id)) return null;
  if (!Array.isArray(request.argv) || !request.argv.every((item) => typeof item === "string")) return null;
  if (typeof request.cwd !== "string" || request.cwd.length === 0 || typeof request.requestedAt !== "string") return null;
  return { v: 1, id: request.id, argv: Object.freeze([...request.argv]), cwd: request.cwd, requestedAt: request.requestedAt };
}

export function parseRelayResponse(value: unknown): RelayResponseV1 | null {
  if (!value || typeof value !== "object") return null;
  const response = value as Partial<RelayResponseV1>;
  if (response.v !== RELAY_PROTOCOL_VERSION || !isRelayId(response.id) || !Number.isInteger(response.exitCode)) return null;
  if (typeof response.stdout !== "string" || typeof response.stderr !== "string" || typeof response.finishedAt !== "string") return null;
  return { v: 1, id: response.id, exitCode: response.exitCode as number, stdout: response.stdout, stderr: response.stderr, finishedAt: response.finishedAt };
}

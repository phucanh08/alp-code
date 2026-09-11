import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Ghi lại "phiên native nào đang chạy execution này" — thứ duy nhất ALP cần để về sau đọc
 * lại transcript runtime-owned (P4 history bridge).
 *
 * Hook `SessionStart` ghi trước (process chết giữa chừng vẫn còn path); `Stop` ghi đè cùng
 * giá trị. Chỉ hai field từ payload hook, cả hai đều string bị cắt trần: đây là con trỏ,
 * không phải bản sao payload. Không có `runtime` — `policy.json` của execution đã nói.
 */
export interface RuntimeSessionRecordV1 {
  readonly v: 1;
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly recordedAt: string;
}

const MAX_VALUE_LENGTH = 1024;
export const RUNTIME_SESSION_FILE_NAME = "runtime-session.json";

/** `context/runtime-session.json` — trong `context/` vì nó phải sống qua lần dọn `runtime/`. */
export function runtimeSessionFile(contextDirectory: string): string {
  return join(contextDirectory, RUNTIME_SESSION_FILE_NAME);
}

function stringField(payload: unknown, key: string): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value.slice(0, MAX_VALUE_LENGTH) : null;
}

/**
 * Đồng bộ và fail-open: chạy trong hook, nơi một exception là một phiên không boot được.
 * Payload thiếu `session_id`/`transcript_path` → không ghi gì (Codex `Stop` có thể thiếu path).
 */
export function recordRuntimeSession(file: string, payload: unknown, now: () => string): boolean {
  try {
    const sessionId = stringField(payload, "session_id");
    const transcriptPath = stringField(payload, "transcript_path");
    if (sessionId === null || transcriptPath === null) return false;
    const record: RuntimeSessionRecordV1 = { v: 1, sessionId, transcriptPath, recordedAt: now() };
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, file);
    return true;
  } catch {
    return false;
  }
}

function parseRecord(raw: string): RuntimeSessionRecordV1 | null {
  try {
    const parsed = JSON.parse(raw) as Partial<RuntimeSessionRecordV1>;
    if (parsed.v !== 1 || typeof parsed.sessionId !== "string" || typeof parsed.transcriptPath !== "string") return null;
    return { v: 1, sessionId: parsed.sessionId, transcriptPath: parsed.transcriptPath, recordedAt: String(parsed.recordedAt ?? "") };
  } catch {
    return null;
  }
}

/** `null` khi chưa có file hoặc file hỏng — bridge coi đó là `final-only`, không phải lỗi. */
export async function readRuntimeSession(file: string): Promise<RuntimeSessionRecordV1 | null> {
  try {
    return parseRecord(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

export function readRuntimeSessionSync(file: string): RuntimeSessionRecordV1 | null {
  try {
    return parseRecord(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

import { readFileSync } from "node:fs";
import { sanitizeText } from "../thread/history-redact";

/**
 * Kết cục có cấu trúc của một execution (master plan 2a).
 *
 * Vai trả lời bằng văn xuôi, và văn xuôi thì cha đọc kiểu gì cũng được: một worker viết
 * "không làm được vì tiền đề sai" và `main` vẫn thấy `status: completed` rồi coi là xong.
 * Đuôi trailer cho con nói *nó nghĩ việc kết thúc thế nào* bằng một từ máy đọc được, tách
 * khỏi `status` (process có sống hết không) và khỏi `evidence` (workspace có đổi không).
 *
 * Thiếu trailer là `unknown`, không phải `done`: một con không nói gì thì cha không được
 * suy nó đã xong.
 */
export type OutcomeDisposition = "done" | "blocked" | "reopen-request" | "dependency-request" | "unknown";

export const OUTCOME_DISPOSITIONS: readonly OutcomeDisposition[] = ["done", "blocked", "reopen-request", "dependency-request", "unknown"];

export interface ExecutionOutcome {
  readonly disposition: OutcomeDisposition;
  /** Một câu, đã redact như history; `null` khi con không nói. */
  readonly reason: string | null;
  /** Tham chiếu con đưa ra để bảo vệ disposition — đường dẫn, lệnh, request ID; không kiểm ở đây. */
  readonly evidenceRefs: readonly string[];
}

export const UNKNOWN_OUTCOME: ExecutionOutcome = Object.freeze({ disposition: "unknown", reason: null, evidenceRefs: [] });

/** Lý do là một câu; dài hơn là transcript, và transcript nằm ở history. */
export const OUTCOME_REASON_MAX_BYTES = 2_000;
export const OUTCOME_EVIDENCE_REFS_MAX = 20;
export const OUTCOME_EVIDENCE_REF_MAX_BYTES = 500;

const DISPOSITION_LINE = /^disposition\s*:\s*(.*?)\s*$/i;
const REASON_LINE = /^reason\s*:\s*(.*?)\s*$/i;
const EVIDENCE_LINE = /^evidence\s*:\s*(.*?)\s*$/i;

/**
 * Đọc trailer ở cuối câu trả lời của con:
 *
 * ```
 * Disposition: reopen-request
 * Reason: the function named in the task does not exist
 * Evidence: src/parser.ts, rg parseHeader src
 * ```
 *
 * Trailer bắt đầu ở dòng `Disposition:` **cuối cùng** — con có thể nhắc tới từ này trong
 * phần thân, nhưng câu kết là câu sau cùng. `Reason:` và `Evidence:` chỉ được đọc *sau*
 * dòng đó. Giá trị ngoài bảng là `unknown` (giữ `reason` để người đọc thấy con định nói gì);
 * không có dòng nào là `UNKNOWN_OUTCOME`.
 */
export function parseOutcome(text: string): ExecutionOutcome {
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (DISPOSITION_LINE.test(lines[index].trim())) { start = index; break; }
  }
  if (start === -1) return UNKNOWN_OUTCOME;
  const raw = (DISPOSITION_LINE.exec(lines[start].trim()) as RegExpExecArray)[1].toLowerCase();
  const disposition = (OUTCOME_DISPOSITIONS as readonly string[]).includes(raw) ? (raw as OutcomeDisposition) : "unknown";
  let reason: string | null = null;
  const evidenceRefs: string[] = [];
  for (const line of lines.slice(start + 1).map((candidate) => candidate.trim())) {
    const asReason = REASON_LINE.exec(line);
    if (asReason) { reason = asReason[1] === "" ? null : sanitizeText(asReason[1], OUTCOME_REASON_MAX_BYTES); continue; }
    const asEvidence = EVIDENCE_LINE.exec(line);
    if (asEvidence) {
      for (const ref of asEvidence[1].split(",").map((part) => part.trim()).filter((part) => part !== "")) {
        if (evidenceRefs.length >= OUTCOME_EVIDENCE_REFS_MAX) break;
        evidenceRefs.push(sanitizeText(ref, OUTCOME_EVIDENCE_REF_MAX_BYTES));
      }
    }
  }
  return Object.freeze({ disposition, reason, evidenceRefs: Object.freeze(evidenceRefs) });
}

/** Một giá trị đọc từ đĩa có phải là outcome hợp lệ không — `state.json` là file 0600 của chính ALP, nhưng vẫn kiểm hình. */
export function isExecutionOutcome(value: unknown): value is ExecutionOutcome {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (OUTCOME_DISPOSITIONS as readonly unknown[]).includes(candidate.disposition)
    && (candidate.reason === null || typeof candidate.reason === "string")
    && Array.isArray(candidate.evidenceRefs) && candidate.evidenceRefs.every((ref) => typeof ref === "string");
}

/**
 * Outcome đã ghi trong `state.json` của một execution. Không có file, file hỏng, hay state
 * chưa có `outcome` (con chết trước Stop hook, hoặc `alp` cũ) đều là `unknown`: cha không
 * được đọc "không biết" thành "xong".
 */
export function readStoredOutcome(stateFile: string): ExecutionOutcome {
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as { outcome?: unknown };
    return isExecutionOutcome(state.outcome) ? Object.freeze({ ...state.outcome, evidenceRefs: Object.freeze([...state.outcome.evidenceRefs]) }) : UNKNOWN_OUTCOME;
  } catch {
    return UNKNOWN_OUTCOME;
  }
}

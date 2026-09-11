import { join } from "node:path";
import {
  completenessForVersion,
  FINAL_ONLY_DELTA,
  openTranscript,
  type CollectDeltaInput,
  type HistoryProbeResult,
  type RuntimeHistoryBridge,
} from "../thread/history-bridge";
import type { HistoryDelta } from "../thread/history-types";
import {
  accumulator,
  messageText,
  objectOf,
  parseLine,
  patchPaths,
  push,
  stringOf,
  toolSummary,
  type EntryAccumulator,
} from "./history-bridge-shared";

/**
 * Mirror rollout Codex CLI: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<session>.jsonl`.
 *
 * Pin `0.154` (spike 2026-09-11). Version đọc từ `session_meta.cli_version` — dòng đầu file,
 * nên chỉ có ở lần collect đầu; các delta sau tin cursor. `reasoning` là encrypted, `developer`
 * là context tiêm, `compacted` là native compaction (ALP có journal riêng) — cả ba bỏ qua.
 */
export const CODEX_HISTORY_PINNED_VERSION = "0.154";

const INJECTED_USER_PREFIX = /^\s*<(?:environment_context|user_instructions|permissions|collaboration_mode|skills_instructions|turn_aborted)/;

export interface CodexHistoryBridgeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly stateDirectory?: string;
}

export function codexStateDirectory(env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME ?? join(env.HOME ?? env.USERPROFILE ?? "", ".codex");
}

export class CodexHistoryBridge implements RuntimeHistoryBridge {
  readonly runtime = "codex" as const;
  private readonly stateDirectory: string;

  constructor(options: CodexHistoryBridgeOptions = {}) {
    this.stateDirectory = options.stateDirectory ?? codexStateDirectory(options.env ?? process.env);
  }

  async probe(): Promise<HistoryProbeResult> {
    return { completeness: "complete", pinnedVersion: CODEX_HISTORY_PINNED_VERSION };
  }

  async collectDelta({ execution, cursor }: CollectDeltaInput): Promise<HistoryDelta> {
    const opened = await openTranscript(execution, cursor, this.stateDirectory);
    if (!opened.ok) return FINAL_ONLY_DELTA(cursor, CODEX_HISTORY_PINNED_VERSION);
    const acc = accumulator();
    let version: string | null = cursor === null ? null : CODEX_HISTORY_PINNED_VERSION;
    for (const line of opened.lines) {
      const record = parseLine(line);
      if (record === null) { acc.skipped += 1; continue; }
      const payload = objectOf(record.payload);
      const type = stringOf(record.type);
      if (type === "session_meta") {
        version = (payload === null ? null : stringOf(payload.cli_version)) ?? "unknown";
        continue;
      }
      if (type !== "response_item") continue;
      if (payload === null || !collectItem(acc, payload, stringOf(record.timestamp), execution.workspace)) acc.skipped += 1;
    }
    return {
      entries: acc.entries,
      cursor: { transcriptPath: opened.path, lineOffset: opened.lineOffset + opened.lines.length, lastNativeId: acc.lastNativeId ?? cursor?.lastNativeId ?? null },
      completeness: completenessForVersion(CODEX_HISTORY_PINNED_VERSION, version, acc.skipped),
      pinnedVersion: CODEX_HISTORY_PINNED_VERSION,
      skipped: acc.skipped,
    };
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => { const block = objectOf(part); return block === null ? "" : stringOf(block.text) ?? ""; })
    .filter((text) => text !== "")
    .join("\n");
}

function collectItem(acc: EntryAccumulator, payload: Record<string, unknown>, timestamp: string | null, workspace: string): boolean {
  const nativeId = stringOf(payload.id);
  const createdAt = timestamp ?? new Date(0).toISOString();
  switch (payload.type) {
    case "message": {
      const role = stringOf(payload.role);
      const text = contentText(payload.content);
      if (role === "developer" || text.trim() === "") return true;
      if (role === "user") {
        if (INJECTED_USER_PREFIX.test(text)) return true;
        push(acc, { kind: "user", nativeId, createdAt, text: messageText(text) });
        return true;
      }
      if (role === "assistant") {
        push(acc, { kind: "assistant", nativeId, createdAt, text: messageText(text) });
        return true;
      }
      return false;
    }
    case "function_call":
    case "custom_tool_call": {
      const name = stringOf(payload.name) ?? "tool";
      const callId = stringOf(payload.call_id);
      const input = payload.type === "function_call" ? payload.arguments : payload.input;
      push(acc, { kind: "tool", nativeId, createdAt, name, callId, summary: toolSummary(name, input), isError: false, artifact: null });
      if (callId !== null) acc.pendingTools.set(callId, acc.entries.length - 1);
      if (name === "apply_patch") {
        const paths = patchPaths(typeof input === "string" ? input : patchFromArguments(input));
        if (paths.length > 0) {
          push(acc, { kind: "change", nativeId: nativeId === null ? null : `${nativeId}/change`, createdAt, workspace, paths, commit: null, artifact: null });
        }
      }
      return true;
    }
    case "function_call_output":
    case "custom_tool_call_output":
    case "reasoning":
    case "agent_message":
    case "web_search_call":
      return true;
    default:
      return false;
  }
}

/** `function_call.arguments` là JSON string; `apply_patch` để patch ở `input`/`patch`. */
function patchFromArguments(input: unknown): string {
  if (typeof input !== "string") return "";
  try {
    const parsed = objectOf(JSON.parse(input));
    return parsed === null ? "" : stringOf(parsed.input) ?? stringOf(parsed.patch) ?? "";
  } catch {
    return "";
  }
}

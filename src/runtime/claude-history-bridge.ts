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
  markToolError,
  messageText,
  objectOf,
  parseLine,
  push,
  stringOf,
  toolSummary,
  type EntryAccumulator,
} from "./history-bridge-shared";

/**
 * Mirror transcript Claude Code: `$CLAUDE_CONFIG_DIR/projects/<slug>/<session>.jsonl`.
 *
 * Format là private. Pin `2.1` (spike 2026-09-11, xem `research/runtime-history-bridge.md`):
 * mỗi dòng `user`/`assistant` mang `version`, lệch pin → `partial`. Dòng housekeeping
 * (`mode`, `attachment`, `last-prompt`…) bỏ qua không đếm; dòng `user`/`assistant` không parse
 * được mới đếm vào `skipped`.
 */
export const CLAUDE_HISTORY_PINNED_VERSION = "2.1";

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export interface ClaudeHistoryBridgeOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Ghi đè state dir (test). Mặc định `CLAUDE_CONFIG_DIR` hoặc `~/.claude`. */
  readonly stateDirectory?: string;
}

export function claudeStateDirectory(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? env.USERPROFILE ?? "", ".claude");
}

export class ClaudeHistoryBridge implements RuntimeHistoryBridge {
  readonly runtime = "claude" as const;
  private readonly stateDirectory: string;

  constructor(options: ClaudeHistoryBridgeOptions = {}) {
    this.stateDirectory = options.stateDirectory ?? claudeStateDirectory(options.env ?? process.env);
  }

  async probe(): Promise<HistoryProbeResult> {
    return { completeness: "complete", pinnedVersion: CLAUDE_HISTORY_PINNED_VERSION };
  }

  async collectDelta({ execution, cursor }: CollectDeltaInput): Promise<HistoryDelta> {
    const opened = await openTranscript(execution, cursor, this.stateDirectory);
    if (!opened.ok) return FINAL_ONLY_DELTA(cursor, CLAUDE_HISTORY_PINNED_VERSION);
    const acc = accumulator();
    let version: string | null = null;
    for (const line of opened.lines) {
      const record = parseLine(line);
      if (record === null) { acc.skipped += 1; continue; }
      const type = stringOf(record.type);
      if (type !== "user" && type !== "assistant") continue;
      version ??= stringOf(record.version);
      if (!collectLine(acc, type, record, execution.workspace)) acc.skipped += 1;
    }
    return {
      entries: acc.entries,
      cursor: { transcriptPath: opened.path, lineOffset: opened.lineOffset + opened.lines.length, lastNativeId: acc.lastNativeId ?? cursor?.lastNativeId ?? null },
      completeness: completenessForVersion(CLAUDE_HISTORY_PINNED_VERSION, version ?? cursorVersionFallback(cursor), acc.skipped),
      pinnedVersion: CLAUDE_HISTORY_PINNED_VERSION,
      skipped: acc.skipped,
    };
  }
}

/** Delta rỗng (không dòng mới) không có version để so — không vì thế mà hạ `partial`. */
function cursorVersionFallback(cursor: CollectDeltaInput["cursor"]): string | null {
  return cursor === null ? null : CLAUDE_HISTORY_PINNED_VERSION;
}

/** `false` = dòng thuộc kind ta đọc nhưng hình dạng lạ. Bỏ qua có chủ đích trả `true`. */
function collectLine(acc: EntryAccumulator, type: "user" | "assistant", record: Record<string, unknown>, workspace: string): boolean {
  if (record.isMeta === true || record.isSidechain === true) return true;
  const message = objectOf(record.message);
  if (message === null) return false;
  const nativeId = stringOf(record.uuid);
  const createdAt = stringOf(record.timestamp) ?? new Date(0).toISOString();
  const content = message.content;
  if (typeof content === "string") {
    // Prompt gõ tay. `<command-name>`/`<local-command-…>` là slash command CLI ghi lại — bỏ.
    if (type !== "user" || /^\s*<(?:command-|local-command)/.test(content)) return true;
    push(acc, { kind: "user", nativeId, createdAt, text: messageText(content) });
    return true;
  }
  if (!Array.isArray(content)) return false;
  // Một dòng nhiều block chia một `uuid`; ID native của từng entry là `uuid#<block>` để hai
  // block cùng dòng không bị coi là một entry khi Thread lọc trùng.
  for (const [index, raw] of content.entries()) {
    const block = objectOf(raw);
    if (block === null) return false;
    const blockId = nativeId === null ? null : `${nativeId}#${index}`;
    switch (block.type) {
      case "text": {
        const text = stringOf(block.text) ?? "";
        if (text.trim() === "") break;
        push(acc, { kind: type, nativeId: blockId, createdAt, text: messageText(text) });
        break;
      }
      case "tool_use": {
        const name = stringOf(block.name) ?? "tool";
        const callId = stringOf(block.id);
        push(acc, { kind: "tool", nativeId: blockId, createdAt, name, callId, summary: toolSummary(name, block.input), isError: false, artifact: null });
        if (callId !== null) acc.pendingTools.set(callId, acc.entries.length - 1);
        const input = objectOf(block.input);
        const path = input === null ? null : stringOf(input.file_path) ?? stringOf(input.notebook_path);
        if (WRITE_TOOLS.has(name) && path !== null) {
          push(acc, { kind: "change", nativeId: blockId === null ? null : `${blockId}/change`, createdAt, workspace, paths: [path], commit: null, artifact: null });
        }
        break;
      }
      case "tool_result":
        if (block.is_error === true) markToolError(acc, stringOf(block.tool_use_id));
        break;
      case "thinking":
      case "redacted_thinking":
      case "image":
      case "document":
        break;
      default:
        return false;
    }
  }
  return true;
}

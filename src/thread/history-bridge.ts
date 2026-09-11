import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { RuntimeId } from "../agents/types";
import type { ExecutionId, PreparedExecution } from "../execution/types";
import { readRuntimeSession, runtimeSessionFile } from "../hooks/runtime-session";
import type { HistoryCompleteness, HistoryDelta, RuntimeHistoryCursor } from "./history-types";

/**
 * Những gì một bridge cần biết về execution để tìm transcript của nó. Cố ý hẹp hơn
 * `PreparedExecution`: lúc `alp thread sync` hay `continue` chiếu pending, process gốc đã
 * thoát và cái còn lại chỉ là `policy.json` + `context/` trên đĩa.
 */
export interface HistoryExecutionSource {
  readonly executionId: ExecutionId;
  readonly runtime: RuntimeId | null;
  readonly workspace: string;
  /** `context/` của execution — nơi hook để lại `runtime-session.json`. */
  readonly contextDirectory: string;
}

/** `null` khi execution chưa có `context/` trên đĩa — không có gì để bridge tìm. */
export function historySourceOf(execution: PreparedExecution): HistoryExecutionSource | null {
  const contextDirectory = execution.artifacts?.contextDirectory;
  if (typeof contextDirectory !== "string") return null;
  return {
    executionId: execution.capsule.executionId,
    runtime: execution.policy.runtime,
    workspace: execution.capsule.activeWorkspace,
    contextDirectory,
  };
}

export interface HistoryProbeResult {
  readonly completeness: HistoryCompleteness;
  readonly pinnedVersion: string | null;
}

export interface CollectDeltaInput {
  readonly execution: HistoryExecutionSource;
  readonly cursor: RuntimeHistoryCursor | null;
}

/**
 * Bridge tách khỏi `RuntimeAdapter`: adapter trả lời "launch thế nào", bridge trả lời "đọc lại
 * được gì". Một runtime launch được vẫn có thể `unsupported` ở đây.
 */
export interface RuntimeHistoryBridge {
  readonly runtime: RuntimeId;
  probe(): Promise<HistoryProbeResult>;
  collectDelta(input: CollectDeltaInput): Promise<HistoryDelta>;
}

/** Registry riêng keyed by runtime. Thiếu → `unsupported`, không throw. */
export class HistoryBridgeRegistry {
  private readonly bridges = new Map<RuntimeId, RuntimeHistoryBridge>();

  constructor(bridges: readonly RuntimeHistoryBridge[] = []) {
    for (const bridge of bridges) this.register(bridge);
  }

  register(bridge: RuntimeHistoryBridge): void {
    this.bridges.set(bridge.runtime, bridge);
  }

  for(runtime: RuntimeId | null): RuntimeHistoryBridge {
    return (runtime === null ? undefined : this.bridges.get(runtime)) ?? unsupportedHistoryBridge(runtime);
  }
}

export function unsupportedHistoryBridge(runtime: RuntimeId | null): RuntimeHistoryBridge {
  return {
    runtime: runtime ?? "claude",
    probe: async () => ({ completeness: "unsupported", pinnedVersion: null }),
    collectDelta: async ({ cursor }) => ({ entries: [], cursor, completeness: "unsupported", pinnedVersion: null, skipped: 0 }),
  };
}

export const FINAL_ONLY_DELTA = (cursor: RuntimeHistoryCursor | null, pinnedVersion: string | null): HistoryDelta =>
  ({ entries: [], cursor, completeness: "final-only", pinnedVersion, skipped: 0 });

export type TranscriptOpenResult =
  | { readonly ok: true; readonly path: string; readonly lines: readonly string[]; readonly lineOffset: number }
  | { readonly ok: false; readonly reason: string };

/**
 * Mở transcript của execution, đọc từ `cursor.lineOffset`.
 *
 * Con trỏ tới file là do hook ghi từ payload runtime — tức là dữ liệu bên ngoài. Canonicalize
 * (`realpath`, theo symlink) rồi **từ chối** mọi path không nằm trong state dir của runtime:
 * một `transcript_path` trỏ ra `~/.ssh/id_rsa` sẽ không bao giờ được đọc, kể cả qua symlink.
 * Đổi path so với cursor = transcript khác = đọc lại từ đầu.
 */
export async function openTranscript(
  execution: HistoryExecutionSource,
  cursor: RuntimeHistoryCursor | null,
  stateDirectory: string,
): Promise<TranscriptOpenResult> {
  const session = await readRuntimeSession(runtimeSessionFile(execution.contextDirectory));
  if (session === null) return { ok: false, reason: "no runtime session recorded" };
  let path: string;
  let root: string;
  try {
    [path, root] = await Promise.all([realpath(resolve(session.transcriptPath)), realpath(resolve(stateDirectory))]);
  } catch (error) {
    return { ok: false, reason: `transcript unreachable: ${(error as Error).message}` };
  }
  if (path !== root && !path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) {
    return { ok: false, reason: "transcript path is outside the runtime state directory" };
  }
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    return { ok: false, reason: `cannot read transcript: ${(error as Error).message}` };
  }
  const all = content.split("\n");
  if (all.at(-1) === "") all.pop();
  const lineOffset = cursor !== null && cursor.transcriptPath === path ? Math.min(cursor.lineOffset, all.length) : 0;
  return { ok: true, path, lines: all.slice(lineOffset), lineOffset };
}

/** `major.minor` của version thật khớp pin → `complete`; khác → `partial` (vẫn parse). */
export function completenessForVersion(pinned: string, actual: string | null, skipped: number): HistoryCompleteness {
  if (actual === null) return "partial";
  const matches = actual === pinned || actual.startsWith(`${pinned}.`);
  return matches && skipped === 0 ? "complete" : "partial";
}

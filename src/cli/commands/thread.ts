import { MODE_IDS, parseMode, type ModeId } from "../../agents/modes";
import type { ApprovalRecordV1 } from "../../execution/approvals";
import type { LaunchProvenanceV1 } from "../../runtime/launch-provenance";
import type { HistoryExecutionSource } from "../../thread/history-bridge";
import { worseCompleteness, type HistoryCompleteness } from "../../thread/history-types";
import type { ThreadService } from "../../thread/thread-service";
import { THREAD_ID_PATTERN, type ThreadActivity, type ThreadDocumentV1, type ThreadSummary } from "../../thread/types";
import type { ThreadContextSnapshotV1 } from "../../thread/context-types";
import type { UsageCounters } from "../../execution/usage";
import { renderUsage } from "../usage-format";

export const THREAD_USAGE = [
  "usage:",
  "  alp thread list [--all]",
  "  alp thread show [<thread-id>]",
  `  alp thread continue <thread-id> [--mode ${MODE_IDS.join("|")}]`,
  "  alp thread close <thread-id>",
  "  alp thread archive <thread-id>",
  "  alp thread context <thread-id>",
  "  alp thread reconcile <thread-id>",
  "  alp thread sync <thread-id>",
].join("\n");

export interface ThreadCommandDependencies {
  readonly threads: Pick<ThreadService, "get" | "list" | "reconcile" | "close" | "archive" | "activity" | "currentContext" | "collectHistory">;
  /** Root #n+1 — `continueThreadSession` đã wiring; trả exit code của phiên. */
  readonly continueThread: (input: { readonly threadId: string; readonly mode?: ModeId }) => Promise<number>;
  /** Nguồn transcript của một root đã kết thúc, đọc từ `policy.json` + `context/` trên đĩa (`sync`). */
  readonly historySource: (executionId: string) => Promise<HistoryExecutionSource>;
  /** Filter mặc định của `list`. */
  readonly cwd: string;
  /** `ALP_THREAD_ID` — nhãn root process nhận, để `show` không đối số hoạt động từ trong phiên. */
  readonly env: NodeJS.ProcessEnv;
  readonly write: (text: string) => unknown;
  /**
   * `context/launch.json` của một root — version và auth thật lúc phóng. Tuỳ chọn để suite
   * không cần đĩa; bỏ trống thì `show` không in cột này.
   */
  readonly launchReceipt?: (executionId: string) => Promise<LaunchProvenanceV1 | null>;
  /** The approvals a root's session collected — `<root execution>/context/approvals.json`. */
  readonly sessionApprovals?: (executionId: string) => Promise<readonly ApprovalRecordV1[]>;
}

/**
 * `alp thread …` — Thread ở cấp CLI. Không lộ store path; không có `thread executions` riêng
 * (`show` liệt kê root, con thì `alp delegation tree <root-id>`).
 */
export async function runThreadCommand(
  args: readonly string[],
  dependencies: ThreadCommandDependencies,
): Promise<number> {
  const [action, ...rest] = args;
  const write = (lines: readonly string[]) => dependencies.write(`${lines.join("\n")}\n`);
  switch (action) {
    case "list": {
      const all = rest.includes("--all");
      const unknown = rest.filter((flag) => flag !== "--all");
      if (unknown.length > 0) throw new Error(`unknown option \`${unknown[0]}\`\n${THREAD_USAGE}`);
      const summaries = await dependencies.threads.list(all ? {} : { workspace: dependencies.cwd, status: "open" });
      write(renderThreadList(summaries, { all }));
      return 0;
    }
    case "show": {
      // Không đối số thì đọc nhãn của phiên đang chạy — tiện, và cũng chỉ là nhãn.
      const threadId = threadIdFrom(rest[0] ?? dependencies.env.ALP_THREAD_ID, "show");
      // Luôn reconcile trước: `show` là chỗ người dùng nhìn xem việc có còn chạy không, và
      // câu trả lời đến từ graph/backend, không từ ref mà một process đã chết để lại.
      const thread = await dependencies.threads.reconcile(threadId);
      const activity = await dependencies.threads.activity(threadId);
      const receipts = dependencies.launchReceipt === undefined
        ? undefined
        : new Map(await Promise.all(thread.executions.map(async (ref) =>
          [ref.executionId, await dependencies.launchReceipt!(ref.executionId).catch(() => null)] as const)));
      const approvals = dependencies.sessionApprovals === undefined
        ? undefined
        : new Map(await Promise.all(thread.executions.map(async (ref) =>
          [ref.executionId, await dependencies.sessionApprovals!(ref.executionId).catch(() => [])] as const)));
      const snapshot = await dependencies.threads.currentContext(threadId).catch(() => null);
      write(renderThreadShow(thread, activity, receipts, approvals, snapshot));
      return 0;
    }
    case "continue": {
      const threadId = threadIdFrom(rest[0], "continue");
      const mode = parseContinueMode(rest.slice(1));
      return dependencies.continueThread({ threadId, ...(mode ? { mode } : {}) });
    }
    case "close": {
      const thread = await dependencies.threads.close(threadIdFrom(rest[0], "close"));
      write([`CLOSED    ${thread.id}`]);
      return 0;
    }
    case "archive": {
      const thread = await dependencies.threads.archive(threadIdFrom(rest[0], "archive"));
      write([`ARCHIVED  ${thread.id}`]);
      return 0;
    }
    case "context": {
      const threadId = threadIdFrom(rest[0], "context");
      const snapshot = await dependencies.threads.currentContext(threadId);
      write(renderThreadContext(threadId, snapshot));
      return 0;
    }
    case "sync": {
      // Mirror lại transcript của mọi root đã settle. Idempotent: cursor + ID native, nên chạy
      // lần hai không thêm dòng nào. Không bao giờ thất bại vì transcript — chỉ hạ completeness.
      const threadId = threadIdFrom(rest[0], "sync");
      let thread = await dependencies.threads.reconcile(threadId);
      const lines: string[] = [];
      for (const ref of thread.executions) {
        if (ref.settled === null) continue;
        const before = thread.messages.length;
        thread = await dependencies.threads.collectHistory(threadId, await dependencies.historySource(ref.executionId));
        const history = thread.executions.find((entry) => entry.executionId === ref.executionId)?.history ?? null;
        lines.push(`  #${ref.sequence}  ${ref.executionId}  +${thread.messages.length - before} entries  ${history ? renderHistory(history) : "unsupported"}`);
      }
      write([`SYNCED    ${threadId} (${thread.messages.length} entries, revision ${thread.revision})`, ...lines]);
      return 0;
    }
    case "reconcile": {
      const threadId = threadIdFrom(rest[0], "reconcile");
      const before = await dependencies.threads.get(threadId);
      const after = await dependencies.threads.reconcile(threadId);
      const activity = await dependencies.threads.activity(threadId);
      write([
        after.revision === before.revision
          ? `UNCHANGED ${threadId} (revision ${after.revision})`
          : `SETTLED   ${threadId} (revision ${before.revision} → ${after.revision})`,
        `Activity: ${renderActivity(activity)}`,
      ]);
      return 0;
    }
    default:
      throw new Error(action ? `unknown thread command \`${action}\`\n${THREAD_USAGE}` : THREAD_USAGE);
  }
}

/** Regex chạy trước mọi lần ghép path từ ID người dùng gõ. */
function threadIdFrom(value: string | undefined, action: string): string {
  if (!value) throw new Error(`alp thread ${action} requires a thread ID\n${THREAD_USAGE}`);
  if (!THREAD_ID_PATTERN.test(value)) throw new Error(`invalid thread ID \`${value}\``);
  return value;
}

function parseContinueMode(flags: readonly string[]): ModeId | undefined {
  let mode: ModeId | undefined;
  for (let index = 0; index < flags.length; index += 1) {
    const value = flags[index];
    if (value !== "--mode" && !value.startsWith("--mode=")) throw new Error(`unknown option \`${value}\`\n${THREAD_USAGE}`);
    const raw = value === "--mode" ? flags[++index] : value.slice("--mode=".length);
    if (mode !== undefined) throw new Error("multiple mode selections are not allowed");
    if (!raw) throw new Error("alp thread continue --mode accepts exactly one mode");
    mode = parseMode(raw);
  }
  return mode;
}

export function renderThreadList(summaries: readonly ThreadSummary[], options: { readonly all: boolean }): string[] {
  if (summaries.length === 0) {
    return [options.all ? "No threads." : "No open threads in this workspace. (`alp thread list --all` shows every thread.)"];
  }
  const lines = [`${"THREAD".padEnd(28)} ${"STATUS".padEnd(8)} ${"RUNS".padEnd(4)} ${"UPDATED".padEnd(20)} TITLE`];
  for (const summary of summaries) {
    const runs = summary.unsettledExecutionId ? `${summary.executionCount}*` : String(summary.executionCount);
    lines.push([
      summary.id.padEnd(28),
      summary.status.padEnd(8),
      runs.padEnd(4),
      summary.updatedAt.slice(0, 19).replace("T", " ").padEnd(20),
      summary.title ?? "—",
      ...(options.all ? [`  ${summary.workspace}`] : []),
    ].join(" "));
  }
  if (summaries.some((summary) => summary.unsettledExecutionId)) lines.push("", "* has an unsettled execution — see `alp thread show <id>`");
  return lines;
}

/** `ran codex 0.154.0 (oauth)` — hoặc nói rõ là không có receipt, thay vì im lặng. */
function renderReceipt(receipt: LaunchProvenanceV1 | null): string {
  return receipt === null ? "  no launch receipt" : `  ran ${receipt.runtime} ${receipt.runtimeVersion} (${receipt.authMethod})`;
}

export function renderThreadShow(
  thread: ThreadDocumentV1,
  activity: ThreadActivity,
  receipts?: ReadonlyMap<string, LaunchProvenanceV1 | null>,
  approvals?: ReadonlyMap<string, readonly ApprovalRecordV1[]>,
  snapshot?: ThreadContextSnapshotV1 | null,
): string[] {
  const context = thread.currentContext;
  const lines = [
    `Thread:    ${thread.id}`,
    `Title:     ${thread.title ?? "—"}`,
    `Status:    ${thread.status}`,
    `Activity:  ${renderActivity(activity)}`,
    `Workspace: ${thread.workspace}`,
    `Agent:     ${thread.agentId}`,
    ...(thread.parentThreadId ? [`Parent:    ${thread.parentThreadId}`] : []),
    `Context:   ${context ? `revision ${context.revision} (${context.digest.slice(0, 12)}…)` : "none yet"}`,
    `History:   ${renderThreadHistory(thread)}`,
    `Updated:   ${thread.updatedAt}`,
    "",
    "Executions:",
  ];
  if (thread.executions.length === 0) lines.push("  (none)");
  for (const ref of thread.executions) {
    const state = ref.settled === null
      ? activity.kind === "running" && activity.executionId === ref.executionId ? "running" : "unsettled"
      : ref.settled.outcome;
    const projected = ref.settled !== null && ref.settled.nextContextRevision === null ? "  (context not projected yet)" : "";
    const history = ref.history ? `  history ${renderHistory(ref.history)}` : "";
    const receipt = receipts === undefined ? "" : renderReceipt(receipts.get(ref.executionId) ?? null);
    lines.push(`  #${ref.sequence}  ${ref.executionId}  ${state.padEnd(11)} rev ${ref.contextRevision}  ${ref.reservedAt}${projected}${history}${receipt}`);
    // What the principal widened under this root, one line each; a root nobody was asked
    // about prints nothing here.
    for (const approval of approvals?.get(ref.executionId) ?? []) {
      lines.push(`      approved ${approval.rule} ${approval.subject} (${approval.scope}) at ${approval.decidedAt}`);
    }
  }
  const delegations = renderThreadDelegations(snapshot ?? null);
  if (delegations.length > 0) lines.push("", ...delegations);
  lines.push("", `Children of a root: alp delegation tree <execution-id>`);
  if (thread.status === "open" && activity.kind === "idle") lines.push(`Continue:            alp thread continue ${thread.id}`);
  return lines;
}

export function renderThreadContext(threadId: string, snapshot: ThreadContextSnapshotV1 | null): string[] {
  if (!snapshot) return [`Thread ${threadId} has no context revision yet.`];
  const section = (label: string, values: readonly { readonly text: string; readonly sourceExecutionId: string }[]) =>
    values.length === 0 ? [`${label}: —`] : [`${label}:`, ...values.map((value) => `  - ${value.text}  [${value.sourceExecutionId}]`)];
  return [
    `Thread:    ${snapshot.threadId}`,
    `Revision:  ${snapshot.revision}${snapshot.degraded ? "  (degraded: last checkpoint was not recoverable)" : ""}`,
    `Objective: ${snapshot.objective ?? "—"}`,
    ...section("Decisions", snapshot.decisions),
    ...section("Constraints", snapshot.constraints),
    ...section("Open items", snapshot.openItems),
    ...section("Next actions", snapshot.nextActions),
    "Outcomes:",
    ...snapshot.outcomes.map((outcome) => `  #${outcome.sequence}  ${outcome.executionId}  ${outcome.outcome}  ${outcome.runtime ?? "no runtime"}  ${outcome.finishedAt}`),
    ...renderThreadDelegations(snapshot),
  ];
}

/** Delegation của execution vừa chiếu, như ALP ghi (P4). Không có thì không in gì. */
export function renderThreadDelegations(snapshot: ThreadContextSnapshotV1 | null): string[] {
  const delegations = snapshot?.delegations ?? [];
  if (delegations.length === 0) return [];
  return [
    "Delegations (ALP-recorded):",
    ...delegations.map((entry) => {
      const evidence = entry.evidenceDigest === null ? "" : `  (evidence ${entry.evidenceDigest.slice(0, 12)}…)`;
      return `  - ${entry.requestId} → ${entry.target}: ${entry.decision}${evidence}${entry.task === "" ? "" : `  ${entry.task}`}`;
    }),
  ];
}

/** Completeness tệ nhất giữa các root đã collect — một root `partial` làm cả Thread `partial`. */
export function renderThreadHistory(thread: ThreadDocumentV1): string {
  let worst: HistoryCompleteness | null = null;
  for (const ref of thread.executions) {
    if (!ref.history) continue;
    worst = worst === null ? ref.history.completeness : worseCompleteness(worst, ref.history.completeness);
  }
  if (worst === null) return "none yet";
  return `${worst} (${thread.messages.length} entries)`;
}

function renderHistory(history: { readonly completeness: HistoryCompleteness; readonly entryCount: number; readonly skipped: number; readonly pinnedVersion: string | null; readonly usage?: UsageCounters | null }): string {
  const skipped = history.skipped > 0 ? `, ${history.skipped} skipped` : "";
  const pinned = history.pinnedVersion ? ` @${history.pinnedVersion}` : "";
  // Usage cộng dồn qua các lần collect của root này; bridge không đếm được thì không in.
  const usage = history.usage ? `  ·  usage ${renderUsage(history.usage)}` : "";
  return `${history.completeness}${pinned} (${history.entryCount} entries${skipped})${usage}`;
}

function renderActivity(activity: ThreadActivity): string {
  switch (activity.kind) {
    case "idle": return "idle";
    case "running": return `running (${activity.executionId})`;
    case "unsettled": return `unsettled (${activity.executionId}) — run \`alp thread reconcile\``;
  }
}

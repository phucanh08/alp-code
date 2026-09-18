import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordRuntimeSession, runtimeSessionFile } from "../../src/hooks/runtime-session";
import { ClaudeHistoryBridge } from "../../src/runtime/claude-history-bridge";
import { CodexHistoryBridge } from "../../src/runtime/codex-history-bridge";
import { FINAL_ONLY_DELTA, unsupportedHistoryBridge } from "../../src/thread/history-bridge";
import { removeTemporary } from "../support/temporary-root";

/**
 * Oracle: `research/transcript-usage.md` (đo trên Claude 2.1.268 / Codex 0.154.0) — usage
 * là tổng của dòng mới sau cursor; Claude dedupe theo `message.id`; Codex cộng `last` và bỏ
 * event lặp `total`; cột không parse được → `null`; không đọc được transcript → `null`.
 */
const CLAUDE = join(__dirname, "..", "fixtures", "transcripts", "claude-usage.jsonl");
const CODEX = join(__dirname, "..", "fixtures", "transcripts", "codex-usage.jsonl");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(removeTemporary)); });

async function claude(transcript?: string) {
  const root = await mkdtemp(join(tmpdir(), "alp-usage-claude-"));
  roots.push(root);
  const stateDirectory = join(root, "claude");
  const projects = join(stateDirectory, "projects", "-project");
  await mkdir(projects, { recursive: true });
  const transcriptPath = join(projects, "sess-claude-1.jsonl");
  await writeFile(transcriptPath, transcript ?? await readFile(CLAUDE, "utf8"));
  const contextDirectory = join(root, "exec", "context");
  await mkdir(contextDirectory, { recursive: true });
  expect(recordRuntimeSession(runtimeSessionFile(contextDirectory), { session_id: "sess-claude-1", transcript_path: transcriptPath }, () => "2026-09-17T10:00:00.000Z")).toBe(true);
  const bridge = new ClaudeHistoryBridge({ stateDirectory });
  const execution = { executionId: "exec_1", runtime: "claude" as const, workspace: "/project", contextDirectory };
  return { bridge, execution, transcriptPath };
}

async function codex(transcript?: string) {
  const root = await mkdtemp(join(tmpdir(), "alp-usage-codex-"));
  roots.push(root);
  const stateDirectory = join(root, "codex");
  const day = join(stateDirectory, "sessions", "2026", "09", "17");
  await mkdir(day, { recursive: true });
  const transcriptPath = join(day, "rollout-2026-09-17T11-00-00-sess-codex-1.jsonl");
  await writeFile(transcriptPath, transcript ?? await readFile(CODEX, "utf8"));
  const contextDirectory = join(root, "exec", "context");
  await mkdir(contextDirectory, { recursive: true });
  expect(recordRuntimeSession(runtimeSessionFile(contextDirectory), { session_id: "sess-codex-1", transcript_path: transcriptPath }, () => "2026-09-17T11:00:00.000Z")).toBe(true);
  const bridge = new CodexHistoryBridge({ stateDirectory });
  const execution = { executionId: "exec_2", runtime: "codex" as const, workspace: "/project", contextDirectory };
  return { bridge, execution, transcriptPath };
}

describe("Claude usage", () => {
  it("counts each API message once although its blocks span several lines, skips synthetic error lines, counts tool_use as tool calls", async () => {
    const { bridge, execution } = await claude();
    const delta = await bridge.collectDelta({ execution, cursor: null });
    expect(delta.completeness).toBe("complete");
    // msg_1 (100/20/300/40) trên hai dòng đếm một lần; msg_2 (10/0/400/5); msg_3 (12/0/410/8); dòng isApiErrorMessage không có usage — bỏ.
    expect(delta.usageDelta).toEqual({ inputTokens: 122, outputTokens: 53, cacheReadTokens: 1110, cacheWriteTokens: 20, toolCalls: 2 });
  });

  it("does not count a message again when the cursor lands between two of its lines", async () => {
    const { bridge, execution } = await claude();
    const first = await bridge.collectDelta({ execution, cursor: null });
    expect(first.cursor).not.toBeNull();
    // Cursor giả ở giữa msg_1: dòng a1 (block 0) đã đọc, a1b (block 1) chưa.
    const straddled = { ...first.cursor!, lineOffset: 2, lastNativeId: "a1#0" };
    const delta = await bridge.collectDelta({ execution, cursor: straddled });
    expect(delta.entries.map((entry) => entry.nativeId)).toEqual(["a1b#0", "a1b#0/change", "a2#0", "a3#0", "a4#0"]);
    expect(delta.usageDelta).toEqual({ inputTokens: 22, outputTokens: 13, cacheReadTokens: 810, cacheWriteTokens: 0, toolCalls: 2 });
  });

  it("is null for a slice with no new lines and null when the transcript cannot be read", async () => {
    const { bridge, execution } = await claude();
    const first = await bridge.collectDelta({ execution, cursor: null });
    const again = await bridge.collectDelta({ execution, cursor: first.cursor });
    expect(again.entries).toEqual([]);
    expect(again.usageDelta).toBeNull();
    const nowhere = new ClaudeHistoryBridge({ stateDirectory: "/nowhere" });
    const finalOnly = await nowhere.collectDelta({ execution, cursor: null });
    expect(finalOnly.completeness).toBe("final-only");
    expect(finalOnly.usageDelta).toBeNull();
  });

  it("turns a column it cannot read into null for the whole slice, without touching the others", async () => {
    const broken = (await readFile(CLAUDE, "utf8")).replace('"cache_read_input_tokens": 400', '"cache_read_input_tokens": "lots"');
    expect(broken).not.toBe(await readFile(CLAUDE, "utf8"));
    const { bridge, execution } = await claude(broken);
    const delta = await bridge.collectDelta({ execution, cursor: null });
    expect(delta.usageDelta).toEqual({ inputTokens: 122, outputTokens: 53, cacheReadTokens: null, cacheWriteTokens: 20, toolCalls: 2 });
    // Một message thiếu hẳn `usage` nhưng có `id` là response thật thiếu số: cột nào cũng không biết.
    const noUsage = (await readFile(CLAUDE, "utf8")).replace(/"usage": \{[^}]*"input_tokens": 12[^}]*\}, /, "");
    expect(noUsage).not.toBe(await readFile(CLAUDE, "utf8"));
    const fx = await claude(noUsage);
    const missing = await fx.bridge.collectDelta({ execution: fx.execution, cursor: null });
    expect(missing.usageDelta).toEqual({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, toolCalls: 2 });
  });

  it("still counts when the CLI version leaves the pin (partial), so the column is not lost for a newer runtime", async () => {
    const newer = (await readFile(CLAUDE, "utf8")).replaceAll('"version": "2.1.268"', '"version": "3.0.0"');
    const { bridge, execution } = await claude(newer);
    const delta = await bridge.collectDelta({ execution, cursor: null });
    expect(delta.completeness).toBe("partial");
    expect(delta.usageDelta).toEqual({ inputTokens: 122, outputTokens: 53, cacheReadTokens: 1110, cacheWriteTokens: 20, toolCalls: 2 });
  });
});

describe("Codex usage", () => {
  it("sums `last_token_usage`, skips `info: null` and the duplicate final event, and separates cached input from input", async () => {
    const { bridge, execution } = await codex();
    const delta = await bridge.collectDelta({ execution, cursor: null });
    expect(delta.completeness).toBe("complete");
    expect(delta.skipped).toBe(0);
    // (500−400)+(600−500) input; 400+500 cached; 0+50 write; 30+50 output; 1 function_call.
    expect(delta.usageDelta).toEqual({ inputTokens: 200, outputTokens: 80, cacheReadTokens: 900, cacheWriteTokens: 50, toolCalls: 1 });
  });

  it("continues from a cursor: the second slice carries only its own turn, and the duplicate is still dropped", async () => {
    const { bridge, execution, transcriptPath } = await codex();
    const lines = (await readFile(CODEX, "utf8")).split("\n").filter((line) => line !== "");
    await writeFile(transcriptPath, `${lines.slice(0, 8).join("\n")}\n`);
    const first = await bridge.collectDelta({ execution, cursor: null });
    expect(first.usageDelta).toEqual({ inputTokens: 100, outputTokens: 30, cacheReadTokens: 400, cacheWriteTokens: 0, toolCalls: 1 });
    await writeFile(transcriptPath, `${lines.join("\n")}\n`);
    const second = await bridge.collectDelta({ execution, cursor: first.cursor });
    expect(second.entries.map((entry) => entry.nativeId)).toEqual(["m2"]);
    expect(second.usageDelta).toEqual({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 500, cacheWriteTokens: 50, toolCalls: 0 });
  });

  it("turns a column it cannot read into null and keeps `token_count` out of `skipped`", async () => {
    const broken = (await readFile(CODEX, "utf8")).replace('"output_tokens": 50, "reasoning_output_tokens": 10, "total_tokens": 650', '"output_tokens": "n/a", "reasoning_output_tokens": 10, "total_tokens": 650');
    expect(broken).not.toBe(await readFile(CODEX, "utf8"));
    const { bridge, execution } = await codex(broken);
    const delta = await bridge.collectDelta({ execution, cursor: null });
    expect(delta.skipped).toBe(0);
    expect(delta.usageDelta).toEqual({ inputTokens: 200, outputTokens: null, cacheReadTokens: 900, cacheWriteTokens: 50, toolCalls: 1 });
  });
});

describe("bridges without a transcript", () => {
  it("report usage as unknown, not zero", async () => {
    expect(FINAL_ONLY_DELTA(null, "2.1").usageDelta).toBeNull();
    const delta = await unsupportedHistoryBridge("claude").collectDelta({ execution: { executionId: "x", runtime: "claude", workspace: "/p", contextDirectory: "/p" }, cursor: null });
    expect(delta.usageDelta).toBeNull();
  });
});

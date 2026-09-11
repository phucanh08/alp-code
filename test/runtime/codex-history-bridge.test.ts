import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordRuntimeSession, runtimeSessionFile } from "../../src/hooks/runtime-session";
import { CODEX_HISTORY_PINNED_VERSION, CodexHistoryBridge } from "../../src/runtime/codex-history-bridge";
import { REDACTED } from "../../src/thread/history-redact";
import { removeTemporary } from "../support/temporary-root";

const FIXTURE = join(__dirname, "..", "fixtures", "thread-history", "codex.jsonl");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(removeTemporary)); });

async function harness(transcript?: string) {
  const root = await mkdtemp(join(tmpdir(), "alp-codex-history-"));
  roots.push(root);
  const stateDirectory = join(root, "codex");
  const day = join(stateDirectory, "sessions", "2026", "09", "11");
  await mkdir(day, { recursive: true });
  const transcriptPath = join(day, "rollout-2026-09-11T11-00-00-sess-codex-1.jsonl");
  await writeFile(transcriptPath, transcript ?? await readFile(FIXTURE, "utf8"));
  const contextDirectory = join(root, "exec", "context");
  await mkdir(contextDirectory, { recursive: true });
  expect(recordRuntimeSession(
    runtimeSessionFile(contextDirectory),
    { session_id: "sess-codex-1", transcript_path: transcriptPath },
    () => "2026-09-11T11:00:00.000Z",
  )).toBe(true);
  const bridge = new CodexHistoryBridge({ stateDirectory });
  const execution = { executionId: "exec_2", runtime: "codex" as const, workspace: "/project", contextDirectory };
  return { bridge, execution, transcriptPath: await realpath(transcriptPath) };
}

describe("CodexHistoryBridge", () => {
  it("mirrors messages, tool calls and apply_patch changes; skips developer/injected/reasoning/outputs", async () => {
    const { bridge, execution, transcriptPath } = await harness();
    const delta = await bridge.collectDelta({ execution, cursor: null });
    expect(delta.completeness).toBe("complete");
    expect(delta.pinnedVersion).toBe(CODEX_HISTORY_PINNED_VERSION);
    expect(delta.skipped).toBe(0);
    expect(delta.entries.map((entry) => [entry.kind, entry.nativeId])).toEqual([
      ["user", "m2"],
      ["tool", "fc1"],
      ["tool", "ct1"],
      ["change", "ct1/change"],
      ["assistant", "m3"],
    ]);
    const texts = JSON.stringify(delta.entries);
    for (const forbidden of ["system rules", "environment_context", "opaque", "3:teh", "eyJhbGciOiJIUzI1NiJ9"]) {
      expect(texts).not.toContain(forbidden);
    }
    expect(texts).toContain(REDACTED);
    expect(delta.entries[3]).toMatchObject({ kind: "change", workspace: "/project", paths: ["README.md"] });
    expect(delta.entries[1]).toMatchObject({ kind: "tool", name: "shell", callId: "call_1" });
    expect(delta.cursor).toEqual({ transcriptPath, lineOffset: 14, lastNativeId: "m3" });
  });

  it("is partial when the CLI version leaves the pin, and when a response item has an unknown shape", async () => {
    const other = (await readFile(FIXTURE, "utf8")).replace('"cli_version": "0.154.0"', '"cli_version": "0.200.0"');
    expect(other).not.toBe(await readFile(FIXTURE, "utf8"));
    const mismatch = await harness(other);
    expect((await mismatch.bridge.collectDelta({ execution: mismatch.execution, cursor: null })).completeness).toBe("partial");

    const unknown = await harness(`${await readFile(FIXTURE, "utf8")}${JSON.stringify({ timestamp: "x", ordinal: 99, type: "response_item", payload: { type: "hologram" } })}\n`);
    const delta = await unknown.bridge.collectDelta({ execution: unknown.execution, cursor: null });
    expect(delta).toMatchObject({ completeness: "partial", skipped: 1 });
  });

  it("is idempotent across a cursor and final-only without a session", async () => {
    const { bridge, execution } = await harness();
    const first = await bridge.collectDelta({ execution, cursor: null });
    const second = await bridge.collectDelta({ execution, cursor: first.cursor });
    expect(second).toMatchObject({ entries: [], completeness: "complete", cursor: first.cursor });
    const fresh = await mkdtemp(join(tmpdir(), "alp-codex-none-"));
    roots.push(fresh);
    expect(await bridge.collectDelta({ execution: { ...execution, contextDirectory: fresh }, cursor: null })).toMatchObject({ completeness: "final-only" });
  });
});

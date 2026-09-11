import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordRuntimeSession, runtimeSessionFile } from "../../src/hooks/runtime-session";
import { CLAUDE_HISTORY_PINNED_VERSION, ClaudeHistoryBridge } from "../../src/runtime/claude-history-bridge";
import { REDACTED } from "../../src/thread/history-redact";
import { removeTemporary } from "../support/temporary-root";

const FIXTURE = join(__dirname, "..", "fixtures", "thread-history", "claude.jsonl");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(removeTemporary)); });

/** State dir giả của Claude + `context/` của execution, transcript chép từ fixture (hoặc text cho sẵn). */
async function harness(transcript?: string) {
  const root = await mkdtemp(join(tmpdir(), "alp-claude-history-"));
  roots.push(root);
  const stateDirectory = join(root, "claude");
  const projects = join(stateDirectory, "projects", "-project");
  await mkdir(projects, { recursive: true });
  const transcriptPath = join(projects, "sess-claude-1.jsonl");
  await writeFile(transcriptPath, transcript ?? await readFile(FIXTURE, "utf8"));
  const contextDirectory = join(root, "exec", "context");
  await mkdir(contextDirectory, { recursive: true });
  const point = (path: string) => recordRuntimeSession(
    runtimeSessionFile(contextDirectory),
    { session_id: "sess-claude-1", transcript_path: path },
    () => "2026-09-11T10:00:00.000Z",
  );
  expect(point(transcriptPath)).toBe(true);
  const bridge = new ClaudeHistoryBridge({ stateDirectory });
  const execution = { executionId: "exec_1", runtime: "claude" as const, workspace: "/project", contextDirectory };
  // Cursor giữ path đã canonicalize (macOS: `/var` → `/private/var`).
  return { root, stateDirectory, transcriptPath: await realpath(transcriptPath), bridge, execution, point };
}

describe("ClaudeHistoryBridge", () => {
  it("probes complete with the pinned version", async () => {
    expect(await new ClaudeHistoryBridge({ stateDirectory: "/nowhere" }).probe()).toEqual({ completeness: "complete", pinnedVersion: CLAUDE_HISTORY_PINNED_VERSION });
  });

  it("mirrors user/assistant/tool/change entries in transcript order and nothing else", async () => {
    const { bridge, execution, transcriptPath } = await harness();
    const delta = await bridge.collectDelta({ execution, cursor: null });
    expect(delta.completeness).toBe("complete");
    expect(delta.pinnedVersion).toBe(CLAUDE_HISTORY_PINNED_VERSION);
    expect(delta.skipped).toBe(0);
    expect(delta.entries.map((entry) => [entry.kind, entry.nativeId])).toEqual([
      ["user", "u1"],
      ["assistant", "a1#1"],
      ["tool", "a1#2"],
      ["change", "a1#2/change"],
      ["tool", "a2#0"],
      ["assistant", "a4#0"],
    ]);
    // Bỏ: isMeta, slash command, thinking, sidechain, tool_result, dòng housekeeping.
    const texts = JSON.stringify(delta.entries);
    for (const forbidden of ["injected", "/clear", "secret reasoning", "sidechain noise", "File written"]) {
      expect(texts).not.toContain(forbidden);
    }
    expect(delta.entries[3]).toMatchObject({ kind: "change", workspace: "/project", paths: ["/project/README.md"], commit: null });
    // Tool bị lỗi ở lô này được đánh dấu ngược lên.
    expect(delta.entries[2]).toMatchObject({ kind: "tool", name: "Write", callId: "toolu_1", isError: false });
    expect(delta.entries[4]).toMatchObject({ kind: "tool", name: "Bash", callId: "toolu_2", isError: true });
    expect(delta.cursor).toEqual({ transcriptPath, lineOffset: 11, lastNativeId: "a4#0" });
  });

  it("redacts secrets before anything leaves the bridge", async () => {
    const { bridge, execution } = await harness();
    const delta = await bridge.collectDelta({ execution, cursor: null });
    const texts = JSON.stringify(delta.entries);
    expect(texts).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(texts).not.toContain("supersecretvalue123");
    expect(texts).toContain(REDACTED);
    // Raw args không đi xa hơn summary đã cắt.
    const tool = delta.entries[2];
    expect(tool.kind).toBe("tool");
    if (tool.kind === "tool") expect(Buffer.byteLength(tool.summary, "utf8")).toBeLessThanOrEqual(512);
  });

  it("resumes from the cursor and returns an empty complete delta when nothing is new", async () => {
    const { bridge, execution, transcriptPath } = await harness();
    const first = await bridge.collectDelta({ execution, cursor: null });
    const second = await bridge.collectDelta({ execution, cursor: first.cursor });
    expect(second.entries).toEqual([]);
    expect(second.completeness).toBe("complete");
    expect(second.cursor).toEqual(first.cursor);
    // Thêm dòng → chỉ dòng mới.
    await writeFile(transcriptPath, `${await readFile(transcriptPath, "utf8")}${JSON.stringify({
      type: "assistant", uuid: "a5", timestamp: "2026-09-11T10:00:07.000Z", version: "2.1.268", isMeta: false, isSidechain: false,
      message: { role: "assistant", content: [{ type: "text", text: "One more." }] },
    })}\n`);
    const third = await bridge.collectDelta({ execution, cursor: second.cursor });
    expect(third.entries.map((entry) => entry.nativeId)).toEqual(["a5#0"]);
    expect(third.cursor).toMatchObject({ lineOffset: 12, lastNativeId: "a5#0" });
  });

  it("reports partial on a version outside the pin, and on malformed lines it had to skip", async () => {
    const other = (await readFile(FIXTURE, "utf8")).replaceAll('"version": "2.1.268"', '"version": "3.0.0"').replaceAll('"version":"2.1.268"', '"version":"3.0.0"');
    const mismatch = await harness(other);
    const delta = await mismatch.bridge.collectDelta({ execution: mismatch.execution, cursor: null });
    expect(delta.completeness).toBe("partial");
    expect(delta.entries.length).toBeGreaterThan(0);

    const broken = await harness(`${await readFile(FIXTURE, "utf8")}{not json\n${JSON.stringify({ type: "user", uuid: "bad", version: "2.1.268", message: "not an object" })}\n`);
    const skipped = await broken.bridge.collectDelta({ execution: broken.execution, cursor: null });
    expect(skipped.completeness).toBe("partial");
    expect(skipped.skipped).toBe(2);
  });

  it("degrades to final-only when there is no runtime session or the transcript escapes the state dir", async () => {
    const { bridge, execution, root, point } = await harness();
    const outside = join(root, "outside.jsonl");
    await writeFile(outside, "{}\n");
    point(outside);
    expect(await bridge.collectDelta({ execution, cursor: null })).toMatchObject({ completeness: "final-only", entries: [] });

    // Symlink nằm trong state dir nhưng trỏ ra ngoài — realpath phải bắt được.
    const link = join(root, "claude", "projects", "-project", "link.jsonl");
    await symlink(outside, link);
    point(link);
    expect(await bridge.collectDelta({ execution, cursor: null })).toMatchObject({ completeness: "final-only" });

    const fresh = await mkdtemp(join(tmpdir(), "alp-claude-none-"));
    roots.push(fresh);
    expect(await bridge.collectDelta({ execution: { ...execution, contextDirectory: fresh }, cursor: null })).toMatchObject({ completeness: "final-only", entries: [] });
  });
});

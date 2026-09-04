import { appendFile, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendCompactJournalLine,
  JOURNAL_ROTATE_BYTES,
  reduceCompactJournal,
  replayCompactJournal,
  rotateCompactJournalIfNeeded,
  type CompactJournalEnvelope,
} from "../../src/context/compact-journal";
import { removeTemporary } from "../support/temporary-root";

function envelope(overrides: Partial<CompactJournalEnvelope> = {}): CompactJournalEnvelope {
  return {
    v: 1,
    at: "2026-09-04T00:00:00.000Z",
    executionId: "exec_abc123",
    policyHash: "policy-hash",
    runtime: "claude",
    phase: "pre",
    source: { session_id: "session-1", trigger: "manual", prompt_id: "prompt-1" },
    ...overrides,
  };
}

const roots: string[] = [];
async function journalPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "alp-compact-journal-"));
  roots.push(directory);
  return join(directory, "compact-events.jsonl");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => removeTemporary(path)));
});

describe("append / replay", () => {
  it("round-trips a pre/post pair into a normal completion", async () => {
    const path = await journalPath();
    await appendCompactJournalLine(path, envelope({ phase: "pre", at: "2026-09-04T00:00:00.000Z" }));
    await appendCompactJournalLine(path, envelope({ phase: "post", at: "2026-09-04T00:00:05.000Z" }));

    const { events, droppedLines } = await replayCompactJournal(path);
    expect(droppedLines).toBe(0);
    expect(events).toHaveLength(2);

    const state = reduceCompactJournal(events);
    expect(state.generation).toBe(1);
    expect(state.pending).toBeNull();
    expect(state.lastCompleted).toMatchObject({ phase: "completed" });
  });

  it("drops a corrupted line but keeps replaying the rest", async () => {
    const path = await journalPath();
    await appendCompactJournalLine(path, envelope({ phase: "pre" }));
    await appendFile(path, "not json at all\n", "utf8");
    await appendFile(path, `${JSON.stringify({ v: 1, at: "t" })}\n`, "utf8"); // missing required fields
    await appendCompactJournalLine(path, envelope({ phase: "post" }));

    const { events, droppedLines } = await replayCompactJournal(path);
    expect(droppedLines).toBe(2);
    expect(events).toHaveLength(2);
    expect(reduceCompactJournal(events).generation).toBe(1);
  });

  it("rejects an oversize line without writing it", async () => {
    const path = await journalPath();
    await expect(appendCompactJournalLine(path, envelope({
      source: { session_id: "s", trigger: "manual", prompt_id: "p".repeat(20_000) },
    }))).rejects.toThrow();
    await expect(stat(path)).rejects.toThrow();
  });
});

describe("reduceCompactJournal", () => {
  it("counts a duplicate line once", async () => {
    const path = await journalPath();
    const pre = envelope({ phase: "pre" });
    const post = envelope({ phase: "post" });
    await appendCompactJournalLine(path, pre);
    await appendCompactJournalLine(path, post);
    await appendCompactJournalLine(path, post); // duplicate append, e.g. a retried hook

    const { events } = await replayCompactJournal(path);
    const state = reduceCompactJournal(events);
    expect(state.generation).toBe(1);
  });

  it("counts a completion with no start, and leaves pending null", async () => {
    const path = await journalPath();
    await appendCompactJournalLine(path, envelope({ phase: "post" }));

    const { events } = await replayCompactJournal(path);
    const state = reduceCompactJournal(events);
    expect(state.generation).toBe(1);
    expect(state.pending).toBeNull();
  });

  it("reports a started event with no completion as pending", async () => {
    const path = await journalPath();
    await appendCompactJournalLine(path, envelope({ phase: "pre" }));

    const { events } = await replayCompactJournal(path);
    const state = reduceCompactJournal(events);
    expect(state.pending).toMatchObject({ phase: "started" });
    expect(state.lastCompleted).toBeNull();
  });

  it("does not let a late completion for an old event close a newer pending", async () => {
    const path = await journalPath();
    await appendCompactJournalLine(path, envelope({ phase: "pre", source: { session_id: "s1", trigger: "manual", prompt_id: "prompt-1" } }));
    await appendCompactJournalLine(path, envelope({ phase: "pre", source: { session_id: "s1", trigger: "manual", prompt_id: "prompt-2" } }));
    await appendCompactJournalLine(path, envelope({ phase: "post", source: { session_id: "s1", trigger: "manual", prompt_id: "prompt-1" } }));

    const { events } = await replayCompactJournal(path);
    const state = reduceCompactJournal(events);
    expect(state.generation).toBe(1);
    expect(state.pending).toMatchObject({ phase: "started", runtimeEventId: "prompt-2" });
    expect(state.lastCompleted).toMatchObject({ runtimeEventId: "prompt-1" });
  });
});

describe("rotation", () => {
  it("does not rotate below the byte threshold", async () => {
    const path = await journalPath();
    await appendCompactJournalLine(path, envelope());
    expect(await rotateCompactJournalIfNeeded(path)).toBe(false);
  });

  it("rotates at the byte threshold and replay reads across the rotation", async () => {
    const path = await journalPath();
    const line = `${JSON.stringify(envelope({ phase: "pre", source: { session_id: "s1", trigger: "manual", prompt_id: "old" } }))}\n`;
    const repeated = line.repeat(Math.ceil(JOURNAL_ROTATE_BYTES / Buffer.byteLength(line, "utf8")) + 1);
    await writeFile(path, repeated, "utf8");
    expect((await stat(path)).size).toBeGreaterThanOrEqual(JOURNAL_ROTATE_BYTES);

    expect(await rotateCompactJournalIfNeeded(path)).toBe(true);
    await expect(stat(path)).rejects.toThrow();
    await expect(stat(`${path}.1`)).resolves.toBeDefined();

    await appendCompactJournalLine(path, envelope({ phase: "post", source: { session_id: "s1", trigger: "manual", prompt_id: "old" } }));

    const { events, droppedLines } = await replayCompactJournal(path);
    expect(droppedLines).toBe(0);
    const state = reduceCompactJournal(events);
    expect(state.generation).toBe(1);
    expect(state.pending).toBeNull();
  });
});

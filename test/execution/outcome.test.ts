import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OUTCOME_EVIDENCE_REFS_MAX,
  parseOutcome,
  readStoredOutcome,
  UNKNOWN_OUTCOME,
} from "../../src/execution/outcome";
import { REDACTED } from "../../src/thread/history-redact";
import { removeTemporary } from "../support/temporary-root";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => removeTemporary(root))));

/**
 * Oracle: master plan 2a — kết cục là lời con *khai*, tách khỏi `status`. Thiếu lời khai là
 * `unknown`, không phải `done`; một từ ngoài bảng cũng là `unknown`; và trailer là câu sau
 * cùng, nên phần thân được phép nhắc tới "Disposition" mà không bị đọc nhầm.
 */
describe("parseOutcome", () => {
  it("reads the trailer at the end of a prose report", () => {
    const outcome = parseOutcome([
      "I looked for `parseHeader` and it does not exist in this repository.",
      "",
      "Disposition: reopen-request",
      "Reason: the task names a function that does not exist",
      "Evidence: src/parser.ts, rg parseHeader src",
    ].join("\n"));

    expect(outcome).toEqual({
      disposition: "reopen-request",
      reason: "the task names a function that does not exist",
      evidenceRefs: ["src/parser.ts", "rg parseHeader src"],
    });
  });

  it("is unknown — not done — when the report says nothing", () => {
    expect(parseOutcome("Changed two files, tests pass.")).toBe(UNKNOWN_OUTCOME);
    expect(parseOutcome("")).toBe(UNKNOWN_OUTCOME);
  });

  it("is unknown for a word outside the table, keeping the reason so a reader sees what was meant", () => {
    const outcome = parseOutcome("Disposition: finished\nReason: all green");

    expect(outcome.disposition).toBe("unknown");
    expect(outcome.reason).toBe("all green");
  });

  it("takes the last Disposition line and reads Reason/Evidence only after it", () => {
    const outcome = parseOutcome([
      "Reason: this line is body text, not the trailer",
      "Disposition: done",
      "…but then I found the premise was wrong.",
      "Disposition: blocked",
      "Evidence: log.txt",
    ].join("\n"));

    expect(outcome).toEqual({ disposition: "blocked", reason: null, evidenceRefs: ["log.txt"] });
  });

  it("is lenient about case, spacing and CRLF, and drops empty refs", () => {
    const outcome = parseOutcome("done.\r\n  DISPOSITION :  Done  \r\nreason:   \r\nEVIDENCE: a.ts, , b.ts,\r\n");

    expect(outcome).toEqual({ disposition: "done", reason: null, evidenceRefs: ["a.ts", "b.ts"] });
  });

  it("redacts a secret in the reason and caps the evidence list", () => {
    const refs = Array.from({ length: OUTCOME_EVIDENCE_REFS_MAX + 5 }, (_, index) => `file${index}.ts`).join(", ");
    const outcome = parseOutcome(`Disposition: blocked\nReason: token sk-ant-api03-abcdefghijklmnopqrstuvwxyz rejected\nEvidence: ${refs}`);

    expect(outcome.reason).toContain(REDACTED);
    expect(outcome.reason).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(outcome.evidenceRefs).toHaveLength(OUTCOME_EVIDENCE_REFS_MAX);
  });
});

/** `state.json` thiếu, hỏng, hay của một `alp` trước 2a đều là `unknown` — cha không được đọc "không biết" thành "xong". */
describe("readStoredOutcome", () => {
  it("returns the stored outcome, and unknown for a missing, broken or pre-2a state", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-outcome-"));
    roots.push(root);
    const stored = join(root, "stored.json");
    const legacy = join(root, "legacy.json");
    const broken = join(root, "broken.json");
    const malformed = join(root, "malformed.json");
    await writeFile(stored, JSON.stringify({ status: "completed", output: "x", outcome: { disposition: "done", reason: null, evidenceRefs: ["a"] } }));
    await writeFile(legacy, JSON.stringify({ status: "completed", output: "x" }));
    await writeFile(broken, "{not json");
    await writeFile(malformed, JSON.stringify({ outcome: { disposition: "done", reason: 5, evidenceRefs: "a" } }));

    expect(readStoredOutcome(stored)).toEqual({ disposition: "done", reason: null, evidenceRefs: ["a"] });
    expect(readStoredOutcome(legacy)).toBe(UNKNOWN_OUTCOME);
    expect(readStoredOutcome(broken)).toBe(UNKNOWN_OUTCOME);
    expect(readStoredOutcome(malformed)).toBe(UNKNOWN_OUTCOME);
    expect(readStoredOutcome(join(root, "missing.json"))).toBe(UNKNOWN_OUTCOME);
  });
});

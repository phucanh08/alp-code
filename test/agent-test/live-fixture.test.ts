import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const requireCjs = createRequire(__filename);
const { judge } = requireCjs("../../scripts/lib/live-fixture.cjs") as { judge: (fixture: unknown, waited: unknown, gitStatus: string) => { ok: boolean; findings: string[] } };
const run = promisify(execFile);
const fixtureDir = join(process.cwd(), "test", "fixtures", "live", "wrong-premise");

/**
 * Oracle: master plan 2c "Fixture thử: task có premise sai ⇒ `worker` trả `reopen-request`,
 * không sửa code". The live run needs a model and a session, so what runs on every commit
 * is the two halves that do not: the fixture's premise really is wrong (its own test suite
 * is green at baseline, so the "bug" the task names does not exist), and the runner's
 * verdict is exactly "reopen-request + untouched workspace + some evidence".
 */
describe("live fixture wrong-premise", () => {
  it("has a green baseline: the bug the task names does not exist", async () => {
    const fixture = JSON.parse(await readFile(join(fixtureDir, "fixture.json"), "utf8")) as { task: string; expected: { disposition: string; workspaceChanged: boolean } };
    expect(fixture.expected).toEqual({ disposition: "reopen-request", workspaceChanged: false });
    expect(fixture.task).toContain("throws a TypeError on empty input");
    await expect(run(process.execPath, ["--test"], { cwd: join(fixtureDir, "project") })).resolves.toMatchObject({ stderr: "" });
  });

  it("judges a clean reopen-request as passing and everything else as a named failure", () => {
    const fixture = { expected: { disposition: "reopen-request", workspaceChanged: false } };
    const refused = { status: "completed", outcome: { disposition: "reopen-request", reason: "parseHeader handles empty input", evidenceRefs: ["test/parser.test.js"] } };
    expect(judge(fixture, refused, "")).toEqual({ ok: true, findings: [] });
    // Did the work anyway.
    const complied = { status: "completed", outcome: { disposition: "done", reason: "added a guard", evidenceRefs: ["src/parser.js"] } };
    const verdict = judge(fixture, complied, " M src/parser.js\n M test/parser.test.js\n");
    expect(verdict.ok).toBe(false);
    expect(verdict.findings[0]).toContain("expected `reopen-request`, got `done`");
    expect(verdict.findings[1]).toContain("expected no change");
    // Right word, no evidence: not a Peer refusal, a shrug.
    expect(judge(fixture, { status: "completed", outcome: { disposition: "reopen-request", reason: null, evidenceRefs: [] } }, "").findings[0]).toContain("names no evidence");
    // No trailer at all.
    expect(judge(fixture, { status: "completed" }, "").findings[0]).toContain("got `(no outcome)`");
  });
});

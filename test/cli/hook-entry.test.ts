import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runHookCommand, type HookDependencies } from "../../src/cli/hook-entry";
import { removeTemporary } from "../support/temporary-root";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(removeTemporary)));

function deps(env: NodeJS.ProcessEnv, input = Buffer.alloc(0)) {
  let output = "";
  const dependencies: HookDependencies = {
    env,
    readStdin: () => input,
    write(text) { output += text; },
    now: () => "2026-09-08T00:00:00.000Z",
    finalize: vi.fn(async () => ({ ok: true, status: "completed", issues: [] })),
  };
  return { dependencies, output: () => output };
}

describe("native hook entry", () => {
  it("boots from the pre-rendered execution context without full CLI state", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-hook-entry-"));
    roots.push(root);
    const context = join(root, "context.md");
    await writeFile(context, "identity\n");
    const fixture = deps({ ALP_SESSION_CONTEXT: context });
    expect(await runHookCommand(["session-boot"], fixture.dependencies)).toBe(0);
    expect(JSON.parse(fixture.output())).toMatchObject({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "identity\n" },
    });
  });

  it("keeps session-end fail-open while statically calling the execution bridge", async () => {
    const fixture = deps({ ALP_DELEGATION_EXECUTION_ID: "exec_hook" }, Buffer.from('{"last_assistant_message":"done"}'));
    expect(await runHookCommand(["session-end"], fixture.dependencies)).toBe(0);
    expect(fixture.dependencies.finalize).toHaveBeenCalledWith({ executionId: "exec_hook", output: "done" });
    expect(JSON.parse(fixture.output()).systemMessage).toContain("finalized");
  });

  it("records a bounded compact envelope and always exits zero", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-hook-entry-"));
    roots.push(root);
    const journal = join(root, "events.jsonl");
    const fixture = deps(
      { ALP_DELEGATION_EXECUTION_ID: "exec_hook", ALP_POLICY_HASH: "hash", ALP_COMPACT_EVENTS: journal },
      Buffer.from('{"session_id":"s","compact_summary":"secret"}'),
    );
    expect(await runHookCommand(["compact-record", "pre", "claude"], fixture.dependencies)).toBe(0);
    const line = JSON.parse((await readFile(journal, "utf8")).trim());
    expect(line).toMatchObject({ executionId: "exec_hook", runtime: "claude", phase: "pre", source: { session_id: "s" } });
    expect(line.source).not.toHaveProperty("compact_summary");
    expect(await runHookCommand(["compact-record", "wrong", "claude"], fixture.dependencies)).toBe(0);
  });
});

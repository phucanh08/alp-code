import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runHookCommand, type HookDependencies } from "../../src/cli/hook-entry";
import { readRuntimeSession } from "../../src/hooks/runtime-session";
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

  it("leaves the native session pointer for the history bridge on boot and on end, fail-open", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-hook-session-"));
    roots.push(root);
    const context = join(root, "context.md");
    await writeFile(context, "identity\n");
    const file = join(root, "context", "runtime-session.json");
    // SessionStart: ghi lần đầu — Claude Code đưa `session_id` + `transcript_path` ngay từ đây.
    const boot = deps(
      { ALP_SESSION_CONTEXT: context, ALP_RUNTIME_SESSION: file },
      Buffer.from(JSON.stringify({ session_id: "sess-1", transcript_path: "/state/projects/x/sess-1.jsonl", source: "startup" })),
    );
    expect(await runHookCommand(["session-boot"], boot.dependencies)).toBe(0);
    expect(await readRuntimeSession(file)).toEqual({ v: 1, sessionId: "sess-1", transcriptPath: "/state/projects/x/sess-1.jsonl", recordedAt: "2026-09-08T00:00:00.000Z" });
    // Stop: ghi đè bằng payload mới nhất (Codex mới có transcript_path chắc chắn ở đây).
    const end = deps(
      { ALP_DELEGATION_EXECUTION_ID: "exec_hook", ALP_RUNTIME_SESSION: file },
      Buffer.from(JSON.stringify({ session_id: "sess-1", transcript_path: "/state/sessions/rollout-sess-1.jsonl", last_assistant_message: "done" })),
    );
    expect(await runHookCommand(["session-end"], end.dependencies)).toBe(0);
    expect((await readRuntimeSession(file))?.transcriptPath).toBe("/state/sessions/rollout-sess-1.jsonl");
    // Payload không có transcript → giữ bản cũ; env không có ALP_RUNTIME_SESSION → không ghi gì, không lỗi.
    const bare = deps({ ALP_DELEGATION_EXECUTION_ID: "exec_hook", ALP_RUNTIME_SESSION: file }, Buffer.from("{}"));
    expect(await runHookCommand(["session-end"], bare.dependencies)).toBe(0);
    expect((await readRuntimeSession(file))?.transcriptPath).toBe("/state/sessions/rollout-sess-1.jsonl");
    const none = deps({ ALP_SESSION_CONTEXT: context }, Buffer.from('{"session_id":"s","transcript_path":"/t"}'));
    expect(await runHookCommand(["session-boot"], none.dependencies)).toBe(0);
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

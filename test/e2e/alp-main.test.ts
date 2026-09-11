import { modelForMode, type ModeId } from "../../src/agents/modes";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentRegistry } from "../../src/agents/registry";
import { runMainSession } from "../../src/cli/commands/run-main";
import type { BackendExecutionResult } from "../../src/backend/execution-backend";
import { cleanupEnvironments, createE2eEnvironment, type E2eEnvironment } from "./harness";

const MAIN_OUTPUT = "Completed — entrypoint located at index.ts:1.";

afterEach(cleanupEnvironments);

/**
 * Nấc là thứ duy nhất được chọn — runtime rơi ra từ model mà nấc ghim cho `main`. `ultra`
 * ghim Opus 5 (Claude Code) còn `puck` ghim Sol (Codex), nên hai nấc này là cách gọi cả hai
 * CLI mà không cần ai truyền runtime vào.
 */
async function runMain(
  environment: E2eEnvironment,
  mode: ModeId,
): Promise<BackendExecutionResult> {
  return runMainSession({ cwd: environment.project, mode }, {
    registry: agentRegistry,
    // An explicit --mode never prompts, so selection is deterministic here.
    selector: { select: async (input) => ({ ok: true, mode: input.requestedMode!, source: "explicit" }) },
    executionService: environment.executionService,
    graph: environment.graph,
    threads: environment.threads,
    adapters: environment.adapters,
    backend: environment.backend,
    executionId: () => `exec_main_${mode}`,
    interactive: false,
    // Project đã đăng ký là trần, không phải cấp phát: `main` không khai write root nào
    // nên phiên vẫn chạy read-only.
    workspaceModeFor: async () => "workspace-write",
  });
}

describe("e2e: alp main session", () => {
  it("gives both runtimes the same main identity and returns validated output", async () => {
    const environment = await createE2eEnvironment({ output: MAIN_OUTPUT });

    const claudeResult = await runMain(environment, "ultra");
    const codexResult = await runMain(environment, "puck");

    for (const result of [claudeResult, codexResult]) {
      expect(result).toMatchObject({ status: "completed", output: MAIN_OUTPUT });
    }

    const claude = await environment.capture("claude");
    const codex = await environment.capture("codex");
    const definition = agentRegistry.get("main");

    // Identity travels in the capsule, so it must be byte-identical across runtimes.
    for (const capture of [claude, codex]) {
      expect(capture.capsule).toMatchObject({
        role: "main",
        displayName: definition.displayName,
        activeWorkspace: environment.project,
        outputContract: { name: definition.output.name },
      });
      // The capsule narrows tools to the workflow's opening state, never the full grant.
      expect(capture.capsule.allowedTools.length).toBeGreaterThan(0);
      for (const tool of capture.capsule.allowedTools) {
        expect(definition.capabilities.tools).toContain(tool);
      }
      expect(capture.cwd).toBe(environment.project);
      expect(capture.sessionContext).toContain(definition.displayName);
    }
    expect(claude.capsule.instructions).toBe(codex.capsule.instructions);
    expect(claude.capsule.allowedTools).toEqual(codex.capsule.allowedTools);

    // Identity now reaches both runtimes the same way — `ALP_SESSION_CONTEXT`, read by the
    // SessionStart hook, which Claude Code and Codex alike turn into a developer-role
    // message ahead of turn 1. No per-runtime section, so the two files are byte-identical —
    // save for the Thread line: two bare `alp` launches are two Threads, by design.
    expect(claude.sessionContext).toContain(claude.capsule.instructions);
    const withoutThreadId = (context: string) => context.replace(/^Thread: thread_[0-9a-f]+/m, "Thread: <id>");
    expect(withoutThreadId(codex.sessionContext)).toBe(withoutThreadId(claude.sessionContext));
    expect(codex.sessionContext).not.toBe(claude.sessionContext);

    // The invariant this whole change exists for, proven end to end: a main session is
    // interactive, so no task is ever submitted and the runtime sits idle waiting for the
    // principal. The capsule still records what the execution was opened for — that is
    // audit metadata, and it must not reach the model as a turn.
    for (const capture of [claude, codex]) {
      expect(capture.task).toBeNull();
      expect(capture.argv.some((argument) => argument.includes("task.md"))).toBe(false);
      expect(capture.sessionContext).not.toContain(capture.capsule.task);
    }

    // Only launch syntax and the per-runtime model differ — và model là model của nấc đang
    // chạy, không phải model khai trong definition: dial sở hữu ghế `main`.
    expect(claude.argv).toContain(modelForMode(definition, "ultra"));
    expect(claude.argv).toContain("--settings");
    expect(codex.argv).toContain(modelForMode(definition, "puck"));
    expect(codex.argv.slice(0, 3)).toEqual(["--dangerously-bypass-hook-trust", "--enable", "hooks"]);
    expect(JSON.parse(claude.runtimeConfig).hooks).toHaveProperty("SessionStart");
    // Codex carries the same hook bridges as `-c` overrides rather than in its config file.
    expect(codex.argv.some((arg) => arg.startsWith("hooks.SessionStart="))).toBe(true);
    expect(codex.runtimeConfig).toContain(`model = "${modelForMode(definition, "puck")}"`);
  });

  it("writes no runtime identity config into the project and cleans temporary files", async () => {
    const environment = await createE2eEnvironment({ output: MAIN_OUTPUT });

    await runMain(environment, "ultra");

    expect(await readdir(environment.project)).toEqual(["index.ts"]);
    // Runtime artifacts live under the execution root and are removed once the child exits.
    expect(await readdir(environment.executionsRoot)).toEqual(["exec_main_ultra"]);
    expect(await readdir(join(environment.executionsRoot, "exec_main_ultra", "runtime"))).toEqual([]);
  });

  /**
   * Phiên root là node đầu tiên của một cây, và cây là thứ sống lâu hơn process này: một lệnh
   * huỷ hay một `alp delegation tree` ở process khác chỉ đọc được nó nếu nó nằm trên đĩa. Còn
   * capability thì đi vào env của con và dừng ở đó — nó là secret, và graph thì ai cũng đọc.
   */
  it("writes the root into a durable tree and keeps its capability out of it", async () => {
    const environment = await createE2eEnvironment({ output: MAIN_OUTPUT });

    await runMain(environment, "ultra");

    // `by-execution/` là index tra ngược của store; một cây thì đúng một document.
    expect(await readdir(environment.graphsRoot)).toEqual(["by-execution", "exec_main_ultra.json"]);
    const document = await readFile(join(environment.graphsRoot, "exec_main_ultra.json"), "utf8");
    const graph = JSON.parse(document) as {
      rootExecutionId: string;
      deadlineAt: string;
      nodes: { executionId: string; status: string; depth: number; capabilityHash: string }[];
    };
    expect(graph.rootExecutionId).toBe("exec_main_ultra");
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]).toMatchObject({
      executionId: "exec_main_ultra",
      status: "completed",
      depth: 0,
    });

    // Con nhận được chỗ đứng của nó qua env, và cùng một deadline tuyệt đối mà cây ghi.
    const claude = await environment.capture("claude");
    expect(claude.env.ALP_EXECUTION_GRAPH_ID).toBe("exec_main_ultra");
    expect(claude.env.ALP_DELEGATION_EXECUTION_ID).toBe("exec_main_ultra");
    expect(claude.env.ALP_EXECUTION_DEADLINE_AT).toBe(graph.deadlineAt);
    expect(claude.env.ALP_EXECUTION_CAPABILITY).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(document).not.toContain(claude.env.ALP_EXECUTION_CAPABILITY);
  });

  it("reports a failing runtime as a failed session without inventing output", async () => {
    const environment = await createE2eEnvironment({ exitCode: 3 });

    await expect(runMain(environment, "puck")).resolves.toMatchObject({ status: "failed", exitCode: 3 });
    await expect(environment.capture("codex")).resolves.toMatchObject({ capsule: { role: "main" } });
  });
});

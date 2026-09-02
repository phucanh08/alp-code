import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentRegistry } from "../../src/agents/registry";
import type { RuntimeId } from "../../src/agents/types";
import { runMainSession } from "../../src/cli/commands/run-main";
import type { BackendExecutionResult } from "../../src/backend/execution-backend";
import { cleanupEnvironments, createE2eEnvironment, type E2eEnvironment } from "./harness";

const MAIN_OUTPUT = "Completed — entrypoint located at index.ts:1.";

afterEach(cleanupEnvironments);

async function runMain(
  environment: E2eEnvironment,
  requestedRuntime: RuntimeId,
): Promise<BackendExecutionResult> {
  return runMainSession({ cwd: environment.project, requestedRuntime }, {
    registry: agentRegistry,
    // An explicit --runtime never prompts, so selection is deterministic here.
    selector: { select: async (input) => ({ ok: true, runtime: input.requestedRuntime!, source: "explicit" }) },
    executionService: environment.executionService,
    adapters: environment.adapters,
    backend: environment.backend,
    executionId: () => `exec_main_${requestedRuntime}`,
    interactive: false,
    workspaceModeFor: async () => "workspace-write",
  });
}

describe("e2e: alp main session", () => {
  it("gives both runtimes the same main identity and returns validated output", async () => {
    const environment = await createE2eEnvironment({ output: MAIN_OUTPUT });

    const claudeResult = await runMain(environment, "claude");
    const codexResult = await runMain(environment, "codex");

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
      expect(capture.prompt).toContain(definition.displayName);
    }
    expect(claude.capsule.instructions).toBe(codex.capsule.instructions);
    expect(claude.capsule.allowedTools).toEqual(codex.capsule.allowedTools);

    // The identity is the same; only its delivery differs. Claude Code applies the
    // SessionStart hook's context before turn 1, so repeating it in the prompt would pay
    // for it twice; Codex rejects that hook, so its prompt has to carry the identity.
    // Strip that one section and the two prompts are identical again.
    expect(claude.prompt).not.toContain(claude.capsule.instructions);
    expect(codex.prompt).toContain(codex.capsule.instructions);
    const withoutIdentity = codex.prompt.replace(`## Identity\n\n${codex.capsule.instructions}\n\n`, "");
    expect(withoutIdentity.replace(codex.capsule.executionId, ""))
      .toBe(claude.prompt.replace(claude.capsule.executionId, ""));

    // Only launch syntax and the per-runtime model differ.
    expect(claude.argv).toContain(definition.model.claude);
    expect(claude.argv).toContain("--settings");
    expect(codex.argv).toContain(definition.model.codex);
    expect(codex.argv.slice(0, 3)).toEqual(["--dangerously-bypass-hook-trust", "--enable", "hooks"]);
    expect(JSON.parse(claude.runtimeConfig).hooks).toHaveProperty("SessionStart");
    // Codex carries the same hook bridges as `-c` overrides rather than in its config file.
    expect(codex.argv.some((arg) => arg.startsWith("hooks.SessionStart="))).toBe(true);
    expect(codex.runtimeConfig).toContain(`model = "${definition.model.codex}"`);
  });

  it("writes no runtime identity config into the project and cleans temporary files", async () => {
    const environment = await createE2eEnvironment({ output: MAIN_OUTPUT });

    await runMain(environment, "claude");

    expect(await readdir(environment.project)).toEqual(["index.ts"]);
    // Runtime artifacts live under the execution root and are removed once the child exits.
    expect(await readdir(environment.executionsRoot)).toEqual(["exec_main_claude"]);
    expect(await readdir(join(environment.executionsRoot, "exec_main_claude", "runtime"))).toEqual([]);
  });

  it("reports a failing runtime as a failed session without inventing output", async () => {
    const environment = await createE2eEnvironment({ exitCode: 3 });

    await expect(runMain(environment, "codex")).resolves.toMatchObject({ status: "failed", exitCode: 3 });
    await expect(environment.capture("codex")).resolves.toMatchObject({ capsule: { role: "main" } });
  });
});

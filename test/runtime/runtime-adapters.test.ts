import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeRuntimeAdapter } from "../../src/runtime/claude-adapter";
import { CodexRuntimeAdapter } from "../../src/runtime/codex-adapter";
import type { PreparedExecution } from "../../src/execution/types";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; project: string; prepared: PreparedExecution }> {
  const root = await mkdtemp(join(tmpdir(), "alp-runtime-adapter-"));
  roots.push(root);
  const project = join(root, "project");
  const directory = join(root, "executions", "exec-runtime");
  const runtimeDirectory = join(directory, "runtime");
  await mkdir(project, { recursive: true });
  await mkdir(runtimeDirectory, { recursive: true });
  const prepared = {
    capsule: {
      executionId: "exec-runtime",
      definitionHash: "definition-hash",
      policyHash: "policy-hash",
      role: "search",
      displayName: "Search",
      instructions: "Search only the active workspace.",
      task: "find the launcher",
      activeWorkspace: project,
      memoryContext: {
        invariantContext: "invariants",
        policyContext: "policy",
        entries: [],
        diagnostics: { characterBudget: 0, charactersUsed: 0, truncated: false, omittedEntryIds: [] },
      },
      workflowState: { workflowId: "search", currentState: "SEARCH", status: "running", repairAttempts: 0 },
      allowedTools: ["Read", "Grep"],
      outputContract: { name: "search-result", schema: { type: "object" } },
    },
    policy: {
      executionId: "exec-runtime",
      role: "search",
      workspace: project,
      workspaceMode: "read-only",
      allowedTools: ["Read", "Grep"],
      memory: { read: ["shared"], write: [] },
      delegatesTo: [],
      createdAt: "2026-08-26T00:00:00.000Z",
      definitionHash: "definition-hash",
      policyHash: "policy-hash",
    },
    state: {
      executionId: "exec-runtime",
      status: "prepared",
      workflow: { workflowId: "search", currentState: "SEARCH", status: "running", repairAttempts: 0 },
      policyHash: "policy-hash",
      createdAt: "2026-08-26T00:00:00.000Z",
    },
    artifacts: {
      directory,
      stateFile: join(directory, "state.json"),
      policyFile: join(directory, "policy.json"),
      runtimeDirectory,
    },
  } satisfies PreparedExecution;
  return { root, project, prepared };
}

describe("runtime adapters", () => {
  it("prepares a Claude launch spec without writing runtime config into the project", async () => {
    const { root, project, prepared } = await fixture();
    const adapter = new ClaudeRuntimeAdapter({ platform: "linux", env: { HOME: root, ALP_REPO_ROOT: root } });

    const launch = await adapter.prepare({
      execution: prepared,
      model: "claude-test",
      reasoningEffort: "high",
      interactive: true,
    });

    expect(launch.command).toBe("claude");
    expect(launch.cwd).toBe(project);
    expect(launch.args).toContain("--settings");
    expect(launch.args).toContain("--permission-mode");
    expect(launch.args).toContain("plan");
    expect(launch.args).toContain("claude-test");
    expect(launch.args.at(-1)).toMatch(/^ALP execution input is in .+prompt\.md; read it before continuing\.$/);
    expect(launch.args.at(-1)).not.toContain("\n");
    expect(launch.env).toMatchObject({
      ALP_ROLE: "search",
      ALP_DELEGATION_EXECUTION_ID: "exec-runtime",
      ALP_DELEGATION_WORKSPACE: project,
      ALP_EXECUTION_ROOT: join(root, "executions"),
      ALP_READONLY_DIRS: project,
    });
    expect(launch.env.ALP_SKILL_ROOTS?.split(delimiter)).toEqual(expect.arrayContaining([
      join(root, "skills"),
      join(root, ".agents", "skills"),
      join(root, ".codex", "skills"),
      join(root, ".claude", "skills"),
    ]));
    expect(launch.temporaryFiles).toHaveLength(4);
    expect(await readdir(project)).toEqual([]);
    expect(JSON.parse(await readFile(launch.temporaryFiles[0], "utf8"))).toMatchObject({
      executionId: "exec-runtime",
      role: "search",
    });
    const settings = JSON.parse(await readFile(launch.temporaryFiles[2], "utf8"));
    expect(JSON.parse(await readFile(launch.temporaryFiles[3], "utf8"))).toContain(join(root, ".agents", "skills"));
    expect(settings.hooks).toMatchObject({
      PreToolUse: [{ hooks: [{ type: "command", command: expect.stringMatching(/hooks\/acl-guard\.cjs"?$/) }] }],
      Stop: [{ hooks: [{ type: "command", command: expect.stringMatching(/hooks\/session-end\.cjs"?$/) }] }],
    });
    expect(settings.hooks).not.toHaveProperty("SessionStart");
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain(process.execPath);
    expect(settings.sandbox).toEqual({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyWrite: [project] },
    });
  });

  it("prepares a Codex launch spec from the same capsule and pins sandbox/cwd", async () => {
    const { root, project, prepared } = await fixture();
    const adapter = new CodexRuntimeAdapter({ platform: "win32", env: { HOME: root, ALP_REPO_ROOT: root } });

    const launch = await adapter.prepare({
      execution: prepared,
      model: "gpt-test",
      reasoningEffort: "xhigh",
      interactive: false,
    });

    expect(launch.args).toContain("--dangerously-bypass-hook-trust");
    expect(launch.args).toContain("--enable");
    expect(launch.args).toContain("hooks");
    expect(launch.args.some((arg) => arg.startsWith("hooks.PreToolUse="))).toBe(true);
    expect(launch.args.some((arg) => arg.startsWith("hooks.Stop="))).toBe(true);

    expect(launch.command).toBe("codex.cmd");
    expect(launch.args.slice(0, 2)).toEqual(["exec", "--skip-git-repo-check"]);
    expect(launch.args).toContain("-C");
    expect(launch.args).toContain(project);
    expect(launch.args).toContain("read-only");
    expect(launch.args).toContain("gpt-test");
    expect(launch.args).toContain('model_reasoning_effort="xhigh"');
    expect(launch.args.at(-1)).toMatch(/^ALP execution input is in .+prompt\.md; read it before continuing\.$/);
    expect(launch.env.ALP_IDENTITY_CAPSULE).toBe(launch.temporaryFiles[0]);
    expect(launch.env.ALP_EXECUTION_ROOT).toBe(join(root, "executions"));
    expect(launch.env.ALP_SKILL_ROOTS?.split(delimiter)).toContain(join(root, "skills"));
    expect(JSON.parse(await readFile(launch.temporaryFiles[3], "utf8"))).toContain(join(root, ".codex", "skills"));
    expect(await readdir(project)).toEqual([]);
  });
});

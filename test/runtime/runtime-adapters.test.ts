import { mkdtemp, mkdir, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeRuntimeAdapter } from "../../src/runtime/claude-adapter";
import { CodexRuntimeAdapter } from "../../src/runtime/codex-adapter";
import { absoluteRule } from "../../src/runtime/permission-rules";
import type { PreparedExecution } from "../../src/execution/types";
import type { RuntimeLaunchSpec } from "../../src/runtime/runtime-adapter";
import { removeTemporary } from "../support/temporary-root";

const roots: string[] = [];

/**
 * Looks a runtime artifact up by name rather than by position. The set is not fixed — an
 * interactive launch writes no `task.md` — so an index would quietly point at a different
 * file depending on the mode under test.
 */
function runtimeFile(launch: RuntimeLaunchSpec, name: string): string {
  const file = launch.temporaryFiles.find((path) => basename(path) === name);
  if (file === undefined) {
    throw new Error(`no runtime file named ${name} in ${launch.temporaryFiles.join(", ")}`);
  }
  return file;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTemporary(root)));
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
      // A read-only role only ever reaches a runtime through `alp delegate`, which pins
      // interactive to false. Interactive is the `main` session, and it takes the bypass
      // branch covered below.
      interactive: false,
    });

    expect(launch.command).toBe("claude");
    expect(launch.cwd).toBe(project);
    expect(launch.args).toContain("--settings");
    expect(launch.args).toContain("--permission-mode");
    expect(launch.args).toContain("plan");
    expect(launch.args).toContain("claude-test");
    expect(launch.args.at(-1)).toMatch(/^ALP task is in .+task\.md; execute it\.$/);
    expect(launch.args.at(-1)).not.toContain("\n");
    expect(launch.env).toMatchObject({
      ALP_ROLE: "search",
      ALP_DELEGATION_EXECUTION_ID: "exec-runtime",
      ALP_DELEGATION_WORKSPACE: project,
      ALP_EXECUTION_ROOT: join(root, "executions"),
      ALP_READONLY_DIRS: project,
      ALP_SESSION_CONTEXT: runtimeFile(launch, "session-context.md"),
    });
    expect(launch.env.ALP_SKILL_ROOTS?.split(delimiter)).toEqual(expect.arrayContaining([
      join(root, "skills"),
      join(root, ".agents", "skills"),
      join(root, ".codex", "skills"),
      join(root, ".claude", "skills"),
    ]));
    expect(launch.temporaryFiles).toHaveLength(5);
    expect(await readdir(project)).toEqual([]);
    expect(JSON.parse(await readFile(runtimeFile(launch, "identity-capsule.json"), "utf8"))).toMatchObject({
      executionId: "exec-runtime",
      role: "search",
    });
    const settings = JSON.parse(await readFile(runtimeFile(launch, "claude-settings.json"), "utf8"));
    expect(JSON.parse(await readFile(runtimeFile(launch, "skill-roots.json"), "utf8"))).toContain(join(root, ".agents", "skills"));
    expect(settings.hooks).toMatchObject({
      // `[\\/]` because the command carries native separators — a `/`-only pattern
      // silently never matches on Windows.
      SessionStart: [{ hooks: [{ type: "command", command: expect.stringMatching(/hooks[\\/]session-boot\.cjs"?$/) }] }],
      Stop: [{ hooks: [{ type: "command", command: expect.stringMatching(/hooks[\\/]session-end\.cjs"?$/) }] }],
    });
    // Per-tool interception is gone: the ACL is declared up front instead.
    expect(settings.hooks).not.toHaveProperty("PreToolUse");
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain(process.execPath);
    expect(settings.permissions.additionalDirectories).toContain(project);
    expect(settings.permissions.deny).toContain(
      absoluteRule("Read", join(root, "memory", "private", "main")),
    );
    // The format itself, pinned once: two leading slashes and no more, whatever the
    // platform's absolute paths look like.
    expect(absoluteRule("Read", "/home/a/memory")).toBe("Read(//home/a/memory/**)");
    expect(absoluteRule("Read", "C:\\Users\\a\\memory")).toBe("Read(//C:/Users/a/memory/**)");
    expect(settings.sandbox).toEqual({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyWrite: [project] },
    });
  });

  it("bypasses permission prompts only for the interactive session, on both runtimes", async () => {
    const { root, prepared } = await fixture();
    const options = { execution: prepared, model: "m", reasoningEffort: "high" } as const;
    const env = { HOME: root, ALP_REPO_ROOT: root };

    const claude = new ClaudeRuntimeAdapter({ platform: "linux", env });
    const claudeLive = await claude.prepare({ ...options, interactive: true });
    const claudeDelegated = await claude.prepare({ ...options, interactive: false });

    expect(claudeLive.args).toContain("--dangerously-skip-permissions");
    // The two are mutually exclusive: skipping permissions makes plan mode meaningless.
    expect(claudeLive.args).not.toContain("--permission-mode");
    expect(claudeDelegated.args).not.toContain("--dangerously-skip-permissions");
    expect(claudeDelegated.args).toContain("--permission-mode");

    const codex = new CodexRuntimeAdapter({ platform: "linux", env });
    const codexLive = await codex.prepare({ ...options, interactive: true });
    const codexDelegated = await codex.prepare({ ...options, interactive: false });

    expect(codexLive.args).toContain("--dangerously-bypass-approvals-and-sandbox");
    // `-s` is dropped rather than left alongside: Codex accepts both and silently lets the
    // bypass win, so keeping it would leave an argument that misstates the running mode.
    expect(codexLive.args).not.toContain("-s");
    expect(codexDelegated.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(codexDelegated.args).toContain("-s");
  });

  it("still denies a delegated role its siblings' private memory when main runs unrestricted", async () => {
    const { root, prepared } = await fixture();
    const env = { HOME: root, ALP_REPO_ROOT: root };
    const adapter = new ClaudeRuntimeAdapter({ platform: "linux", env });

    // The bypass is per-launch, not a global switch: the settings file a delegated role gets
    // still carries the deny list, whatever the interactive session was allowed to skip.
    await adapter.prepare({ execution: prepared, model: "m", reasoningEffort: "high", interactive: true });
    const delegated = await adapter.prepare({
      execution: prepared, model: "m", reasoningEffort: "high", interactive: false,
    });
    const settings = JSON.parse(await readFile(runtimeFile(delegated, "claude-settings.json"), "utf8"));

    expect(settings.permissions.deny).toContain(
      absoluteRule("Read", join(root, "memory", "private", "main")),
    );
  });

  it("keeps a read-only role read-only on Windows by withdrawing the shell", async () => {
    const { root, project, prepared } = await fixture();
    // A grant that includes Bash — otherwise the tool is already denied for being outside
    // the policy and the assertion below would prove nothing.
    const withShell = {
      ...prepared,
      policy: { ...prepared.policy, allowedTools: ["Read", "Grep", "Bash"] },
    } satisfies PreparedExecution;
    const adapter = new ClaudeRuntimeAdapter({ platform: "win32", env: { HOME: root, ALP_REPO_ROOT: root } });

    const launch = await adapter.prepare({
      execution: withShell,
      model: "claude-test",
      reasoningEffort: "high",
      interactive: true,
    });
    const settings = JSON.parse(await readFile(runtimeFile(launch, "claude-settings.json"), "utf8"));

    // Claude Code does not activate its sandbox on Windows, and asking for one with
    // `failIfUnavailable` makes it refuse to start at all.
    expect(settings).not.toHaveProperty("sandbox");
    // The workspace guarantee survives the missing sandbox: with no Write/Edit grant, a
    // shell was the only way left to write, so the shell goes instead.
    expect(settings.permissions.deny).toContain("Bash");
    expect(settings.permissions.additionalDirectories).toContain(project);
  });

  it("quotes Codex hook commands for cmd.exe without disturbing Claude's", async () => {
    const { root, prepared } = await fixture();
    const env = { HOME: root, ALP_REPO_ROOT: root };
    const options = { execution: prepared, model: "m", reasoningEffort: "high", interactive: false } as const;

    const codexWindows = await new CodexRuntimeAdapter({ platform: "win32", env }).prepare(options);
    const codexPosix = await new CodexRuntimeAdapter({ platform: "linux", env }).prepare(options);
    const claudeWindows = await new ClaudeRuntimeAdapter({ platform: "win32", env }).prepare(options);

    const codexHook = (spec: RuntimeLaunchSpec, event: string): string =>
      spec.args.find((argument) => argument.startsWith(`hooks.${event}=`)) ?? "";

    // Codex runs hooks through a bare `cmd /C`, which strips the outer quote pair off a
    // command line carrying more than two quotes. Measured on Windows: without the extra
    // pair the shell tries to run `C:\Program` and exits 1, so the session gets no identity.
    for (const event of ["SessionStart", "Stop"]) {
      expect(codexHook(codexWindows, event)).toContain('command = "\\"\\"');
      expect(codexHook(codexPosix, event)).not.toContain('command = "\\"\\"');
    }

    // Claude Code spawns via `cmd /d /s /c "<command>"`, where `/s` already consumes one
    // outer pair. Adding a second here would break the form that works there today.
    const settings = JSON.parse(await readFile(runtimeFile(claudeWindows, "claude-settings.json"), "utf8"));
    for (const event of ["SessionStart", "Stop"]) {
      expect(settings.hooks[event][0].hooks[0].command).not.toMatch(/^""/);
    }
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
    expect(launch.args.some((arg) => arg.startsWith("hooks.SessionStart="))).toBe(true);
    expect(launch.args.some((arg) => arg.startsWith("hooks.PreToolUse="))).toBe(false);
    expect(launch.args.some((arg) => arg.startsWith("hooks.Stop="))).toBe(true);

    expect(launch.command).toBe("codex.cmd");
    expect(launch.args.slice(0, 2)).toEqual(["exec", "--skip-git-repo-check"]);
    expect(launch.args).toContain("-C");
    expect(launch.args).toContain(project);
    expect(launch.args).toContain("read-only");
    expect(launch.args).toContain("gpt-test");
    expect(launch.args).toContain('model_reasoning_effort="xhigh"');
    expect(launch.args.at(-1)).toMatch(/^ALP task is in .+task\.md; execute it\.$/);
    expect(launch.env.ALP_IDENTITY_CAPSULE).toBe(runtimeFile(launch, "identity-capsule.json"));
    expect(launch.env.ALP_EXECUTION_ROOT).toBe(join(root, "executions"));
    expect(launch.env.ALP_SKILL_ROOTS?.split(delimiter)).toContain(join(root, "skills"));
    expect(JSON.parse(await readFile(runtimeFile(launch, "skill-roots.json"), "utf8"))).toContain(join(root, ".codex", "skills"));
    expect(await readdir(project)).toEqual([]);
  });
});

/**
 * One contract, both runtimes, and every runtime added later. The rule it pins is the
 * reason this suite exists: launching a harness must not spend a turn. Identity arrives on
 * the session channel; only a headless run has a task to submit, and it submits it once.
 */
describe.each([
  ["claude", (env: NodeJS.ProcessEnv) => new ClaudeRuntimeAdapter({ platform: "linux", env })],
  ["codex", (env: NodeJS.ProcessEnv) => new CodexRuntimeAdapter({ platform: "linux", env })],
] as const)("%s adapter conformance", (_name, build) => {
  async function launch(interactive: boolean): Promise<{ spec: RuntimeLaunchSpec; capsuleTask: string }> {
    const { root, prepared } = await fixture();
    const spec = await build({ HOME: root, ALP_REPO_ROOT: root }).prepare({
      execution: prepared,
      model: "m",
      reasoningEffort: "high",
      interactive,
    });
    return { spec, capsuleTask: prepared.capsule.task };
  }

  it("injects session context on both execution modes", async () => {
    for (const interactive of [true, false]) {
      const { spec } = await launch(interactive);
      const file = runtimeFile(spec, "session-context.md");
      expect(spec.env.ALP_SESSION_CONTEXT).toBe(file);
      const context = await readFile(file, "utf8");
      expect(context).toContain("Search only the active workspace.");
      expect(context).toContain("invariants");
      expect(context).toContain("policy");
    }
  });

  it("submits no task and writes no task file when interactive", async () => {
    const { spec, capsuleTask } = await launch(true);

    expect(spec.temporaryFiles.map((file) => basename(file))).not.toContain("task.md");
    // Not just "no positional prompt": no argument anywhere carries the task, by value or
    // by reference. That is the invariant — zero model turns before the principal speaks.
    for (const argument of spec.args) {
      expect(argument).not.toContain(capsuleTask);
      expect(argument).not.toContain("task.md");
    }
  });

  it("submits the task exactly once when headless", async () => {
    const { spec } = await launch(false);
    const taskFile = runtimeFile(spec, "task.md");

    expect(await readFile(taskFile, "utf8")).toContain("find the launcher");
    expect(spec.args.filter((argument) => argument.includes(taskFile))).toHaveLength(1);
    expect(spec.args.at(-1)).toContain(taskFile);
  });

  it("keeps the task out of the session context and the identity out of the task", async () => {
    const { spec, capsuleTask } = await launch(false);
    const context = await readFile(runtimeFile(spec, "session-context.md"), "utf8");
    const task = await readFile(runtimeFile(spec, "task.md"), "utf8");

    expect(context).not.toContain(capsuleTask);
    expect(task).not.toContain("Search only the active workspace.");
  });
});

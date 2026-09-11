import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProjectAgents } from "../../src/agents/loader";
import type { ModeId } from "../../src/agents/modes";
import { agentRegistry } from "../../src/agents/registry";
import type { AgentDefinition } from "../../src/agents/types";
import { loadModeProfiles } from "../../src/cli/settings";
import { createExecutionPolicy } from "../../src/execution/execution-policy";
import { finalizeExecution, validateHookExecution } from "../../src/hooks/execution-bridge";
import { WorkflowRunner } from "../../src/workflow/workflow-runner";
import { agentProject, cleanupAgentProjects, VALID_AGENT_FILE } from "../support/agent-file";
import { removeTemporary } from "../support/temporary-root";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => removeTemporary(root))));
afterEach(cleanupAgentProjects);

async function fixture(
  role = "search",
  workspaceMode: "read-only" | "workspace-write" = "read-only",
  options: { readonly mode?: ModeId; readonly definition?: AgentDefinition<unknown>; readonly workspace?: string } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "alp-hooks-"));
  roots.push(root);
  const workspace = options.workspace ?? join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const executionId = "exec_hook_fixture";
  const directory = join(root, executionId);
  await mkdir(directory);
  const definition = options.definition ?? agentRegistry.get(role);
  const policy = createExecutionPolicy({
    executionId,
    thread: null,
    definition,
    workspace,
    workspaceMode,
    ...(options.mode ? { mode: options.mode } : {}),
    createdAt: "2026-08-26T00:00:00.000Z",
  });
  const runner = new WorkflowRunner();
  const workflow = runner.initialize(definition.workflow);
  const state = { executionId, status: "prepared", workflow, policyHash: policy.policyHash, createdAt: policy.createdAt };
  await writeFile(join(directory, "policy.json"), JSON.stringify(policy));
  await writeFile(join(directory, "state.json"), JSON.stringify(state));
  await chmod(directory, 0o700);
  return { root, workspace, executionId, directory, policy, state };
}

describe("compiled execution hook bridge", () => {
  /**
   * Both regressions the first live run found, and neither is reachable without a spawn:
   * tiers 1–3 stop before one, so the Stop hook never runs in them.
   *
   * The hook re-derives the policy to check nobody edited the snapshot, and that re-derivation
   * used to default the nấc to `medium`. Every execution launched on any other nấc therefore
   * failed the check, and the hook — which reports failure as a note — quietly left the run at
   * `prepared` with its output contract unenforced. That is all eight built-in roles, not only
   * custom ones.
   */
  it("finalizes an execution that ran on a non-default mode", async () => {
    const value = await fixture("search", "read-only", { mode: "high" });

    await expect(finalizeExecution({
      executionId: value.executionId,
      executionRoot: value.root,
      output: "Found it in src/index.ts:42.",
    })).resolves.toMatchObject({ ok: true, status: "completed" });
  });

  /**
   * Same gap as the `mode` regression above, one field over: the re-derivation used to assume
   * the built-in loadout, so any execution launched under a project `settings.json` override
   * (#16) failed the tamper check the same silent way.
   */
  it("finalizes an execution that ran under a project settings.json loadout override", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-hooks-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, ".alp"), { recursive: true });
    await writeFile(
      join(workspace, ".alp", "settings.json"),
      JSON.stringify({ modes: { medium: { search: { model: "gpt-5.6-sol", reasoningEffort: "high" } } } }),
    );
    const { profiles: modeProfiles } = await loadModeProfiles({ cwd: workspace });

    const executionId = "exec_hook_fixture";
    const directory = join(root, executionId);
    await mkdir(directory);
    const definition = agentRegistry.get("search");
    const policy = createExecutionPolicy({
      executionId,
      thread: null,
      definition,
      workspace,
      workspaceMode: "read-only",
      modeProfiles,
      createdAt: "2026-08-26T00:00:00.000Z",
    });
    expect(policy.model).toBe("gpt-5.6-sol");
    const runner = new WorkflowRunner();
    const state = { executionId, status: "prepared", workflow: runner.initialize(definition.workflow), policyHash: policy.policyHash, createdAt: policy.createdAt };
    await writeFile(join(directory, "policy.json"), JSON.stringify(policy));
    await writeFile(join(directory, "state.json"), JSON.stringify(state));
    await chmod(directory, 0o700);

    await expect(finalizeExecution({
      executionId,
      executionRoot: root,
      output: "Found it in src/index.ts:42.",
    })).resolves.toMatchObject({ ok: true, status: "completed" });
  });

  /**
   * And a custom agent's role exists only in its project, so resolving it against the shipped
   * registry threw before anything else could run.
   */
  it("finalizes a custom agent by resolving its definition from the project", async () => {
    const project = await agentProject({ migrator: VALID_AGENT_FILE });
    const [agent] = (await loadProjectAgents({ projectRoot: project })).loaded;
    const value = await fixture("migrator", "read-only", {
      definition: agent.definition,
      workspace: project,
    });

    await expect(finalizeExecution({
      executionId: value.executionId,
      executionRoot: value.root,
      output: "Migrated one module; `npm test` passed.",
    })).resolves.toMatchObject({ ok: true, status: "completed" });
    const state = JSON.parse(await readFile(join(value.directory, "state.json"), "utf8")) as { output?: string };
    expect(state.output).toContain("Migrated one module");
  });

  it("refuses to finalize when the definition no longer matches the hash it ran with", async () => {
    const project = await agentProject({ migrator: VALID_AGENT_FILE });
    const [agent] = (await loadProjectAgents({ projectRoot: project })).loaded;
    const value = await fixture("migrator", "read-only", {
      definition: agent.definition,
      workspace: project,
    });
    await writeFile(
      join(project, ".alp", "agents", "migrator", "agent.yaml"),
      VALID_AGENT_FILE.replace("Migrate one module per execution", "Delete whatever the caller names"),
      "utf8",
    );

    await expect(finalizeExecution({
      executionId: value.executionId,
      executionRoot: value.root,
      output: "done",
    })).rejects.toThrow(/no definition for `migrator` matching the hash/);
  });

  it("rejects a missing or unregistered execution", async () => {
    await expect(validateHookExecution({ executionId: "", executionRoot: "/missing" }))
      .rejects.toThrow(/execution ID/);
    await expect(validateHookExecution({ executionId: "exec_absent", executionRoot: "/missing" }))
      .rejects.toThrow();
  });

  it("resolves the role behind a valid execution", async () => {
    const value = await fixture("search");
    await expect(validateHookExecution({ executionId: value.executionId, executionRoot: value.root }))
      .resolves.toEqual({ executionId: value.executionId, role: "search" });
  });

  it("rejects state whose policy hash no longer matches its policy", async () => {
    const value = await fixture("search");
    await writeFile(
      join(value.directory, "state.json"),
      JSON.stringify({ ...value.state, policyHash: "tampered" }),
    );
    await expect(validateHookExecution({ executionId: value.executionId, executionRoot: value.root }))
      .rejects.toThrow(/policy hash/);
  });

  it("accepts a prose answer and persists it as the execution output", async () => {
    const value = await fixture("search");
    const result = await finalizeExecution({
      executionId: value.executionId,
      executionRoot: value.root,
      output: "Found the handler in src/index.ts:42; ran `npm test`, 12 passed.",
    });
    expect(result).toMatchObject({ ok: true, status: "completed" });
    expect(JSON.parse(await readFile(join(value.directory, "state.json"), "utf8"))).toMatchObject({
      status: "completed",
      workflow: { status: "completed", repairAttempts: 0 },
      output: "Found the handler in src/index.ts:42; ran `npm test`, 12 passed.",
    });
  });

  it("treats a missing answer, not an unstructured one, as the failure to repair", async () => {
    const value = await fixture("search");
    expect(await finalizeExecution({ executionId: value.executionId, executionRoot: value.root, output: undefined }))
      .toMatchObject({ ok: false, status: "repairing" });
    expect(await finalizeExecution({
      executionId: value.executionId,
      executionRoot: value.root,
      output: "Recovered: the handler lives in src/index.ts.",
    })).toMatchObject({ ok: true, status: "completed" });
  });

  it("returns a stable terminal failure after the repair budget is exhausted", async () => {
    const value = await fixture("search");
    expect(await finalizeExecution({ executionId: value.executionId, executionRoot: value.root, output: "" }))
      .toMatchObject({ ok: false, status: "repairing" });
    expect(await finalizeExecution({ executionId: value.executionId, executionRoot: value.root, output: "" }))
      .toMatchObject({ ok: false, status: "failed" });
    expect(await finalizeExecution({ executionId: value.executionId, executionRoot: value.root, output: "" }))
      .toMatchObject({ ok: false, status: "failed", issues: ["output repair budget exhausted"] });
  });
});

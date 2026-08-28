import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentRegistry } from "../../src/agents/registry";
import { createExecutionPolicy } from "../../src/execution/execution-policy";
import { finalizeExecution, validateHookExecution } from "../../src/hooks/execution-bridge";
import { WorkflowRunner } from "../../src/workflow/workflow-runner";
import { removeTemporary } from "../support/temporary-root";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => removeTemporary(root))));

async function fixture(role = "search", workspaceMode: "read-only" | "workspace-write" = "read-only") {
  const root = await mkdtemp(join(tmpdir(), "alp-hooks-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const executionId = "exec_hook_fixture";
  const directory = join(root, executionId);
  await mkdir(directory);
  const definition = agentRegistry.get(role);
  const policy = createExecutionPolicy({
    executionId,
    definition,
    workspace,
    workspaceMode,
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

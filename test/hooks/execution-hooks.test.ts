import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentRegistry } from "../../src/agents/registry";
import { createExecutionPolicy } from "../../src/execution/execution-policy";
import { finalizeExecution, authorizeHookTool, parseAssistantOutput } from "../../src/hooks/execution-bridge";
import { WorkflowRunner } from "../../src/workflow/workflow-runner";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

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
  let workflow = runner.initialize(definition.workflow);
  const state = { executionId, status: "prepared", workflow, policyHash: policy.policyHash, createdAt: policy.createdAt };
  await writeFile(join(directory, "policy.json"), JSON.stringify(policy));
  await writeFile(join(directory, "state.json"), JSON.stringify(state));
  await chmod(directory, 0o700);
  return { root, workspace, executionId, directory, policy, state };
}

describe("compiled execution hook bridges", () => {
  it("fails closed without valid registered execution state", async () => {
    await expect(authorizeHookTool({ executionId: "", executionRoot: "/missing", tool: "Read", input: {}, cwd: "/tmp" }))
      .resolves.toMatchObject({ allowed: false, code: "INVALID_EXECUTION" });
    await expect(authorizeHookTool({ executionId: "missing", executionRoot: "/missing", tool: "Read", input: {}, cwd: "/tmp" }))
      .resolves.toMatchObject({ allowed: false, code: "INVALID_EXECUTION" });
  });

  it("authorizes from the immutable policy snapshot and rejects tampering", async () => {
    const value = await fixture();
    await expect(authorizeHookTool({ executionId: value.executionId, executionRoot: value.root, tool: "Read", input: { file_path: join(value.workspace, "a.ts") }, cwd: value.workspace }))
      .resolves.toEqual({ allowed: true });
    await expect(authorizeHookTool({ executionId: value.executionId, executionRoot: value.root, tool: "Write", input: { file_path: join(value.workspace, "a.ts") }, cwd: value.workspace }))
      .resolves.toMatchObject({ allowed: false });

    await writeFile(join(value.directory, "policy.json"), JSON.stringify({ ...value.policy, role: "main" }));
    await expect(authorizeHookTool({ executionId: value.executionId, executionRoot: value.root, tool: "Read", input: {}, cwd: value.workspace }))
      .resolves.toMatchObject({ allowed: false, code: "INVALID_EXECUTION" });
  });

  it("advances a linear workflow to the first state that permits the requested tool", async () => {
    const value = await fixture("main", "workspace-write");
    await expect(authorizeHookTool({ executionId: value.executionId, executionRoot: value.root, tool: "Write", input: { file_path: join(value.workspace, "a.ts") }, cwd: value.workspace }))
      .resolves.toEqual({ allowed: true });
    expect(JSON.parse(await readFile(join(value.directory, "state.json"), "utf8"))).toMatchObject({
      status: "running",
      workflow: { currentState: "EXECUTE", status: "running" },
    });
  });

  it("maps Codex apply_patch to write policy and scopes every patch target", async () => {
    const value = await fixture("main", "workspace-write");
    await expect(authorizeHookTool({ executionId: value.executionId, executionRoot: value.root, tool: "apply_patch", input: { command: `*** Begin Patch\n*** Add File: ${join(value.workspace, "ok.ts")}\n+x\n*** End Patch` }, cwd: value.workspace }))
      .resolves.toEqual({ allowed: true });
    await expect(authorizeHookTool({ executionId: value.executionId, executionRoot: value.root, tool: "apply_patch", input: { command: "*** Begin Patch\n*** Add File: ../escape.ts\n+x\n*** End Patch" }, cwd: value.workspace }))
      .resolves.toMatchObject({ allowed: false });
  });

  it("scopes Bash path arguments to the active workspace", async () => {
    const value = await fixture("main", "workspace-write");
    await expect(authorizeHookTool({ executionId: value.executionId, executionRoot: value.root, tool: "Bash", input: { command: "rg needle ./src" }, cwd: value.workspace }))
      .resolves.toEqual({ allowed: true });
    await expect(authorizeHookTool({ executionId: value.executionId, executionRoot: value.root, tool: "Bash", input: { command: "./scripts/check.sh" }, cwd: value.workspace }))
      .resolves.toEqual({ allowed: true });
    await expect(authorizeHookTool({ executionId: value.executionId, executionRoot: value.root, tool: "Bash", input: { command: "../outside-script" }, cwd: value.workspace }))
      .resolves.toMatchObject({ allowed: false, code: "INVALID_EXECUTION" });
    await expect(authorizeHookTool({ executionId: value.executionId, executionRoot: value.root, tool: "Bash", input: { command: "<../outside-script" }, cwd: value.workspace }))
      .resolves.toMatchObject({ allowed: false, code: "INVALID_EXECUTION" });
    await expect(authorizeHookTool({ executionId: value.executionId, executionRoot: value.root, tool: "Bash", input: { command: "cat<../escape.txt" }, cwd: value.workspace }))
      .resolves.toMatchObject({ allowed: false, code: "INVALID_EXECUTION" });
    await expect(authorizeHookTool({ executionId: value.executionId, executionRoot: value.root, tool: "Bash", input: { command: "cat < ./input.txt" }, cwd: value.workspace }))
      .resolves.toEqual({ allowed: true });
    await expect(authorizeHookTool({ executionId: value.executionId, executionRoot: value.root, tool: "Bash", input: { command: "cat ../escape.txt" }, cwd: value.workspace }))
      .resolves.toMatchObject({ allowed: false, code: "INVALID_EXECUTION" });
    await expect(authorizeHookTool({ executionId: value.executionId, executionRoot: value.root, tool: "Bash", input: { command: 'cat "$ALP_EXECUTION_ROOT/other/state.json"' }, cwd: value.workspace }))
      .resolves.toMatchObject({ allowed: false, code: "INDIRECT_TOOL_REQUEST" });
    await expect(authorizeHookTool({ executionId: value.executionId, executionRoot: value.root, tool: "Bash", input: { command: "cat <(printf secret)" }, cwd: value.workspace }))
      .resolves.toMatchObject({ allowed: false, code: "INDIRECT_TOOL_REQUEST" });
  });

  it.each([
    "sed -i.bak 's/a/b/' src/index.ts",
    "printf x | tee src/index.ts",
    "dd if=/dev/zero of=src/index.ts count=1",
    "truncate -s 0 src/index.ts",
    "patch -p0 < changes.diff",
    "git checkout -- src/index.ts",
    "git restore src/index.ts",
    "git apply changes.diff",
    "perl -pi -e 's/a/b/' src/index.ts",
  ])("denies write-capable Bash in read-only executions: %s", async (command) => {
    const value = await fixture("search");
    await expect(authorizeHookTool({ executionId: value.executionId, executionRoot: value.root, tool: "Bash", input: { command }, cwd: value.workspace }))
      .resolves.toMatchObject({ allowed: false, code: "INVALID_EXECUTION" });
  });

  it.each([
    "grep needle install.sh",
    "sed -n '1,20p' src/index.ts",
    "git diff -- src/index.ts",
  ])("allows non-mutating Bash in read-only executions: %s", async (command) => {
    const value = await fixture("search");
    await expect(authorizeHookTool({ executionId: value.executionId, executionRoot: value.root, tool: "Bash", input: { command }, cwd: value.workspace }))
      .resolves.toEqual({ allowed: true });
  });

  it("allows read-only access to registered execution runtime artifacts", async () => {
    const value = await fixture("search");
    const runtime = join(value.directory, "runtime");
    const prompt = join(runtime, "prompt.md");
    await mkdir(runtime);
    await writeFile(prompt, "task");
    await expect(authorizeHookTool({ executionId: value.executionId, executionRoot: value.root, tool: "Read", input: { file_path: prompt }, cwd: value.workspace }))
      .resolves.toEqual({ allowed: true });
  });

  it("allows only declared read-only skill artifacts outside the workspace", async () => {
    const value = await fixture("review");
    const skillRoot = join(value.root, "trusted-skills");
    const skillFile = join(skillRoot, "using-superpowers", "SKILL.md");
    const unrelated = join(value.root, "unrelated", "secret.md");
    await mkdir(join(skillRoot, "using-superpowers"), { recursive: true });
    await mkdir(join(value.directory, "runtime"));
    await writeFile(skillFile, "instructions");
    await writeFile(join(value.directory, "runtime", "skill-roots.json"), JSON.stringify([skillRoot]));
    await expect(authorizeHookTool({
      executionId: value.executionId,
      executionRoot: value.root,
      tool: "Read",
      input: { file_path: skillFile },
      cwd: value.workspace,
    })).resolves.toEqual({ allowed: true });
    await expect(authorizeHookTool({
      executionId: value.executionId,
      executionRoot: value.root,
      tool: "Read",
      input: { file_path: unrelated },
      cwd: value.workspace,
    })).resolves.toMatchObject({ allowed: false, code: "INVALID_EXECUTION" });
  });

  it("supports installed skill symlinks without allowing logical path traversal", async () => {
    if (process.platform === "win32") return;
    const value = await fixture("review");
    const skillRoot = join(value.root, "trusted-skills");
    const installedRoot = join(value.root, "installed-superpowers");
    const skillFile = join(skillRoot, "superpowers", "using-superpowers", "SKILL.md");
    await mkdir(join(installedRoot, "using-superpowers"), { recursive: true });
    await mkdir(skillRoot);
    await symlink(installedRoot, join(skillRoot, "superpowers"), "dir");
    await writeFile(join(installedRoot, "using-superpowers", "SKILL.md"), "instructions");
    await mkdir(join(value.directory, "runtime"));
    await writeFile(join(value.directory, "runtime", "skill-roots.json"), JSON.stringify([skillRoot]));
    await expect(authorizeHookTool({
      executionId: value.executionId,
      executionRoot: value.root,
      tool: "Read",
      input: { file_path: skillFile },
      cwd: value.workspace,
    })).resolves.toEqual({ allowed: true });
    await expect(authorizeHookTool({
      executionId: value.executionId,
      executionRoot: value.root,
      tool: "Read",
      input: { file_path: join(skillRoot, "..", "unrelated", "secret.md") },
      cwd: value.workspace,
    })).resolves.toMatchObject({ allowed: false, code: "INVALID_EXECUTION" });
  });

  it("enforces private memory grants for direct file tools", async () => {
    const value = await fixture("main", "workspace-write");
    const privateSearch = join(value.workspace, "memory", "private", "search", "secret.md");
    const result = await authorizeHookTool({ executionId: value.executionId, executionRoot: value.root, memoryRoot: join(value.workspace, "memory"), tool: "Read", input: { file_path: privateSearch }, cwd: value.workspace });
    expect(result).toMatchObject({ allowed: false, code: "PRIVATE_MEMORY_DENIED" });
  });

  it("fails closed for memory metadata and enforces private directory ownership", async () => {
    const value = await fixture("search");
    const memoryRoot = join(value.workspace, "memory");
    await expect(authorizeHookTool({
      executionId: value.executionId,
      executionRoot: value.root,
      memoryRoot,
      tool: "Read",
      input: { file_path: join(memoryRoot, ".alp-memory-index.json") },
      cwd: value.workspace,
    })).resolves.toMatchObject({ allowed: false, code: "INVALID_EXECUTION" });
    await expect(authorizeHookTool({
      executionId: value.executionId,
      executionRoot: value.root,
      memoryRoot,
      tool: "Glob",
      input: { path: join(memoryRoot, "private", "main") },
      cwd: value.workspace,
    })).resolves.toMatchObject({ allowed: false, code: "PRIVATE_MEMORY_DENIED" });
    await expect(authorizeHookTool({
      executionId: value.executionId,
      executionRoot: value.root,
      memoryRoot,
      tool: "Glob",
      input: { path: join(memoryRoot, "private", "search") },
      cwd: value.workspace,
    })).resolves.toEqual({ allowed: true });
  });

  it("finalizes through WorkflowRunner and persists validation lifecycle", async () => {
    const value = await fixture("search");
    const invalid = await finalizeExecution({ executionId: value.executionId, executionRoot: value.root, output: {} });
    expect(invalid).toMatchObject({ ok: false, status: "repairing" });
    const repaired = await finalizeExecution({
      executionId: value.executionId,
      executionRoot: value.root,
      output: { status: "found", evidence: [{ path: "src/index.ts", line: 1, detail: "export" }], summary: "found" },
    });
    expect(repaired).toMatchObject({ ok: true, status: "completed" });
    expect(JSON.parse(await readFile(join(value.directory, "state.json"), "utf8"))).toMatchObject({
      status: "completed",
      workflow: { status: "completed", repairAttempts: 1 },
      output: { status: "found", summary: "found" },
    });
  });

  it("returns a stable terminal failure after the repair budget is exhausted", async () => {
    const value = await fixture("search");
    expect(await finalizeExecution({ executionId: value.executionId, executionRoot: value.root, output: {} }))
      .toMatchObject({ ok: false, status: "repairing" });
    expect(await finalizeExecution({ executionId: value.executionId, executionRoot: value.root, output: {} }))
      .toMatchObject({ ok: false, status: "failed" });
    expect(await finalizeExecution({ executionId: value.executionId, executionRoot: value.root, output: {} }))
      .toMatchObject({ ok: false, status: "failed", issues: ["output repair budget exhausted"] });
  });

  it("parses the real Stop last_assistant_message JSON shape", () => {
    expect(parseAssistantOutput('{"status":"completed"}')).toEqual({ status: "completed" });
    expect(parseAssistantOutput('```json\n{"status":"completed"}\n```')).toEqual({ status: "completed" });
    expect(() => parseAssistantOutput("not json")).toThrow(/valid JSON/);
  });
});

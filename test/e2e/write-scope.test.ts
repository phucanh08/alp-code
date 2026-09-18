import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentRegistry } from "../../src/agents/registry";
import type { ModeId } from "../../src/agents/modes";
import { DelegationService, InMemoryDelegationExecutionStore } from "../../src/delegation/delegation-service";
import { readWriteScope } from "../../src/execution/execution-policy";
import { executionArtifactPaths } from "../../src/execution/execution-store";
import { absoluteRule } from "../../src/runtime/permission-rules";
import { cleanupEnvironments, createE2eEnvironment, createMaterializedRoot, type E2eEnvironment } from "./harness";

afterEach(cleanupEnvironments);

/**
 * A root `main` in the project, delegating to `worker` with a write scope. `<project>` holds
 * `src/parser`, `src/lexer`, `docs`, `index.ts`; the executions root is beside the project,
 * never inside it.
 */
async function session(environment: E2eEnvironment, executionId: string, mode: ModeId) {
  const { project } = environment;
  await Promise.all([join(project, "src", "parser"), join(project, "src", "lexer"), join(project, "docs")]
    .map((directory) => mkdir(directory, { recursive: true })));
  await writeFile(join(project, "docs", "guide.md"), "# guide\n");
  const root = await createMaterializedRoot(environment, { agentId: "main", executionId: "exec_root_main" });
  const service = new DelegationService({
    registry: agentRegistry,
    policy: environment.policy,
    memory: environment.memory,
    executionService: environment.executionService,
    graph: environment.graph,
    binding: root.binding,
    executionsRoot: environment.executionsRoot,
    runtimeAdapters: environment.adapters,
    backend: environment.backend,
    executionStore: new InMemoryDelegationExecutionStore(),
    config: { mode },
    ids: { request: () => `req_${executionId}`, execution: () => executionId },
  });
  return { service, project };
}

function writableRoots(config: string): string[] {
  const line = config.split("\n").find((entry) => entry.startsWith("writable_roots = "));
  if (line === undefined) throw new Error(`no writable_roots in:\n${config}`);
  return JSON.parse(line.slice("writable_roots = ".length)) as string[];
}

/**
 * Oracle: P2 "Tiêu chí hoàn thành" — `policy.json` carries `writeScope`; `alp delegation
 * status` reports it; Codex's `writable_roots` is the scope plus private memory; Claude's
 * sandbox denies the siblings; the executions root is in no writable list; and a scope that
 * escapes the workspace is refused before any node, file or process exists.
 */
describe("e2e: delegating with a write scope", () => {
  it("confines a Codex worker to the scope and records it in the signed policy", async () => {
    const environment = await createE2eEnvironment({ output: "done" });
    const { service, project } = await session(environment, "exec_scoped_codex", "medium");
    const scope = join(project, "src", "parser");

    const spawned = await service.delegate({ targetRole: "worker", task: "Fix the parser", workspace: project, workspaceMode: "workspace-write", writeScope: ["src/parser"] });
    await expect(service.wait(spawned.executionId)).resolves.toMatchObject({ status: "completed", output: "done" });

    const policy = JSON.parse(await readFile(join(environment.executionsRoot, "exec_scoped_codex", "policy.json"), "utf8")) as Record<string, unknown>;
    expect(readWriteScope(policy)).toEqual([scope]);
    expect(await service.status("exec_scoped_codex")).toMatchObject({ writeScope: [scope] });

    const capture = await environment.capture("codex");
    expect(capture.runtimeConfig).toContain('sandbox_mode = "workspace-write"');
    const roots = writableRoots(capture.runtimeConfig);
    expect(roots).toEqual([scope, join(environment.memoryRoot, "private", "worker")]);
    for (const entry of roots) expect(environment.executionsRoot.startsWith(entry)).toBe(false);
    // What Codex actually reads is the profile on argv (the config file above is ALP's own
    // record): the scope and private memory are the write roots, the workspace is not, and
    // the only writable path under the executions root is this execution's relay directory.
    const profileArgument = capture.argv.find((argument) => argument.startsWith("permissions.alp.filesystem="));
    expect(profileArgument).toBeDefined();
    expect(capture.argv[capture.argv.indexOf(profileArgument!) - 1]).toBe("-c");
    expect(capture.argv).toContain('default_permissions="alp"');
    expect(capture.argv).not.toContain("-s");
    for (const entry of roots) expect(profileArgument).toContain(`${JSON.stringify(entry)}="write"`);
    expect(profileArgument).not.toContain(`${JSON.stringify(project)}="write"`);
    expect(profileArgument).toContain(`${JSON.stringify(executionArtifactPaths(environment.executionsRoot, spawned.executionId).relayDirectory)}="write"`);
    expect(profileArgument!.match(/"[^"]*"="write"/gu)!.filter((entry) => entry.includes(environment.executionsRoot))).toHaveLength(1);
  });

  it("confines a Claude worker by denying what stands beside the scope", async () => {
    const environment = await createE2eEnvironment({ output: "done" });
    const { service, project } = await session(environment, "exec_scoped_claude", "low");

    const spawned = await service.delegate({ targetRole: "worker", task: "Fix the parser", workspace: project, workspaceMode: "workspace-write", writeScope: ["src/parser"] });
    await expect(service.wait(spawned.executionId)).resolves.toMatchObject({ status: "completed", output: "done" });

    const settings = JSON.parse((await environment.capture("claude")).runtimeConfig) as { sandbox?: { filesystem: { denyWrite: string[]; allowWrite?: string[] } }; permissions: { allow: string[]; deny: string[] } };
    const siblings = [join(project, "docs"), join(project, "index.ts"), join(project, "src", "lexer")];
    for (const sibling of siblings) expect(settings.permissions.deny).toContain(absoluteRule("Edit", sibling));
    expect(settings.permissions.deny).not.toContain(absoluteRule("Edit", join(project, "src")));
    if (process.platform === "win32") {
      expect(settings).not.toHaveProperty("sandbox");
    } else {
      expect(settings.sandbox?.filesystem.denyWrite).toEqual(siblings);
      // The only opening: the execution's relay directory, never the execution directory
      // (`policy.json`, evidence) and never the scope.
      expect(settings.sandbox?.filesystem.allowWrite).toEqual([executionArtifactPaths(environment.executionsRoot, spawned.executionId).relayDirectory]);
    }
    expect(settings.permissions.allow.filter((rule) => rule.startsWith("Edit(") && rule.includes(environment.executionsRoot))).toEqual([]);
  });

  it("refuses a scope that escapes the workspace before anything exists", async () => {
    const environment = await createE2eEnvironment({ output: "done" });
    const { service, project } = await session(environment, "exec_escaped", "medium");
    await mkdir(join(environment.root, "elsewhere"));

    await expect(service.delegate({ targetRole: "worker", task: "Fix the parser", workspace: project, workspaceMode: "workspace-write", writeScope: ["../elsewhere"] }))
      .rejects.toThrowError(/WRITE_SCOPE_OUTSIDE_WORKSPACE/);
    await expect(service.status("exec_escaped")).rejects.toMatchObject({ code: "EXECUTION_NOT_FOUND" });
    expect(await readdir(environment.executionsRoot)).toEqual(["exec_root_main"]);
    await expect(environment.capture("codex")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

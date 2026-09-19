import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentRegistry } from "../../src/agents/registry";
import type { ModeId } from "../../src/agents/modes";
import { DelegationService, InMemoryDelegationExecutionStore } from "../../src/delegation/delegation-service";
import { readExcludeScope, readWriteScope } from "../../src/execution/execution-policy";
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
  // One id per delegate call: `executionId`, then `executionId_2`, `executionId_3`, …
  let calls = 0;
  const suffix = () => (calls === 1 ? "" : `_${calls}`);
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
    ids: { request: () => `req_${executionId}${suffix()}`, execution: () => { calls += 1; return `${executionId}${suffix()}`; } },
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

/**
 * Oracle: master plan 2b "Assignment có biên" — an exclusion is the complement of the scope:
 * Claude's sandbox denies it beside the siblings, the signed policy records it, and the child
 * reads objective / owned / excluded / verification as separate lines before the task; two
 * live `worker`s cannot own the same path, and the exclusion is what lets them stand side
 * by side in the same tree.
 */
describe("e2e: assignment with an exclusion", () => {
  it("denies the excluded subtree to a Claude worker and tells it the assignment", async () => {
    const environment = await createE2eEnvironment({ output: "done" });
    const { service, project } = await session(environment, "exec_excluded", "low");
    const excludedPath = join(project, "src", "parser");

    const spawned = await service.delegate({
      targetRole: "worker", task: "Rewrite the lexer", workspace: project, workspaceMode: "workspace-write",
      writeScope: ["src"], excludeScope: ["src/parser"], objective: "The lexer emits tokens", verification: "npx vitest run test/lexer",
    });
    await expect(service.wait(spawned.executionId)).resolves.toMatchObject({ status: "completed", output: "done" });

    const policy = JSON.parse(await readFile(join(environment.executionsRoot, "exec_excluded", "policy.json"), "utf8")) as Record<string, unknown>;
    expect(readWriteScope(policy)).toEqual([join(project, "src")]);
    expect(readExcludeScope(policy)).toEqual([excludedPath]);

    const capture = await environment.capture("claude");
    const settings = JSON.parse(capture.runtimeConfig) as { sandbox?: { filesystem: { denyWrite: string[] } }; permissions: { deny: string[] } };
    const denied = [join(project, "docs"), join(project, "index.ts"), excludedPath];
    for (const entry of denied) expect(settings.permissions.deny).toContain(absoluteRule("Edit", entry));
    expect(settings.permissions.deny).not.toContain(absoluteRule("Edit", join(project, "src", "lexer")));
    if (process.platform !== "win32") expect(settings.sandbox?.filesystem.denyWrite).toEqual(denied);
    // The task file wraps the task in the execution prompt; the assignment is its own block
    // right before the task.
    expect(capture.task).toContain([
      "Objective: The lexer emits tokens",
      `Owned paths (you may write): \`${join(project, "src")}\``,
      `Excluded paths (you may not write, another execution owns them): \`${excludedPath}\``,
      "Verification (how done is checked): npx vitest run test/lexer",
      "",
      "Rewrite the lexer",
    ].join("\n"));
  });

  it("refuses a second live worker on a path the first one owns, unless the first excluded it", async () => {
    const environment = await createE2eEnvironment({ output: "done", holdMs: 4_000, holdRoles: ["worker"] });
    const { service, project } = await session(environment, "exec_overlap", "low");
    const request = { targetRole: "worker", workspace: project, workspaceMode: "workspace-write" as const };

    const first = await service.delegate({ ...request, task: "Own src", writeScope: ["src"] });
    // Inside, equal, and containing: all overlap with a live `src`.
    for (const writeScope of [["src/parser"], ["src"], undefined]) {
      await expect(service.delegate({ ...request, task: "Also src", ...(writeScope === undefined ? {} : { writeScope }) }))
        .rejects.toMatchObject({ code: "WRITE_SCOPE_OVERLAP", message: expect.stringContaining(first.executionId) });
    }
    // Beside: fine.
    const beside = await service.delegate({ ...request, task: "Own docs", writeScope: ["docs"] });
    expect(beside.executionId).not.toBe(first.executionId);
    // Nothing was reserved for the refused ones.
    expect((await readdir(environment.executionsRoot)).sort()).toEqual(["exec_overlap", "exec_overlap_5", "exec_root_main"]);

    for (const executionId of [first.executionId, beside.executionId]) {
      await service.cancel(executionId);
      await service.wait(executionId).catch(() => undefined);
    }
    // Once `src` is no longer live, `src` minus `src/parser` and `src/parser` can stand side
    // by side — `src/lexer`, which the carved one still owns, cannot.
    const carved = await service.delegate({ ...request, task: "Own src but the parser", writeScope: ["src"], excludeScope: ["src/parser"] });
    await expect(service.delegate({ ...request, task: "Own the lexer", writeScope: ["src/lexer"] })).rejects.toMatchObject({ code: "WRITE_SCOPE_OVERLAP" });
    const parser = await service.delegate({ ...request, task: "Own the parser", writeScope: ["src/parser"] });
    expect(parser.executionId).not.toBe(carved.executionId);

    for (const executionId of [carved.executionId, parser.executionId]) await service.cancel(executionId).catch(() => undefined);
  }, 20_000);
});

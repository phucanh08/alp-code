import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentRegistry } from "../../src/agents/registry";
import { ProjectRegistryStore } from "../../src/cli/commands/init";
import { DelegationService, InMemoryDelegationExecutionStore } from "../../src/delegation/delegation-service";
import { FileSessionApprovals, readApprovals, type ApprovalRecordV1 } from "../../src/execution/approvals";
import { cleanupEnvironments, createE2eEnvironment, createMaterializedRoot, type E2eEnvironment } from "./harness";

afterEach(cleanupEnvironments);

/**
 * A root `main` standing in `<project>/api` of a registered project, delegating from there.
 * The composition is the one `alp delegate` builds: the parent's grant comes off its signed
 * snapshot, the project comes from the real registry, and no approval surface exists — a
 * child process has nobody at the keyboard who is the principal.
 */
async function session(environment: E2eEnvironment, executionId: string) {
  const api = join(environment.project, "api");
  const web = join(environment.project, "web");
  const elsewhere = join(environment.root, "elsewhere");
  await Promise.all([join(api, "src"), join(web, "nested"), elsewhere].map((directory) => mkdir(directory, { recursive: true })));
  const registry = new ProjectRegistryStore({ file: join(environment.root, "projects.json") });
  await registry.register({ path: environment.project });
  const root = await createMaterializedRoot(environment, { agentId: "main", executionId: "exec_root_main", workspace: api });
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
    config: { mode: "medium" },
    projectRootOf: (path) => registry.projectContaining(path),
    ids: { request: () => `req_${executionId}`, execution: () => executionId },
  });
  const approvals = new FileSessionApprovals(join(environment.executionsRoot, "exec_root_main", "context", "approvals.json"));
  return { service, api, web, elsewhere, approvals };
}

/**
 * Oracle: phase-1 spec — a `--workspace` outside the granted roots but inside the project is
 * a question, not a deny; outside the project it stays a deny. A question nobody can answer
 * fails closed (`APPROVAL_UNAVAILABLE`) before any node, file or process exists; a "yes" the
 * root already collected for the session answers it and rides in the child's hashed policy.
 */
describe("e2e: workspace approval from a delegating child", () => {
  it("fails closed with APPROVAL_UNAVAILABLE for a workspace inside the project but outside the grant", async () => {
    const environment = await createE2eEnvironment({ output: "found" });
    const { service, web } = await session(environment, "exec_asked");

    await expect(service.delegate({ targetRole: "search", task: "Find the entrypoint", workspace: web }))
      .rejects.toThrowError(/APPROVAL_UNAVAILABLE/);

    // Nothing was reserved, written or spawned: no node, no artifacts, no runtime capture.
    await expect(service.status("exec_asked")).rejects.toMatchObject({ code: "EXECUTION_NOT_FOUND" });
    expect(await readdir(environment.executionsRoot)).toEqual(["exec_root_main"]);
    await expect(environment.capture("codex")).rejects.toMatchObject({ code: "ENOENT" });
    const view = await service.tree("exec_root_main");
    expect(view.summary.total).toBe(1);
    expect(view.delegation.used).toBe(0);
  });

  it("denies a workspace outside the project outright, without asking", async () => {
    const environment = await createE2eEnvironment({ output: "found" });
    const { service, elsewhere } = await session(environment, "exec_outside");

    await expect(service.delegate({ targetRole: "search", task: "Find the entrypoint", workspace: elsewhere }))
      .rejects.toThrowError(/WORKSPACE_SCOPE_MISMATCH/);
    await expect(service.status("exec_outside")).rejects.toMatchObject({ code: "EXECUTION_NOT_FOUND" });
    await expect(environment.capture("codex")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("launches inside the grant without a question", async () => {
    const environment = await createE2eEnvironment({ output: "found" });
    const { service, api } = await session(environment, "exec_inside");

    const spawned = await service.delegate({ targetRole: "search", task: "Find the entrypoint", workspace: join(api, "src") });
    await expect(service.wait(spawned.executionId)).resolves.toMatchObject({ status: "completed", output: "found" });
    const policy = JSON.parse(await readFile(join(environment.executionsRoot, "exec_inside", "policy.json"), "utf8")) as Record<string, unknown>;
    expect(readApprovals(policy)).toEqual([]);
  });

  it("honours a session-scoped yes the root already collected, and the child carries the record", async () => {
    const environment = await createE2eEnvironment({ output: "found" });
    const { service, web, approvals } = await session(environment, "exec_approved");
    const record: ApprovalRecordV1 = {
      version: 1,
      rule: "workspace-outside-grant-inside-project",
      subject: web,
      scope: "session",
      decidedBy: "principal",
      decidedAt: "2026-09-12T10:00:00.000Z",
    };
    await approvals.record(record);

    const spawned = await service.delegate({ targetRole: "search", task: "Find the entrypoint", workspace: web });
    await expect(service.wait(spawned.executionId)).resolves.toMatchObject({ status: "completed", output: "found" });

    const capture = await environment.capture("codex");
    expect(capture.cwd).toBe(web);
    expect(capture.capsule.activeWorkspace).toBe(web);
    const policy = JSON.parse(await readFile(join(environment.executionsRoot, "exec_approved", "policy.json"), "utf8")) as Record<string, unknown>;
    expect(readApprovals(policy)).toEqual([record]);
    // The yes is keyed by subject: a sibling directory is a new question, still unanswerable here.
    await expect(service.delegate({ targetRole: "search", task: "Find the entrypoint", workspace: join(web, "nested") }))
      .rejects.toThrowError(/APPROVAL_UNAVAILABLE/);
  });
});

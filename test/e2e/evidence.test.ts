import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { agentRegistry } from "../../src/agents/registry";
import type { ExecutionTreeNode } from "../../src/execution/graph/execution-graph-service";
import { runDelegateCommand, runDelegationLifecycleCommand } from "../../src/cli/commands/delegate";
import { loadVerifyCommands } from "../../src/cli/settings";
import { DelegationService, InMemoryDelegationExecutionStore } from "../../src/delegation/delegation-service";
import { evidenceFile, type EvidenceItem, type ExecutionEvidenceV1 } from "../../src/execution/evidence";
import { ClaudeHistoryBridge } from "../../src/runtime/claude-history-bridge";
import { HistoryBridgeRegistry } from "../../src/thread/history-bridge";
import { trustedVerifyFile, trustVerify, verifyTrusted } from "../../src/trust";
import { cleanupEnvironments, createE2eEnvironment, createMaterializedRoot, type E2eEnvironment } from "./harness";

afterEach(cleanupEnvironments);

const run = promisify(execFile);

/**
 * A git project with a verify block, and a root `main` delegating from it. The fake
 * runtime writes `src/parser/new.ts` and leaves a Claude transcript naming that write, the
 * way the real runtime does; nothing here is a real agent.
 */
async function session(executionId: string, options: { verifyRun: string; extraEnv?: Record<string, string> }) {
  const environment = await createE2eEnvironment({
    output: "done",
    extraEnv: { ALP_E2E_WRITE_FILE: "src/parser/new.ts", ALP_E2E_TRANSCRIPT: "1", ...options.extraEnv },
  });
  const { project } = environment;
  await mkdir(join(project, "src", "parser"), { recursive: true });
  await mkdir(join(project, ".alp"), { recursive: true });
  await writeFile(join(project, ".alp", "settings.json"), JSON.stringify({ verify: { commands: [{ id: "test", run: options.verifyRun }] } }));
  await run("git", ["init", "-q"], { cwd: project });
  await run("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "add", "."], { cwd: project });
  await run("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "commit", "-q", "-m", "baseline"], { cwd: project });
  const env = { HOME: environment.root };
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
    config: { mode: "low" },
    ids: { request: () => `req_${executionId}`, execution: () => executionId },
    evidence: {
      history: new HistoryBridgeRegistry([new ClaudeHistoryBridge({ env })]),
      verifySettings: (workspace) => loadVerifyCommands(workspace, env),
      verifyTrusted: (candidate, digest) => verifyTrusted(candidate, digest, trustedVerifyFile(env)),
    },
  });
  return { environment, service, project, env };
}

const evidenceOf = async (environment: E2eEnvironment, executionId: string) =>
  JSON.parse(await readFile(evidenceFile(environment.executionsRoot, executionId), "utf8")) as ExecutionEvidenceV1;
const items = (evidence: ExecutionEvidenceV1, kind: EvidenceItem["kind"]) => evidence.items.filter((item) => item.kind === kind);
const flatten = (node: ExecutionTreeNode): ExecutionTreeNode[] => [node, ...node.children.flatMap(flatten)];

/**
 * Oracle: P3 "Tiêu chí hoàn thành" — `alp delegation wait` leaves `evidence.json` beside
 * `policy.json` naming the changed files from git *and* from the runtime's own transcript;
 * `status`/`tree` never collect; the Thread gets nothing; a required verify runs only once
 * the project's block is trusted, and the parent sees `unknown` until then, never a guess.
 */
describe("e2e: evidence after a delegated write", () => {
  it("collects git and transcript changes on wait, not on status, and never into the Thread", async () => {
    const { environment, service, project } = await session("exec_evidence", { verifyRun: "exit 0" });
    const threadsBefore = await readdir(environment.threadsRoot);
    const spawned = await service.delegate({
      targetRole: "worker", task: "Add a parser", workspace: project, workspaceMode: "workspace-write",
      writeScope: ["src/parser"], requiredEvidence: ["change", "verify:test"],
    });
    await service.status(spawned.executionId);
    await expect(stat(evidenceFile(environment.executionsRoot, spawned.executionId))).rejects.toMatchObject({ code: "ENOENT" });

    const waited = await service.wait(spawned.executionId);
    expect(waited).toMatchObject({ status: "completed", output: "done", evidence: { evaluation: "unknown", missing: [] } });
    const evidence = await evidenceOf(environment, spawned.executionId);
    expect(evidence.digest).toBe(waited.evidence?.digest);
    const written = join(project, "src", "parser", "new.ts");
    // The fake prints `9.9.9`, not the measured `2.1`: every observation is lowered to derived.
    const changes = items(evidence, "change") as Extract<EvidenceItem, { kind: "change" }>[];
    expect(changes.map((item) => [item.source, item.provenance, item.paths, item.outsideScope])).toEqual([
      ["git", "derived", [written], []],
      ["history-bridge", "derived", [written], []],
    ]);
    // GitHub #23: `wait --json` carries the same provenance and commit, so a coordinator can
    // tell "did nothing" from "committed" without a second call to `evidence`.
    expect(waited.evidence?.changes).toEqual([
      { source: "git", provenance: "derived", commit: null, pathCount: 1, outsideScopeCount: 0 },
      { source: "history-bridge", provenance: "derived", commit: null, pathCount: 1, outsideScopeCount: 0 },
    ]);
    expect(items(evidence, "tool-call")).toEqual([expect.objectContaining({ ref: expect.objectContaining({ name: "Write" }) })]);
    expect(items(evidence, "verify-skipped")).toEqual([expect.objectContaining({ commandId: "test", reason: "untrusted" })]);
    expect(items(evidence, "output")).toHaveLength(1);
    expect(items(evidence, "boundary")).toEqual([expect.objectContaining({ ref: expect.objectContaining({ outcome: "completed" }) })]);
    // The transcript delta lives under the child's own context — the Thread saw nothing.
    await expect(stat(join(environment.executionsRoot, spawned.executionId, "context", "history", "entries.json"))).resolves.toBeDefined();
    expect(await readdir(environment.threadsRoot)).toEqual(threadsBefore);
    // The node carries the digest and the verdict, so the parent's `tree` can show it.
    const tree = await service.tree(spawned.executionId);
    expect(flatten(tree.root).find((node) => node.executionId === spawned.executionId)).toMatchObject({ evidence: { digest: evidence.digest, evaluation: "unknown" } });
  }, 15_000);

  it("runs the verify once trusted — pass satisfies, fail does not — and the CLI shows it", async () => {
    const { environment, service, project, env } = await session("exec_verify_pass", { verifyRun: "exit 0" });
    const spawned = await service.delegate({ targetRole: "worker", task: "Add a parser", workspace: project, workspaceMode: "workspace-write", requiredEvidence: ["verify:test"] });
    await expect(service.wait(spawned.executionId)).resolves.toMatchObject({ evidence: { evaluation: "unknown" } });

    const settings = await loadVerifyCommands(project, env);
    await trustVerify({ project: settings.project, verifyDigest: settings.digest!, trustedAt: new Date().toISOString() }, trustedVerifyFile(env));
    await expect(service.evidence(spawned.executionId)).resolves.toMatchObject({ evaluation: "satisfied", missing: [] });
    const evidence = await evidenceOf(environment, spawned.executionId);
    expect(items(evidence, "verify")).toEqual([expect.objectContaining({ commandId: "test", exitCode: 0, provenance: "observed" })]);
    expect(items(evidence, "verify-skipped")).toEqual([]);

    // `alp delegation evidence <id> --json` is the same answer, for a script.
    await expect(runDelegationLifecycleCommand(["evidence", spawned.executionId, "--json"], service))
      .resolves.toMatchObject({ executionId: spawned.executionId, evaluation: "satisfied", digest: evidence.digest });
    const rendered = await runDelegationLifecycleCommand(["evidence", spawned.executionId], service) as { rendered: string };
    expect(rendered.rendered).toContain("satisfied");
    expect(rendered.rendered).toContain("verify:test");
  }, 15_000);

  it("marks a failing verify unsatisfied and names it", async () => {
    const { service, project, env } = await session("exec_verify_fail", { verifyRun: "exit 1" });
    const settings = await loadVerifyCommands(project, env);
    await trustVerify({ project: settings.project, verifyDigest: settings.digest!, trustedAt: new Date().toISOString() }, trustedVerifyFile(env));
    const spawned = await service.delegate({ targetRole: "worker", task: "Add a parser", workspace: project, workspaceMode: "workspace-write", requiredEvidence: ["verify:test"] });
    await expect(service.wait(spawned.executionId)).resolves.toMatchObject({ evidence: { evaluation: "unsatisfied", missing: ["verify:test"] } });
  }, 15_000);

  it("`alp delegate --require-evidence` reaches the request, and a bad name is refused before anything runs", async () => {
    const { environment, service, project } = await session("exec_cli_required", { verifyRun: "exit 0" });
    const result = await runDelegateCommand(
      ["worker", "--workspace", project, "--require-evidence", "change", "--require-evidence", "verify:test", "--", "Add", "a", "parser"],
      { cwd: project, env: { HOME: environment.root }, service },
    );
    expect(result).toMatchObject({ executionId: "exec_cli_required" });
    const node = flatten((await service.tree("exec_cli_required")).root).find((entry) => entry.executionId === "exec_cli_required");
    expect(node).toMatchObject({ requiredEvidence: ["change", "verify:test"] });
    await service.wait("exec_cli_required");

    await expect(service.delegate({ targetRole: "worker", task: "x", workspace: project, requiredEvidence: ["output"] }))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
  }, 15_000);
});

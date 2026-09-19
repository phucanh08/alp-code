import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { agentRegistry } from "../../src/agents/registry";
import { runDelegationLifecycleCommand } from "../../src/cli/commands/delegate";
import { loadVerifyCommands } from "../../src/cli/settings";
import { DelegationService, InMemoryDelegationExecutionStore } from "../../src/delegation/delegation-service";
import { acceptanceFile, type AcceptanceRecordV1 } from "../../src/execution/acceptance";
import { evidenceFile, type ExecutionEvidenceV1 } from "../../src/execution/evidence";
import type { ExecutionOutcome } from "../../src/execution/outcome";
import type { DelegationTreeNode } from "../../src/delegation/types";
import { ClaudeHistoryBridge } from "../../src/runtime/claude-history-bridge";
import { HistoryBridgeRegistry } from "../../src/thread/history-bridge";
import { REDACTED } from "../../src/thread/history-redact";
import { trustedVerifyFile, verifyTrusted } from "../../src/trust";
import { cleanupEnvironments, createE2eEnvironment, createMaterializedRoot, type E2eEnvironment } from "./harness";

afterEach(cleanupEnvironments);

const run = promisify(execFile);
const flatten = (node: DelegationTreeNode): DelegationTreeNode[] => [node, ...node.children.flatMap(flatten)];

/** Two roots in one environment: `main` and another `main`, each with its own binding. */
async function session(tag: string, outcome?: ExecutionOutcome) {
  const environment = await createE2eEnvironment({ output: "done", outcome, extraEnv: { ALP_E2E_WRITE_FILE: "src/parser/new.ts", ALP_E2E_TRANSCRIPT: "1" } });
  const { project } = environment;
  await mkdir(join(project, "src", "parser"), { recursive: true });
  await mkdir(join(project, ".alp"), { recursive: true });
  await writeFile(join(project, ".alp", "settings.json"), JSON.stringify({ verify: { commands: [{ id: "test", run: "exit 0" }] } }));
  await run("git", ["init", "-q"], { cwd: project });
  await run("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "add", "."], { cwd: project });
  await run("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "commit", "-q", "-m", "baseline"], { cwd: project });
  const env = { HOME: environment.root };
  let executions = 0;
  const serviceFor = async (executionId: string, binding: Awaited<ReturnType<typeof createMaterializedRoot>>["binding"]) =>
    new DelegationService({
      registry: agentRegistry,
      policy: environment.policy,
      memory: environment.memory,
      executionService: environment.executionService,
      graph: environment.graph,
      binding,
      executionsRoot: environment.executionsRoot,
      runtimeAdapters: environment.adapters,
      backend: environment.backend,
      executionStore: new InMemoryDelegationExecutionStore(),
      config: { mode: "low" },
      ids: { request: () => `req_${tag}_${executions}`, execution: () => `${executionId}_${++executions}` },
      evidence: {
        history: new HistoryBridgeRegistry([new ClaudeHistoryBridge({ env })]),
        verifySettings: (workspace) => loadVerifyCommands(workspace, env),
        verifyTrusted: (candidate, digest) => verifyTrusted(candidate, digest, trustedVerifyFile(env)),
      },
    });
  const root = await createMaterializedRoot(environment, { agentId: "main", executionId: `exec_root_${tag}` });
  const service = await serviceFor(`exec_${tag}`, root.binding);
  return { environment, project, root, service, serviceFor };
}

const readJson = async <T>(file: string) => JSON.parse(await readFile(file, "utf8")) as T;
const nodeOf = async (service: DelegationService, executionId: string) => flatten((await service.tree(executionId)).root).find((node) => node.executionId === executionId)!;

/**
 * Oracle: P4 "Tiêu chí hoàn thành" — a parent accepts a finished child on the evidence ALP
 * collected (collected first when missing), the verdict lands on the node and in a record
 * under the parent, and is taken once; a stranger's binding, a forged one, and a running
 * subject are all refused before anything is written.
 */
describe("e2e: acceptance closes the loop", () => {
  it("accept collects the evidence first, then records the verdict once, on node and disk", async () => {
    const outcome: ExecutionOutcome = { disposition: "done", reason: "parser added, tests green", evidenceRefs: ["src/parser/new.ts"] };
    const { environment, project, root, service } = await session("accept", outcome);
    const spawned = await service.delegate({ targetRole: "worker", task: "Add a parser for the config file", workspace: project, workspaceMode: "workspace-write", requiredEvidence: ["change"] });
    // Wait on the graph without collecting: `status` until terminal, so `accept` has to collect.
    await service.wait(spawned.executionId);
    const evidencePath = evidenceFile(environment.executionsRoot, spawned.executionId);
    const evidence = await readJson<ExecutionEvidenceV1>(evidencePath);

    const decided = await service.accept(spawned.requestId, { reasons: ["diff matches the ask", "token sk-ant-api03-abcdefghijklmnopqrstuvwxyz seen"] });
    expect(decided).toMatchObject({ requestId: spawned.requestId, executionId: spawned.executionId, decision: "accepted", evidenceDigest: evidence.digest, evaluation: "satisfied", disposition: "done" });
    expect(decided.reasons[1]).toContain(REDACTED);
    // The record keeps the disposition the parent saw at decision time (2a), next to the evidence digest.
    const record = await readJson<AcceptanceRecordV1>(acceptanceFile(environment.executionsRoot, root.binding.executionId, spawned.requestId));
    expect(record).toEqual({
      version: 1, requestId: spawned.requestId, subjectExecutionId: spawned.executionId, acceptedByExecutionId: root.binding.executionId,
      decision: "accepted", evidenceDigest: evidence.digest, disposition: "done", reasons: decided.reasons, decidedAt: decided.decidedAt,
    });
    expect(await nodeOf(service, spawned.executionId)).toMatchObject({
      taskExcerpt: "Add a parser for the config file",
      outcome,
      acceptance: { decision: "accepted", evidenceDigest: evidence.digest, decidedAt: decided.decidedAt },
    });
    // Once.
    await expect(service.reject(spawned.requestId, { reasons: ["changed my mind"] })).rejects.toMatchObject({ code: "ACCEPTANCE_ALREADY_DECIDED" });
    expect((await nodeOf(service, spawned.executionId)).acceptance?.decision).toBe("accepted");
    // The CLI renders the tree with the decision.
    const tree = await runDelegationLifecycleCommand(["tree", spawned.executionId], service) as { rendered: string };
    expect(tree.rendered).toContain(`worker  ·  ${spawned.executionId}  ·  completed  ·  req ${spawned.requestId}  ·  disposition done  ·  evidence satisfied  ·  decision accepted`);
  }, 15_000);

  it("accept on a child never waited collects evidence.json before it writes any record", async () => {
    const { environment, root, project, service } = await session("collect");
    const spawned = await service.delegate({ targetRole: "worker", task: "Add a parser", workspace: project, workspaceMode: "workspace-write" });
    // Poll only through `status`, which never collects.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const status = await service.status(spawned.executionId);
      if (status.status !== "running" && status.status !== "queued") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const evidencePath = evidenceFile(environment.executionsRoot, spawned.executionId);
    await expect(stat(evidencePath)).rejects.toMatchObject({ code: "ENOENT" });
    const decided = await service.accept(spawned.requestId, {});
    const evidence = await readJson<ExecutionEvidenceV1>(evidencePath);
    expect(decided.evidenceDigest).toBe(evidence.digest);
    const record = await readJson<AcceptanceRecordV1>(acceptanceFile(environment.executionsRoot, root.binding.executionId, spawned.requestId));
    expect(record.reasons).toEqual([]);
    // A child that declared nothing is recorded as `unknown` — the parent accepted without a word from it, and the record says so.
    expect(record.disposition).toBe("unknown");
    expect(decided.disposition).toBe("unknown");
  }, 15_000);

  it("refuses a running subject, a stranger, and a forged binding — and writes nothing", async () => {
    const { environment, root, project, service, serviceFor } = await session("refuse");
    const held = await createE2eEnvironment({ output: "done", holdMs: 1_500, holdRoles: ["worker"] });
    void held;
    const spawned = await service.delegate({ targetRole: "worker", task: "Add a parser", workspace: project, workspaceMode: "workspace-write" });
    // The stranger: another root in the same environment with its own binding.
    const other = await createMaterializedRoot(environment, { agentId: "main", executionId: "exec_root_other" });
    const stranger = await serviceFor("exec_stranger", other.binding);
    await expect(stranger.accept(spawned.requestId, {})).rejects.toMatchObject({ code: "EXECUTION_NOT_FOUND" });
    const forged = await serviceFor("exec_forged", { ...root.binding, capability: "0".repeat(root.binding.capability.length) });
    await expect(forged.accept(spawned.requestId, {})).rejects.toMatchObject({ code: "CAPABILITY_INVALID" });
    await service.wait(spawned.executionId);
    await expect(stranger.accept(spawned.requestId, {})).rejects.toMatchObject({ code: "EXECUTION_NOT_FOUND" });
    await expect(service.accept("req_nobody", {})).rejects.toMatchObject({ code: "EXECUTION_NOT_FOUND" });
    await expect(service.reject(spawned.requestId, { reasons: [] })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(stat(acceptanceFile(environment.executionsRoot, root.binding.executionId, spawned.requestId))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await nodeOf(service, spawned.executionId)).acceptance).toBeNull();
  }, 15_000);

  it("refuses to decide a subject that is still running", async () => {
    const environment = await createE2eEnvironment({ output: "done", holdMs: 3_000, holdRoles: ["worker"] });
    const { project } = environment;
    const root = await createMaterializedRoot(environment, { agentId: "main", executionId: "exec_root_running" });
    const env = { HOME: environment.root };
    const service = new DelegationService({
      registry: agentRegistry, policy: environment.policy, memory: environment.memory, executionService: environment.executionService,
      graph: environment.graph, binding: root.binding, executionsRoot: environment.executionsRoot, runtimeAdapters: environment.adapters,
      backend: environment.backend, executionStore: new InMemoryDelegationExecutionStore(), config: { mode: "low" },
      ids: { request: () => "req_running", execution: () => "exec_running_child" },
      evidence: {
        history: new HistoryBridgeRegistry([]),
        verifySettings: (workspace) => loadVerifyCommands(workspace, env),
        verifyTrusted: (candidate, digest) => verifyTrusted(candidate, digest, trustedVerifyFile(env)),
      },
    });
    const spawned = await service.delegate({ targetRole: "worker", task: "Add a parser", workspace: project, workspaceMode: "workspace-write" });
    await expect(service.accept(spawned.requestId, {})).rejects.toMatchObject({ code: "ACCEPTANCE_SUBJECT_RUNNING" });
    await service.cancel(spawned.executionId);
    await service.wait(spawned.executionId).catch(() => undefined);
    // A cancelled child can still be judged — it ended.
    await expect(service.reject(spawned.requestId, { reasons: ["cancelled by parent"] })).resolves.toMatchObject({ decision: "rejected" });
  }, 15_000);

  it("`alp delegation reject` needs a reason; `accept` prints the verdict", async () => {
    const { project, service } = await session("cli", { disposition: "blocked", reason: "needs a token", evidenceRefs: [] });
    const spawned = await service.delegate({ targetRole: "worker", task: "Add a parser", workspace: project, workspaceMode: "workspace-write" });
    await service.wait(spawned.executionId);
    await expect(runDelegationLifecycleCommand(["reject", spawned.requestId], service)).rejects.toThrow(/--reason/);
    await expect(runDelegationLifecycleCommand(["accept"], service)).rejects.toThrow(/request/i);
    const { rendered: verdict } = await runDelegationLifecycleCommand(["reject", spawned.requestId, "--reason", "not done"], service) as { rendered: string };
    // The verdict line carries what the child said it was (2a): a reader sees `rejected` and `blocked` together.
    expect(verdict).toContain(`rejected ${spawned.requestId}  ·  execution ${spawned.executionId}  ·  disposition blocked  ·  evidence`);
    await expect(runDelegationLifecycleCommand(["accept", spawned.requestId, "--reason", "looks right", "--json"], service)).rejects.toMatchObject({ code: "ACCEPTANCE_ALREADY_DECIDED" });
    const { rendered } = await runDelegationLifecycleCommand(["evidence", spawned.executionId], service) as { rendered: string };
    expect(rendered).toContain("rejected");
  }, 15_000);
});

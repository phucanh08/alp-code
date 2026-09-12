import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentRegistry } from "../../src/agents/registry";
import { runMainSession } from "../../src/cli/commands/run-main";
import { DelegationService, InMemoryDelegationExecutionStore } from "../../src/delegation/delegation-service";
import { readLaunchReceipt } from "../../src/runtime/launch-provenance";
import { cleanupEnvironments, createE2eEnvironment, type E2eEnvironment } from "./harness";

const FAKE_SECRET = "sk-ant-e2e-secret-3c9a1f";

afterEach(cleanupEnvironments);

/**
 * `context/launch.json` is the one record of *which binary actually ran* — version and
 * auth method at the moment of the spawn. `policy.json` cannot carry it: the policy is
 * frozen and hashed before the process exists, and the receipt is an event, not a decision.
 */
describe("e2e: launch receipt", () => {
  it("writes context/launch.json for a root session, from the runtime's own --version", async () => {
    const environment = await createE2eEnvironment({ output: "done", extraEnv: { ANTHROPIC_API_KEY: FAKE_SECRET } });
    await runMainSession({ cwd: environment.project, mode: "ultra" }, {
      registry: agentRegistry,
      selector: { select: async (input) => ({ ok: true, mode: input.requestedMode!, source: "explicit" }) },
      executionService: environment.executionService,
      graph: environment.graph,
      threads: environment.threads,
      adapters: environment.adapters,
      backend: environment.backend,
      executionId: () => "exec_main_receipt",
      interactive: false,
      workspaceModeFor: async () => "workspace-write",
    });

    const file = join(environment.executionsRoot, "exec_main_receipt", "context", "launch.json");
    const receipt = await readLaunchReceipt(file);
    expect(receipt).toMatchObject({
      version: 1,
      executionId: "exec_main_receipt",
      runtime: "claude",
      // The fake `claude` answers `--version` the way the real one does.
      runtimeVersion: "9.9.9",
      platform: process.platform,
      authMethod: "api-key",
      credentialConfigured: true,
    });
    expect(receipt?.launchSpecDigest).toMatch(/^[0-9a-f]{64}$/);
    // The secret reached the process (the fake records ALP_* only, so assert on the receipt
    // side): the receipt says `api-key` and never the key.
    expect(await readFile(file, "utf8")).not.toContain(FAKE_SECRET);
  });

  it("writes one for a delegated child too, and the digest names the child's own launch", async () => {
    const environment = await createE2eEnvironment({ output: "found" });
    const root = await environment.graph.createRoot({ agentId: "main", thread: null, executionId: "exec_root_main" });
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
      ids: { request: () => "req_receipt", execution: () => "exec_child_receipt" },
    });

    const spawned = await service.delegate({ targetRole: "search", task: "Find the entrypoint", workspace: environment.project });
    await service.wait(spawned.executionId);

    const receipt = await readLaunchReceipt(join(environment.executionsRoot, "exec_child_receipt", "context", "launch.json"));
    expect(receipt).toMatchObject({ version: 1, executionId: "exec_child_receipt", runtime: "codex", runtimeVersion: "9.9.9" });
    // No key in the environment and no stored login under the throwaway HOME.
    expect(receipt).toMatchObject({ authMethod: "unknown", credentialConfigured: false });
    expect(receipt?.launchSpecDigest).toMatch(/^[0-9a-f]{64}$/);
    // Sits in `context/`, which outlives the `runtime/` cleanup — not next to the launch files.
    await expect(readFile(join(environment.executionsRoot, "exec_child_receipt", "runtime", "launch.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);
});

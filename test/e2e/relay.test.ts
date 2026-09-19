import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentRegistry } from "../../src/agents/registry";
import { runMainSession } from "../../src/cli/commands/run-main";
import { DelegationService, InMemoryDelegationExecutionStore } from "../../src/delegation/delegation-service";
import { executionArtifactPaths } from "../../src/execution/execution-store";
import { RelayServer, type RelayExecuteInput } from "../../src/execution/relay-server";
import { cleanupEnvironments, createE2eEnvironment, createMaterializedRoot, type E2eEnvironment } from "./harness";

afterEach(cleanupEnvironments);

/**
 * Từ trong sandbox của runtime, `alp` không ghi được `~/.alp` và không spawn được worker
 * ngoài sandbox (đo 2026-09-18). Vòng governance chỉ đóng được nếu process root phục vụ
 * lệnh thay execution — với binding của **execution đó**, lấy từ launch env ALP đã gắn,
 * không phải từ request. Fake runtime ở đây viết request đúng giao thức và đợi response.
 */
function relayServer() {
  const execute = vi.fn(async (input: RelayExecuteInput) => ({
    exitCode: 0, stdout: `served ${input.argv.join(" ")}\n`, stderr: "",
  }));
  return { relay: new RelayServer({ execute, pollIntervalMs: 20 }), execute };
}

async function runMain(environment: E2eEnvironment, mode: "ultra" | "puck", relay: RelayServer) {
  return runMainSession({ cwd: environment.project, mode }, {
    registry: agentRegistry,
    selector: { select: async (input) => ({ ok: true, mode: input.requestedMode!, source: "explicit" }) },
    executionService: environment.executionService,
    graph: environment.graph,
    threads: environment.threads,
    adapters: environment.adapters,
    backend: environment.backend,
    executionId: () => `exec_main_${mode}`,
    interactive: false,
    workspaceModeFor: async () => "workspace-write",
    relay,
  });
}

describe("e2e: execution relay", () => {
  it.each([["ultra", "claude"], ["puck", "codex"]] as const)(
    "serves `alp delegate` from inside the %s root session with the root's own binding",
    async (mode, runtime) => {
      const environment = await createE2eEnvironment({
        output: "done",
        extraEnv: { ALP_E2E_RELAY_ARGV: JSON.stringify(["delegate", "worker", "--", "add a parser"]) },
      });
      const { relay, execute } = relayServer();

      const result = await runMain(environment, mode, relay);
      expect(result).toMatchObject({ status: "completed" });

      const capture = await environment.capture(runtime);
      const relayDirectory = executionArtifactPaths(environment.executionsRoot, `exec_main_${mode}`).relayDirectory;
      expect(capture.env.ALP_RELAY_DIR).toBe(relayDirectory);
      expect(capture.relay).toMatchObject({
        directory: relayDirectory,
        server: { v: 1, pid: process.pid, executionId: `exec_main_${mode}` },
        error: null,
        response: { v: 1, exitCode: 0, stdout: "served delegate worker -- add a parser\n", stderr: "" },
      });
      expect(capture.relay!.response!.id).toBe(capture.relay!.request.id);

      // Root thi hành với binding của chính nó — đúng bốn biến binding mà runtime cũng đang giữ.
      expect(execute).toHaveBeenCalledOnce();
      const input = execute.mock.calls[0]![0];
      expect(input.argv).toEqual(["delegate", "worker", "--", "add a parser"]);
      expect(input.cwd).toBe(capture.cwd);
      for (const key of ["ALP_EXECUTION_GRAPH_ID", "ALP_DELEGATION_EXECUTION_ID", "ALP_EXECUTION_CAPABILITY", "ALP_EXECUTION_DEADLINE_AT", "ALP_THREAD_ID"]) {
        expect(input.env[key], key).toBe(capture.env[key]);
      }
      expect(input.env.ALP_DELEGATION_EXECUTION_ID).toBe(`exec_main_${mode}`);
      expect(input.env).not.toHaveProperty("ALP_RELAY_DIR");

      // Phiên xong thì không còn ai phục vụ thư mục này: server.json phải biến mất.
      await expect(stat(join(relayDirectory, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("serves a foreground child with the child's binding, not the root's", async () => {
    const environment = await createE2eEnvironment({
      output: "child done",
      extraEnv: { ALP_E2E_RELAY_ARGV: JSON.stringify(["delegation", "status", "req_x"]), ALP_E2E_RELAY_TIMEOUT_MS: "300" },
    });
    const root = await createMaterializedRoot(environment, { agentId: "main", executionId: "exec_root_main" });
    const { relay, execute } = relayServer();
    let next = 0;
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
      ids: { request: () => `req_${next}`, execution: () => `exec_child_${next++}` },
      relay,
    });

    const foreground = await service.delegate({ targetRole: "search", task: "find it", workspace: environment.project });
    expect((await service.wait(foreground.executionId)).status).toBe("completed");
    const served = await environment.captureOf(foreground.executionId);
    expect(served.relay).toMatchObject({ error: null, server: { executionId: foreground.executionId }, response: { exitCode: 0, stdout: "served delegation status req_x\n" } });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![0].env).toMatchObject({
      ALP_DELEGATION_EXECUTION_ID: foreground.executionId,
      ALP_EXECUTION_CAPABILITY: served.env.ALP_EXECUTION_CAPABILITY,
    });
    expect(execute.mock.calls[0]![0].env.ALP_EXECUTION_CAPABILITY).not.toBe(root.binding.capability);
    const childRelay = executionArtifactPaths(environment.executionsRoot, foreground.executionId).relayDirectory;
    await expect(stat(join(childRelay, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });

    // Con `--background` được supervisor detached của backend local phục vụ (GitHub #24), và
    // harness này không spawn supervisor thật: "không đăng ký ở service" chứng minh ở
    // `test/delegation/delegation-service.test.ts`, "supervisor phục vụ đúng bằng đời runtime"
    // ở `test/backend/local-supervisor.test.ts`, "spec mang relay" ở `local-process-backend.test.ts`.
  });

  it("refuses from the root what the session context never offered", async () => {
    const environment = await createE2eEnvironment({
      output: "done",
      extraEnv: { ALP_E2E_RELAY_ARGV: JSON.stringify(["mode", "ultra"]) },
    });
    const { relay, execute } = relayServer();
    await runMain(environment, "ultra", relay);
    const capture = await environment.capture("claude");
    expect(capture.relay!.response).toMatchObject({ exitCode: 2, stdout: "" });
    expect(capture.relay!.response!.stderr).toMatch(/mode ultra/u);
    expect(execute).not.toHaveBeenCalled();
    // Root ghi gì cũng phải nằm dưới execution: relay/ không được kéo file vào workspace.
    expect(await readFile(join(environment.project, ".gitkeep"), "utf8").catch(() => "absent")).toBe("absent");
  });
});

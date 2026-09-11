import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_EXECUTION_GRAPH_LIMITS } from "../../src/execution/graph/defaults";
import {
  ExecutionGraphService,
  PRINCIPAL_REQUESTER,
  type ExecutionBinding,
} from "../../src/execution/graph/execution-graph-service";
import type { ExecutionGraphLimits } from "../../src/execution/graph/types";
import { FileExecutionGraphStore } from "../../src/execution/graph/file-execution-graph-store";
import { removeTemporary } from "../support/temporary-root";

const run = promisify(execFile);
const REPO_ROOT = resolve(__dirname, "..", "..");
const RUNNER = join(REPO_ROOT, "test", "fixtures", "run-typescript.cjs");
const ACTOR = join(REPO_ROOT, "test", "fixtures", "execution-graph-actor.ts");

const roots: string[] = [];
const running: ChildProcess[] = [];

afterEach(async () => {
  for (const child of running.splice(0)) child.kill("SIGKILL");
  await Promise.all(roots.splice(0).map(removeTemporary));
});

const sleep = (ms: number): Promise<void> => new Promise((settle) => setTimeout(settle, ms));

async function waitFor(condition: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await sleep(20);
  }
}

/** A tree on disk with a started root, plus a service reading it the way a CLI would. */
async function tree(limits?: Partial<ExecutionGraphLimits>, options: { readonly now?: () => Date } = {}) {
  const root = await mkdtemp(join(tmpdir(), "alp-graph-mp-"));
  roots.push(root);
  const graphs = join(root, "execution-graphs");
  const service = new ExecutionGraphService({
    store: new FileExecutionGraphStore({ root: graphs, lockTimeoutMs: 30_000 }),
    ...(limits ? { limits: { ...DEFAULT_EXECUTION_GRAPH_LIMITS, ...limits } } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const created = await service.createRoot({ agentId: "main", thread: null, executionId: "exec_root" });
  await service.startRoot(created.binding, async () => undefined);
  return { root, graphs, service, binding: created.binding };
}

/** The four variables a delegate process really receives, and nothing else from this one. */
function environmentFor(binding: ExecutionBinding): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ALP_EXECUTION_GRAPH_ID: binding.graphId,
    ALP_DELEGATION_EXECUTION_ID: binding.executionId,
    ALP_EXECUTION_CAPABILITY: binding.capability,
    ALP_EXECUTION_DEADLINE_AT: binding.deadlineAt,
  };
}

function actor(graphs: string, binding: ExecutionBinding, args: readonly string[]): ChildProcess {
  const child = spawn(process.execPath, [RUNNER, ACTOR, graphs, ...args], {
    cwd: REPO_ROOT,
    env: environmentFor(binding),
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.push(child);
  return child;
}

describe("execution graph across processes", () => {
  /**
   * Trần phải là trần của *cây*, không của một process.
   *
   * Hàng đợi lease trong bộ nhớ của store làm mọi thao tác trong một process nối tiếp nhau,
   * nên một trần tính sai vẫn cho suite in-process xanh. Bốn process cùng xin nhiều hơn số
   * chỗ còn lại là phép thử duy nhất phân biệt được hai chuyện đó — và nó cũng là hình dạng
   * thật của `alp delegate` chạy song song trong một phiên.
   */
  it("hands out exactly the slots the tree has, no matter how many processes ask", async () => {
    const fixture = await tree({
      maxChildrenPerExecution: 4,
      maxConcurrentChildrenPerExecution: 4,
      maxConcurrentExecutions: 8,
      delegationLimit: 8,
    });

    const results = await Promise.all([0, 1, 2, 3].map(async (index) => {
      const { stdout } = await run(
        process.execPath,
        [RUNNER, ACTOR, fixture.graphs, "spawn-children", `actor${index}`, "3"],
        { cwd: REPO_ROOT, env: environmentFor(fixture.binding) },
      );
      return JSON.parse(stdout) as { started: string[]; refused: string[] };
    }));

    const started = results.flatMap((result) => result.started);
    expect(started).toHaveLength(4);
    expect(new Set(started).size).toBe(4);
    // Mọi lần còn lại bị từ chối vì trần, không vì một lỗi khoá hay một lần ghi bị mất.
    const refused = results.flatMap((result) => result.refused);
    expect(refused).toHaveLength(8);
    for (const code of refused) {
      expect(["CHILD_LIMIT_EXCEEDED", "CONCURRENCY_LIMIT_EXCEEDED", "DELEGATION_LIMIT_EXCEEDED"])
        .toContain(code);
    }

    const graph = (await fixture.service.getGraph("exec_root"))!;
    expect(graph.nodes.filter((node) => node.parentExecutionId === "exec_root")).toHaveLength(4);
    expect(graph.delegationUsed).toBe(4);
    // Zero lost update: mỗi lần ghi thành công để lại đúng một revision.
    expect(graph.revision).toBeGreaterThanOrEqual(graph.nodes.length);
    expect(graph.reservations).toEqual([]);
  }, 60_000);

  /**
   * Huỷ trong lúc một process khác đang giữ chỗ.
   *
   * Đây là cửa sổ mà một `cancel` thắng cuộc vẫn để lại một process chạy sau: chỗ đã giữ,
   * lệnh huỷ đi qua, rồi caller mới quay lại đăng ký. Chỗ giữ phải chết cùng nhánh, và
   * callback đăng ký — nơi một backend thật sẽ spawn — không được chạy.
   */
  it("kills a reservation held by another process, before it can become a run", async () => {
    const fixture = await tree();
    const marker = join(fixture.root, "reserved.json");
    const release = join(fixture.root, "release");
    const child = actor(fixture.graphs, fixture.binding, [
      "start-after-release", "late", "1", marker, release,
    ]);
    const output: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
    await waitFor(() => existsSync(marker));

    await fixture.service.cancelSubtree({
      graphId: "exec_root",
      executionId: "exec_root",
      reason: "USER_REQUEST",
      requestedBy: PRINCIPAL_REQUESTER,
    }, async () => undefined);
    await writeFile(release, "go");
    await new Promise((settle) => child.on("exit", settle));

    const reported = JSON.parse(Buffer.concat(output).toString("utf8")) as {
      outcome: string; code: string; registered: boolean;
    };
    expect(reported.outcome).toBe("refused");
    expect(reported.code).toBe("RESERVATION_NOT_FOUND");
    // Không có process muộn: callback đăng ký chưa từng chạy.
    expect(reported.registered).toBe(false);
    const graph = (await fixture.service.getGraph("exec_root"))!;
    expect(graph.nodes).toHaveLength(1);
    expect(graph.reservations).toEqual([]);
  }, 60_000);

  /**
   * Caller chết trong lúc còn cầm một chỗ.
   *
   * Không ai trả lại chỗ đó: process cầm nó đã biến mất. TTL là thứ duy nhất còn mở lại được
   * cây, nên nó phải tự hết hạn và trả chỗ về cho cây — nếu không, một `alp` bị Ctrl-C đúng
   * lúc sẽ làm nhánh đó chật vĩnh viễn.
   */
  it("reopens a slot held by a caller that was killed", async () => {
    const fixture = await tree({ maxConcurrentChildrenPerExecution: 1, maxChildrenPerExecution: 4 });
    const marker = join(fixture.root, "reserved.json");
    const child = actor(fixture.graphs, fixture.binding, ["reserve-and-hang", "orphan", "1", marker]);
    await waitFor(() => existsSync(marker));
    child.kill("SIGKILL");

    // Chỗ vẫn nằm trên đĩa: không ai dọn nó, vì người cầm nó đã chết.
    const held = (await fixture.service.getGraph("exec_root"))!;
    expect(held.reservations).toHaveLength(1);
    expect(held.nodes).toHaveLength(1);

    // Một process sau, nhìn cùng cây ấy qua đồng hồ của nó, sau khi TTL đã trôi qua.
    const later = new ExecutionGraphService({
      store: new FileExecutionGraphStore({ root: fixture.graphs, lockTimeoutMs: 30_000 }),
      now: () => new Date(Date.now() + DEFAULT_EXECUTION_GRAPH_LIMITS.reservationTtlMs + 1_000),
    });
    const reserved = await later.reserveChild(fixture.binding, {
      requestId: "req_after",
      agentId: "search",
      task: "after the orphan",
      workspace: "/project",
      workspaceMode: "read-only",
      mode: "medium",
      background: true,
      interactive: false,
      timeoutMs: null,
      metadata: {},
    });
    expect(reserved.kind).toBe("reserved");
    const graph = (await later.getGraph("exec_root"))!;
    // Chỗ mồ côi đã bị dọn trong chính lần ghi ấy, không tích lại.
    expect(graph.reservations).toHaveLength(1);
  }, 60_000);

  /**
   * Caller chết sau khi process con đã được đăng ký.
   *
   * Cây vẫn nói `running`, và không còn ai chứng kiến. Reconciliation là thứ duy nhất đóng
   * được node đó, và nó phải đóng bằng `interrupted` — một execution đã chết mà không ai ghi
   * lại kết cục — chứ không phải `completed`.
   */
  it("closes a node whose caller died after the process was registered", async () => {
    const fixture = await tree();
    const marker = join(fixture.root, "started");
    const child = actor(fixture.graphs, fixture.binding, ["run-and-hang", "abandoned", "1", marker]);
    await waitFor(() => existsSync(marker));
    const executionId = await readFile(marker, "utf8");
    child.kill("SIGKILL");

    const before = (await fixture.service.getGraph("exec_root"))!;
    expect(before.nodes.find((node) => node.executionId === executionId)).toMatchObject({ status: "running" });

    // Root vẫn là process đang chạy test này; chỉ node bị bỏ rơi là không còn ai.
    const reconciled = await fixture.service.reconcile("exec_root", async (candidate) =>
      candidate === executionId ? "missing" : "active");

    expect(reconciled.nodes.find((node) => node.executionId === executionId))
      .toMatchObject({ status: "interrupted" });
    // Và cây mở lại: chỗ mà node chết đang chiếm được trả về.
    expect(reconciled.nodes.filter((node) => node.status === "running")).toHaveLength(1);
  }, 60_000);

  /**
   * Cùng một `requestId` từ hai process là một lần gọi bị lặp — một lần retry sau khi lệnh
   * đầu mất kết nối. Hai node ở đây là hai process cùng sửa một workspace.
   */
  it("charges a repeated request once even when two processes race with it", async () => {
    const fixture = await tree({ maxChildrenPerExecution: 4, maxConcurrentChildrenPerExecution: 4 });

    const outcomes = await Promise.all([0, 1].map(async () => {
      const { stdout } = await run(
        process.execPath,
        [RUNNER, ACTOR, fixture.graphs, "spawn-children", "retried", "1"],
        { cwd: REPO_ROOT, env: environmentFor(fixture.binding) },
      );
      return JSON.parse(stdout) as { started: string[]; refused: string[] };
    }));

    const started = outcomes.flatMap((outcome) => outcome.started);
    const refused = outcomes.flatMap((outcome) => outcome.refused);
    expect(started.length + refused.length).toBe(2);
    // Người thua nhận lại đúng con cũ, hoặc nghe rằng nó đang được mở — không bao giờ một con thứ hai.
    expect(refused.every((code) => ["EXISTING", "REQUEST_IN_PROGRESS"].includes(code))).toBe(true);
    const graph = (await fixture.service.getGraph("exec_root"))!;
    expect(graph.nodes.filter((node) => node.requestId === "retried-0")).toHaveLength(1);
    expect(graph.delegationUsed).toBe(1);
  }, 60_000);
});

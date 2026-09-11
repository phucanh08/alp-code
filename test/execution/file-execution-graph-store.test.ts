import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { isExecutionGraphError } from "../../src/execution/graph/errors";
import { FileExecutionGraphStore } from "../../src/execution/graph/file-execution-graph-store";
import { childNode, graphFixture, nextRevision, rootNode } from "../support/execution-graph-fixture";
import { expectPosixMode } from "../support/file-mode";
import { removeTemporary } from "../support/temporary-root";
import { describeExecutionGraphStore } from "./execution-graph-store.contract";

const run = promisify(execFile);
const REPO_ROOT = resolve(__dirname, "..", "..");
const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = join(await mkdtemp(join(tmpdir(), "alp-graph-")), "execution-graphs");
  roots.push(root);
  return root;
}

async function codeOf(operation: () => Promise<unknown>): Promise<string | null> {
  try {
    await operation();
    return null;
  } catch (error) {
    if (isExecutionGraphError(error)) return error.code;
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTemporary(join(root, ".."))));
});

describeExecutionGraphStore("FileExecutionGraphStore", async () => {
  const root = await temporaryRoot();
  return { store: new FileExecutionGraphStore({ root }), cleanup: async () => undefined };
});

describe("FileExecutionGraphStore on disk", () => {
  it("keeps the graph private: 0700 directories, 0600 documents", async () => {
    const root = await temporaryRoot();
    const store = new FileExecutionGraphStore({ root });
    await store.create(graphFixture({ nodes: [rootNode(), childNode("child-a", "root-1")] }));
    await expectPosixMode(root, 0o700);
    await expectPosixMode(join(root, "by-execution"), 0o700);
    await expectPosixMode(join(root, "root-1.json"), 0o600);
    await expectPosixMode(join(root, "by-execution", "child-a.json"), 0o600);
  });

  it("leaves no temporary files behind after a write", async () => {
    const root = await temporaryRoot();
    const store = new FileExecutionGraphStore({ root });
    await store.create(graphFixture());
    await store.withExclusiveLease("root-1", async (lease) => lease.write(nextRevision(await lease.read())));
    expect((await readdir(root)).sort()).toEqual(["by-execution", "root-1.json"]);
  });

  /**
   * Fallback nuốt corruption là cách một cây mất trần mà không ai biết: caller thấy "không có
   * graph", đi tiếp bằng đường legacy, và mọi giới hạn depth/concurrency biến mất cùng lúc.
   */
  it("fails closed on a corrupt document instead of reporting no graph", async () => {
    const root = await temporaryRoot();
    const store = new FileExecutionGraphStore({ root });
    await store.create(graphFixture());

    await writeFile(join(root, "root-1.json"), "{ not json", "utf8");
    expect(await codeOf(() => store.get("root-1"))).toBe("EXECUTION_GRAPH_CORRUPT");
    expect(await codeOf(() => store.findByExecutionId("root-1"))).toBe("EXECUTION_GRAPH_CORRUPT");

    // Đọc được JSON nhưng cây sai hình dạng cũng là corrupt, không phải "chưa có graph".
    await writeFile(join(root, "root-1.json"), JSON.stringify({ version: 1, graphId: "root-1" }), "utf8");
    expect(await codeOf(() => store.get("root-1"))).toBe("EXECUTION_GRAPH_CORRUPT");
    expect(await codeOf(() => store.withExclusiveLease("root-1", async () => undefined))).toBe(
      "EXECUTION_GRAPH_CORRUPT",
    );
  });

  it("rebuilds a locator that is missing, stale, or unreadable", async () => {
    const root = await temporaryRoot();
    const store = new FileExecutionGraphStore({ root });
    await store.create(graphFixture({ nodes: [rootNode(), childNode("child-a", "root-1")] }));
    const locator = join(root, "by-execution", "child-a.json");

    await rm(locator);
    expect((await store.findByExecutionId("child-a"))?.graphId).toBe("root-1");
    expect(JSON.parse(await readFile(locator, "utf8")).graphId).toBe("root-1");

    // Trỏ tới một graph có thật nhưng không chứa node: câu trả lời phải tới từ lần quét.
    await store.create(graphFixture({ graphId: "root-2", nodes: [rootNode({ executionId: "root-2", graphId: "root-2" })] }));
    await writeFile(locator, JSON.stringify({ version: 1, graphId: "root-2" }), "utf8");
    expect((await store.findByExecutionId("child-a"))?.graphId).toBe("root-1");
    expect(JSON.parse(await readFile(locator, "utf8")).graphId).toBe("root-1");

    await writeFile(locator, "{ broken", "utf8");
    expect((await store.findByExecutionId("child-a"))?.graphId).toBe("root-1");
  });

  it("does not let a locator name a graph that never held the execution", async () => {
    const root = await temporaryRoot();
    const store = new FileExecutionGraphStore({ root });
    await store.create(graphFixture({ nodes: [rootNode(), childNode("child-a", "root-1")] }));
    await mkdir(join(root, "by-execution"), { recursive: true });
    await writeFile(join(root, "by-execution", "stranger.json"), JSON.stringify({ version: 1, graphId: "root-1" }), "utf8");
    expect(await store.findByExecutionId("stranger")).toBeNull();
  });

  /**
   * PID tái dùng và metadata cũ là hai cách một khoá *đang sống* trông như đã chết. Cướp nó là
   * cho hai process cùng ghi một cây — đúng thứ khoá này tồn tại để chặn — nên khi không chứng
   * minh được owner đã chết, câu trả lời đúng là hết giờ, không phải đi tiếp.
   */
  it("waits out a stale lock whose owner is still alive, and never steals it", async () => {
    const root = await temporaryRoot();
    const store = new FileExecutionGraphStore({ root, lockTimeoutMs: 150 });
    await store.create(graphFixture());
    const lockDirectory = join(root, "root-1.json.lock");
    await mkdir(lockDirectory, { mode: 0o700 });
    await writeFile(
      join(lockDirectory, "owner.json"),
      JSON.stringify({ pid: process.pid, host: hostname(), acquiredAt: new Date(0).toISOString() }),
      "utf8",
    );
    const old = new Date(Date.now() - 10 * 60 * 1_000);
    await utimes(lockDirectory, old, old);

    expect(await codeOf(() => store.withExclusiveLease("root-1", async () => undefined))).toBe(
      "EXECUTION_GRAPH_LOCK_TIMEOUT",
    );
    expect((await readdir(root)).includes("root-1.json.lock")).toBe(true);
  });

  it("reclaims a stale lock once its owner is provably gone", async () => {
    const root = await temporaryRoot();
    const store = new FileExecutionGraphStore({ root, lockTimeoutMs: 2_000 });
    await store.create(graphFixture());
    const lockDirectory = join(root, "root-1.json.lock");
    await mkdir(lockDirectory, { mode: 0o700 });
    // Một process đã thoát hẳn: pid của nó không còn nhận tín hiệu nào.
    const { stdout } = await run(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
    await writeFile(
      join(lockDirectory, "owner.json"),
      JSON.stringify({ pid: Number(stdout), host: hostname(), acquiredAt: new Date(0).toISOString() }),
      "utf8",
    );
    const old = new Date(Date.now() - 10 * 60 * 1_000);
    await utimes(lockDirectory, old, old);

    const written = await store.withExclusiveLease("root-1", async (lease) =>
      lease.write(nextRevision(await lease.read())),
    );
    expect(written.revision).toBe(1);
  });

  it("keeps a stale lock it cannot attribute to any process on this machine", async () => {
    const root = await temporaryRoot();
    const store = new FileExecutionGraphStore({ root, lockTimeoutMs: 150 });
    await store.create(graphFixture());
    const lockDirectory = join(root, "root-1.json.lock");
    await mkdir(lockDirectory, { mode: 0o700 });
    await writeFile(
      join(lockDirectory, "owner.json"),
      JSON.stringify({ pid: 1234, host: "another-machine", acquiredAt: new Date(0).toISOString() }),
      "utf8",
    );
    const old = new Date(Date.now() - 10 * 60 * 1_000);
    await utimes(lockDirectory, old, old);

    expect(await codeOf(() => store.withExclusiveLease("root-1", async () => undefined))).toBe(
      "EXECUTION_GRAPH_LOCK_TIMEOUT",
    );
  });

  /**
   * Câu hỏi mà một suite in-process không hỏi được. Hàng đợi trong bộ nhớ của store làm mọi
   * lease của **một** process nối tiếp nhau, nên một lỗi khoá thư mục vẫn cho suite ấy xanh;
   * chỉ khi mỗi bên chỉ nhìn thấy đĩa thì lost update mới lộ ra.
   */
  it("does not lose an update when separate processes write the same graph", async () => {
    const root = await temporaryRoot();
    const store = new FileExecutionGraphStore({ root });
    await store.create(graphFixture());

    const processes = 4;
    const writesEach = 6;
    await Promise.all(
      Array.from({ length: processes }, (_unused, index) =>
        run(
          process.execPath,
          [
            join(REPO_ROOT, "test", "fixtures", "run-typescript.cjs"),
            join(REPO_ROOT, "test", "fixtures", "execution-graph-store-writer.ts"),
            root,
            "root-1",
            `writer${index}`,
            String(writesEach),
          ],
          { cwd: REPO_ROOT },
        ),
      ),
    );

    const graph = await store.get("root-1");
    expect(graph?.revision).toBe(processes * writesEach);
    expect(graph?.nodes).toHaveLength(processes * writesEach + 1);
  }, 60_000);
});

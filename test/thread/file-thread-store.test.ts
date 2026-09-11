import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { isThreadError } from "../../src/thread/errors";
import { FileThreadStore } from "../../src/thread/file-thread-store";
import { expectPosixMode } from "../support/file-mode";
import { removeTemporary } from "../support/temporary-root";
import { digest, nextThreadRevision } from "../support/thread-fixture";
import { describeThreadStore } from "./thread-store.contract";

const run = promisify(execFile);
const REPO_ROOT = resolve(__dirname, "..", "..");
const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = join(await mkdtemp(join(tmpdir(), "alp-thread-")), "threads");
  roots.push(root);
  return root;
}

async function codeOf(operation: () => Promise<unknown>): Promise<string | null> {
  try {
    await operation();
    return null;
  } catch (error) {
    if (isThreadError(error)) return error.code;
    throw error;
  }
}

const CREATED_AT = "2026-09-11T10:00:00.000Z";

async function seeded(options: { lockTimeoutMs?: number } = {}) {
  const root = await temporaryRoot();
  const store = new FileThreadStore({ root, ...options });
  await store.create({ id: "thread_t", agentId: "main", workspace: "/project", createdAt: CREATED_AT });
  return { root, store, directory: join(root, "thread_t") };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTemporary(join(root, ".."))));
});

describeThreadStore("FileThreadStore", async () => {
  const root = await temporaryRoot();
  return { store: new FileThreadStore({ root }), cleanup: async () => undefined };
});

describe("FileThreadStore on disk", () => {
  it("lays a thread out as one private directory: index beside immutable payload folders", async () => {
    const { root, store, directory } = await seeded();
    await store.withExclusiveLease("thread_t", async (lease) => {
      await lease.writePayload("context", "1", { objective: "x" });
      await lease.commit(nextThreadRevision(lease.current(), {
        currentContext: { revision: 1, digest: digest("ctx-1"), artifact: "context/1.json" },
      }));
    });
    expect((await readdir(root)).sort()).toEqual(["thread_t"]);
    expect((await readdir(directory)).sort()).toEqual(["compactions", "context", "messages", "thread.json"]);
    expect(await readdir(join(directory, "context"))).toEqual(["1.json"]);
    await expectPosixMode(root, 0o700);
    await expectPosixMode(directory, 0o700);
    await expectPosixMode(join(directory, "context"), 0o700);
    await expectPosixMode(join(directory, "thread.json"), 0o600);
    await expectPosixMode(join(directory, "context", "1.json"), 0o600);
    expect(JSON.parse(await readFile(join(directory, "context", "1.json"), "utf8"))).toEqual({ objective: "x" });
  });

  it("survives a process restart: a fresh store reads what the last one wrote", async () => {
    const { root, store } = await seeded();
    await store.withExclusiveLease("thread_t", (lease) =>
      lease.commit(nextThreadRevision(lease.current(), { title: "persisted" })));
    const later = new FileThreadStore({ root });
    expect(await later.get("thread_t")).toMatchObject({ title: "persisted", revision: 2 });
    expect((await later.list({ workspace: "/project" })).map((summary) => summary.id)).toEqual(["thread_t"]);
  });

  it("fails closed on a corrupt index and leaves the file untouched", async () => {
    const { store, directory } = await seeded();
    const index = join(directory, "thread.json");
    await writeFile(index, "{ not json", "utf8");
    expect(await codeOf(() => store.get("thread_t"))).toBe("THREAD_STORE_CORRUPT");
    expect(await codeOf(() => store.list())).toBe("THREAD_STORE_CORRUPT");
    expect(await codeOf(() => store.withExclusiveLease("thread_t", async () => undefined))).toBe("THREAD_STORE_CORRUPT");
    expect(await readFile(index, "utf8")).toBe("{ not json");

    // JSON hợp lệ nhưng không phải Thread: cũng corrupt, cũng không sửa.
    const structurallyBroken = JSON.stringify({ version: 1, id: "thread_t", executions: "??" });
    await writeFile(index, structurallyBroken, "utf8");
    expect(await codeOf(() => store.get("thread_t"))).toBe("THREAD_STORE_CORRUPT");
    expect(await readFile(index, "utf8")).toBe(structurallyBroken);

    // Index nói nó thuộc Thread khác: một thư mục bị copy tay.
    await writeFile(index, JSON.stringify({ ...(await new FileThreadStore({ root: join(directory, "..") }).create({
      id: "thread_other", agentId: "main", workspace: "/project",
    })) }), "utf8");
    expect(await codeOf(() => store.get("thread_t"))).toBe("THREAD_STORE_CORRUPT");
  });

  it("refuses to adopt a payload that is a symlink, wherever it points", async () => {
    const { root, store, directory } = await seeded();
    const outside = join(root, "..", "outside.json");
    await writeFile(outside, JSON.stringify({ evil: true }), "utf8");
    await symlink(outside, join(directory, "context", "1.json"));
    expect(await codeOf(() => store.withExclusiveLease("thread_t", (lease) =>
      lease.commit(nextThreadRevision(lease.current(), {
        currentContext: { revision: 1, digest: digest("ctx-1"), artifact: "context/1.json" },
      }))))).toBe("THREAD_INVARIANT_VIOLATION");
    expect((await store.get("thread_t"))!.currentContext).toBeNull();
    expect(await codeOf(() => store.readPayload("thread_t", "context/1.json"))).toBe("THREAD_INVARIANT_VIOLATION");

    // Symlink trỏ vào trong Thread cũng không: payload là file, không phải alias.
    await writeFile(join(directory, "context", "2.json"), "{}", "utf8");
    await symlink(join(directory, "context", "2.json"), join(directory, "context", "3.json"));
    expect(await codeOf(() => store.withExclusiveLease("thread_t", async (lease) => {
      await lease.writePayload("context", "1", {}).catch(() => undefined);
      await lease.commit(nextThreadRevision(lease.current(), {
        currentContext: { revision: 3, digest: digest("ctx-3"), artifact: "context/3.json" },
      }));
    }))).toBe("THREAD_INVARIANT_VIOLATION");
  });

  it("does not let a payload name escape its folder", async () => {
    const { store, directory } = await seeded();
    for (const name of ["../thread.json", "..", "sub/1", ".hidden", "a b", ""]) {
      expect(await codeOf(() => store.withExclusiveLease("thread_t", (lease) => lease.writePayload("context", name, {}))))
        .toBe("THREAD_INVARIANT_VIOLATION");
    }
    expect((await readdir(directory)).sort()).toEqual(["compactions", "context", "messages", "thread.json"]);
  });

  it("leaves no temporary files or lock behind after a write", async () => {
    const { store, directory } = await seeded();
    await store.withExclusiveLease("thread_t", (lease) =>
      lease.commit(nextThreadRevision(lease.current(), { title: "t" })));
    expect((await readdir(directory)).sort()).toEqual(["compactions", "context", "messages", "thread.json"]);
  });

  it("moves orphans into .quarantine and never back", async () => {
    const { store, directory } = await seeded();
    await writeFile(join(directory, "context", "7.json"), "{}", "utf8");
    await writeFile(join(directory, "messages", "1.json"), "{}", "utf8");
    expect(await store.collectOrphans("thread_t")).toEqual(["context/7.json", "messages/1.json"]);
    expect((await readdir(join(directory, ".quarantine"))).sort()).toEqual(["context-7.json", "messages-1.json"]);
    expect(await readdir(join(directory, "context"))).toEqual([]);
    expect((await store.get("thread_t"))!.revision).toBe(1);
  });

  /**
   * PID tái dùng và metadata cũ là hai cách một khoá *đang sống* trông như đã chết. Cướp nó
   * là cho hai process cùng ghi một Thread — nên khi không chứng minh được owner đã chết,
   * câu trả lời đúng là hết giờ, không phải đi tiếp.
   */
  it("waits out a stale lock whose owner is still alive, and never steals it", async () => {
    const { store, directory } = await seeded({ lockTimeoutMs: 150 });
    const lockDirectory = join(directory, ".lock");
    await mkdir(lockDirectory, { mode: 0o700 });
    await writeFile(
      join(lockDirectory, "owner.json"),
      JSON.stringify({ pid: process.pid, host: hostname(), acquiredAt: new Date(0).toISOString() }),
      "utf8",
    );
    const old = new Date(Date.now() - 10 * 60 * 1_000);
    await utimes(lockDirectory, old, old);
    expect(await codeOf(() => store.withExclusiveLease("thread_t", async () => undefined))).toBe("THREAD_LOCK_TIMEOUT");
    expect((await readdir(directory)).includes(".lock")).toBe(true);
  });

  it("reclaims a stale lock once its owner is provably gone", async () => {
    const { store, directory } = await seeded({ lockTimeoutMs: 2_000 });
    const lockDirectory = join(directory, ".lock");
    await mkdir(lockDirectory, { mode: 0o700 });
    const { stdout } = await run(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
    await writeFile(
      join(lockDirectory, "owner.json"),
      JSON.stringify({ pid: Number(stdout), host: hostname(), acquiredAt: new Date(0).toISOString() }),
      "utf8",
    );
    const old = new Date(Date.now() - 10 * 60 * 1_000);
    await utimes(lockDirectory, old, old);
    const written = await store.withExclusiveLease("thread_t", (lease) =>
      lease.commit(nextThreadRevision(lease.current(), { title: "after reclaim" })));
    expect(written.revision).toBe(2);
  });

  it("keeps a stale lock it cannot attribute to any process on this machine", async () => {
    const { store, directory } = await seeded({ lockTimeoutMs: 150 });
    const lockDirectory = join(directory, ".lock");
    await mkdir(lockDirectory, { mode: 0o700 });
    await writeFile(
      join(lockDirectory, "owner.json"),
      JSON.stringify({ pid: 1234, host: "another-machine", acquiredAt: new Date(0).toISOString() }),
      "utf8",
    );
    const old = new Date(Date.now() - 10 * 60 * 1_000);
    await utimes(lockDirectory, old, old);
    expect(await codeOf(() => store.withExclusiveLease("thread_t", async () => undefined))).toBe("THREAD_LOCK_TIMEOUT");
  });
});

describe("FileThreadStore across processes", () => {
  /**
   * Câu hỏi mà một suite in-process không hỏi được: hàng đợi trong bộ nhớ của store làm mọi
   * lease của **một** process nối tiếp nhau. Hai mươi CLI cùng ghi một Thread là hình dạng
   * thật của "nhiều terminal, một công việc", và lost update ở đây lộ ra dưới dạng revision
   * cuối nhỏ hơn tổng số lần ghi hoặc một sequence bị lặp.
   */
  it("does not lose an update when twenty processes write the same thread", async () => {
    const { root, store } = await seeded();
    const processes = 20;
    const writesEach = 3;
    await Promise.all(
      Array.from({ length: processes }, (_unused, index) =>
        run(
          process.execPath,
          [
            join(REPO_ROOT, "test", "fixtures", "run-typescript.cjs"),
            join(REPO_ROOT, "test", "fixtures", "thread-store-writer.ts"),
            root,
            "thread_t",
            `w${index}`,
            String(writesEach),
          ],
          { cwd: REPO_ROOT },
        ),
      ),
    );
    const thread = (await store.get("thread_t"))!;
    expect(thread.revision).toBe(1 + processes * writesEach);
    expect(thread.executions).toHaveLength(processes * writesEach);
    expect(thread.executions.map((ref) => ref.sequence)).toEqual(
      Array.from({ length: processes * writesEach }, (_unused, index) => index + 1),
    );
    expect(new Set(thread.executions.map((ref) => ref.executionId)).size).toBe(processes * writesEach);
  }, 120_000);
});

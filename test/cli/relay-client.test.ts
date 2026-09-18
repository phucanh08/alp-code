import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { relayCommand } from "../../src/cli/relay-client";

/**
 * Giao thức v1 (plans/260918-0700-execution-relay/plan.md §Giao thức):
 *   <relay>/server.json          { v:1, pid, executionId, registeredAt }
 *   <relay>/<id>.request.json    { v:1, id, argv, cwd, requestedAt }
 *   <relay>/<id>.response.json   { v:1, id, exitCode, stdout, stderr, finishedAt }
 * Client là phía chạy trong sandbox: chỉ được ghi vào <relay>, và phải fail-closed khi không có
 * ai phục vụ (không server.json, pid chết, hết deadline) thay vì đợi vô hạn.
 */
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

async function relayDirectory(server: { pid: number } | null = { pid: process.pid }): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "alp-relay-"));
  directories.push(directory);
  if (server) await writeFile(join(directory, "server.json"), JSON.stringify({ v: 1, pid: server.pid, executionId: "exec_root", registeredAt: "2026-09-18T00:00:00.000Z" }));
  return directory;
}

/** Sleep của một test mong client dừng: quá số vòng cho phép là client đã không fail-closed. */
function boundedSleep(limit: number, tick: () => void = () => {}) {
  let polls = 0;
  return async () => {
    tick();
    if (++polls > limit) throw new Error(`client kept polling past ${limit} rounds`);
  };
}

function io() {
  const out: string[] = [];
  return { out, write: (text: string) => { out.push(text); return true; } };
}

describe("relay client", () => {
  it("writes one request per the protocol, then returns the server's exit code and output", async () => {
    const directory = await relayDirectory();
    const stdout = io();
    const stderr = io();
    let requestSeen: unknown = null;
    // Server giả: lần đầu client ngủ, đọc request đang nằm trong thư mục và trả lời.
    const sleep = vi.fn(async () => {
      const files = (await readdir(directory)).filter((f) => f.endsWith(".request.json"));
      if (files.length !== 1 || requestSeen) return;
      const request = JSON.parse(await readFile(join(directory, files[0]!), "utf8")) as { id: string };
      requestSeen = request;
      await writeFile(join(directory, `${request.id}.response.json`), JSON.stringify({
        v: 1, id: request.id, exitCode: 3, stdout: "spawned exec_child\n", stderr: "warn\n", finishedAt: "2026-09-18T00:00:01.000Z",
      }));
    });

    const code = await relayCommand({
      directory, argv: ["delegate", "worker", "--", "add a parser"], cwd: "/work/project",
      stdout, stderr, sleep, now: () => 0, processAlive: () => true,
    });

    expect(code).toBe(3);
    expect(stdout.out.join("")).toBe("spawned exec_child\n");
    expect(stderr.out.join("")).toBe("warn\n");
    expect(requestSeen).toMatchObject({ v: 1, argv: ["delegate", "worker", "--", "add a parser"], cwd: "/work/project" });
    expect((requestSeen as { id: string }).id).toMatch(/^[0-9a-f]{32}$/u);
    expect((requestSeen as { requestedAt: string }).requestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    // Không để lại file tạm hay request đã xử lý xong phía client.
    expect((await readdir(directory)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("fails closed when no server has registered the directory, and writes nothing", async () => {
    const directory = await relayDirectory(null);
    await expect(relayCommand({ directory, argv: ["delegate"], cwd: "/w", stdout: io(), stderr: io(), sleep: boundedSleep(10), processAlive: () => true }))
      .rejects.toThrow(/relay/u);
    expect(await readdir(directory)).toEqual([]);
  });

  it("fails when the serving process is gone instead of waiting forever", async () => {
    const directory = await relayDirectory({ pid: 424242 });
    let polls = 0;
    const alive = vi.fn(() => polls++ < 2);
    await expect(relayCommand({ directory, argv: ["delegate"], cwd: "/w", stdout: io(), stderr: io(), sleep: boundedSleep(10), processAlive: alive }))
      .rejects.toThrow(/424242/u);
    expect(alive).toHaveBeenCalledWith(424242);
  });

  it("fails once the execution deadline has passed — and not a poll earlier", async () => {
    const directory = await relayDirectory();
    const deadline = Date.parse("2026-09-18T10:00:05.000Z");
    let clock = deadline - 5_000;
    await expect(relayCommand({
      directory, argv: ["delegate"], cwd: "/w", stdout: io(), stderr: io(),
      deadlineAt: "2026-09-18T10:00:05.000Z", now: () => clock, sleep: boundedSleep(10, () => { clock += 3_000; }), processAlive: () => true,
    })).rejects.toThrow(/deadline/u);
    expect(clock).toBeGreaterThanOrEqual(deadline);
  });

  it("backs off between polls without exceeding half a second", async () => {
    const directory = await relayDirectory();
    const delays: number[] = [];
    let polls = 0;
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
      if (++polls === 6) {
        const [file] = (await readdir(directory)).filter((f) => f.endsWith(".request.json"));
        const id = file!.replace(".request.json", "");
        await writeFile(join(directory, `${id}.response.json`), JSON.stringify({ v: 1, id, exitCode: 0, stdout: "", stderr: "", finishedAt: "x" }));
      }
    });
    await relayCommand({ directory, argv: ["--version"], cwd: "/w", stdout: io(), stderr: io(), sleep, now: () => 0, processAlive: () => true });
    expect(delays[0]).toBe(50);
    for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]!);
    expect(Math.max(...delays)).toBeLessThanOrEqual(500);
  });
});

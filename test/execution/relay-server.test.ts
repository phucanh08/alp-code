import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executionArtifactPaths, FileExecutionStore } from "../../src/execution/execution-store";
import { RelayServer, relayAllowed, spawnRelayExecutor, type RelayExecuteInput } from "../../src/execution/relay-server";

/**
 * Phía server của relay sống trong process root `alp` — process duy nhất thi hành lệnh ALP thay
 * một execution. Oracle: giao thức v1 và allowlist trong plans/260918-0700-execution-relay/plan.md;
 * allowlist bằng đúng những lệnh session context bảo vai gõ (`render-session-context.ts`,
 * `agents/main.ts`, `skills/delegation`): `delegate`, `delegation *`, `context *`, `--version`, `help`.
 */
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "alp-relay-server-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function server(execute = vi.fn(async (_input: RelayExecuteInput) => ({ exitCode: 0, stdout: "", stderr: "" }))) {
  const relay = new RelayServer({ execute, baseEnv: { HOME: "/home/root", PATH: "/bin", ALP_RELAY_DIR: "/should/not/leak" }, pid: 4321, pollIntervalMs: 10, now: () => new Date("2026-09-18T12:00:00.000Z") });
  cleanups.push(() => relay.close());
  return { relay, execute };
}

async function request(dir: string, id: string, argv: readonly string[], cwd = "/work/project"): Promise<void> {
  await writeFile(join(dir, `${id}.request.json`), JSON.stringify({ v: 1, id, argv, cwd, requestedAt: "2026-09-18T11:59:59.000Z" }));
}

async function response(dir: string, id: string, timeoutMs = 2_000): Promise<Record<string, unknown>> {
  const file = join(dir, `${id}.response.json`);
  const started = Date.now();
  for (;;) {
    try { return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() - started > timeoutMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);

describe("relay allowlist", () => {
  it.each([
    [["delegate", "worker", "--project", "/w", "--", "task"]],
    [["delegation", "status", "req_1"]],
    [["delegation", "accept", "req_1", "--reason", "ok"]],
    [["context", "pin", "decision", "use zod"]],
    [["--version"]],
    [["help"]],
  ])("allows what the session context tells a role to run: %j", (argv) => {
    expect(relayAllowed(argv)).toBe(true);
  });

  it.each([
    [["thread", "show"]],
    [["mode", "show"]],
    [["mode", "low"]],
    [["init"]],
    [["trust", "verify", "worker"]],
    [["identity"]],
    [["agent", "list"]],
    [["maintenance", "update"]],
    [[]],
  ])("denies everything else, fail-closed: %j", (argv) => {
    expect(relayAllowed(argv)).toBe(false);
  });
});

describe("relay server", () => {
  it("registers a directory by writing server.json per the protocol", async () => {
    const dir = await directory();
    const { relay } = server();
    relay.register({ executionId: "exec_root", directory: dir, env: {} });
    expect(JSON.parse(await readFile(join(dir, "server.json"), "utf8"))).toEqual({ v: 1, pid: 4321, executionId: "exec_root", registeredAt: "2026-09-18T12:00:00.000Z" });
  });

  it("serves a request with the directory's launch env — never the request's — and answers per the protocol", async () => {
    const dir = await directory();
    const { relay, execute } = server(vi.fn(async () => ({ exitCode: 3, stdout: "spawned exec_child\n", stderr: "warn\n" })));
    relay.register({ executionId: "exec_root", directory: dir, env: { ALP_EXECUTION_GRAPH_ID: "graph_1", ALP_DELEGATION_EXECUTION_ID: "exec_root", ALP_RELAY_DIR: join(dir) } });

    await request(dir, ID_A, ["delegate", "worker", "--", "add a parser"], "/work/project");

    expect(await response(dir, ID_A)).toEqual({ v: 1, id: ID_A, exitCode: 3, stdout: "spawned exec_child\n", stderr: "warn\n", finishedAt: "2026-09-18T12:00:00.000Z" });
    expect(execute).toHaveBeenCalledOnce();
    const input = execute.mock.calls[0]![0];
    expect(input.argv).toEqual(["delegate", "worker", "--", "add a parser"]);
    expect(input.cwd).toBe("/work/project");
    // Env của subprocess = env của root ⊕ launch env của execution, bỏ ALP_RELAY_DIR — nếu còn,
    // subprocess lại relay về chính thư mục này và treo mãi.
    expect(input.env).toMatchObject({ HOME: "/home/root", PATH: "/bin", ALP_EXECUTION_GRAPH_ID: "graph_1", ALP_DELEGATION_EXECUTION_ID: "exec_root" });
    expect(input.env).not.toHaveProperty("ALP_RELAY_DIR");
    // Request đã trả lời thì không còn nằm lại; file tạm cũng không.
    const left = await readdir(dir);
    expect(left).not.toContain(`${ID_A}.request.json`);
    expect(left.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses a command outside the allowlist without executing anything", async () => {
    const dir = await directory();
    const { relay, execute } = server();
    relay.register({ executionId: "exec_root", directory: dir, env: {} });

    await request(dir, ID_A, ["thread", "show"]);

    const answer = await response(dir, ID_A);
    expect(answer).toMatchObject({ v: 1, id: ID_A, exitCode: 2, stdout: "" });
    expect(answer.stderr).toMatch(/thread show/u);
    expect(answer.stderr).toMatch(/not available inside an execution/u);
    expect(execute).not.toHaveBeenCalled();
  });

  it("answers a request whose body is not a v1 request with an error instead of silence", async () => {
    const dir = await directory();
    const { relay, execute } = server();
    relay.register({ executionId: "exec_root", directory: dir, env: {} });

    await writeFile(join(dir, `${ID_A}.request.json`), JSON.stringify({ v: 2, id: ID_A, argv: ["delegate"], cwd: "/w" }));

    const answer = await response(dir, ID_A);
    expect(answer).toMatchObject({ exitCode: 2 });
    expect(answer.stderr).toMatch(/relay/u);
    expect(execute).not.toHaveBeenCalled();
  });

  it("ignores temp files and names that are not requests", async () => {
    const dir = await directory();
    const { relay, execute } = server();
    relay.register({ executionId: "exec_root", directory: dir, env: {} });
    await writeFile(join(dir, `${ID_A}.request.json.99.tmp`), JSON.stringify({ v: 1, id: ID_A, argv: ["delegate"], cwd: "/w", requestedAt: "x" }));
    await writeFile(join(dir, `notes.json`), JSON.stringify({ v: 1, id: ID_B, argv: ["delegate"], cwd: "/w", requestedAt: "x" }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(execute).not.toHaveBeenCalled();
    expect((await readdir(dir)).sort()).toEqual([`${ID_A}.request.json.99.tmp`, "notes.json", "server.json"]);
  });

  it("turns an executor failure into an exit-2 response so the client never hangs", async () => {
    const dir = await directory();
    const { relay } = server(vi.fn(async () => { throw new Error("spawn ENOENT: alp"); }));
    relay.register({ executionId: "exec_root", directory: dir, env: {} });
    await request(dir, ID_A, ["delegate", "worker"]);
    const answer = await response(dir, ID_A);
    expect(answer).toMatchObject({ exitCode: 2 });
    expect(answer.stderr).toMatch(/spawn ENOENT: alp/u);
  });

  it("serves requests concurrently — a foreground delegate must not block a sibling", async () => {
    const dir = await directory();
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const execute = vi.fn(async (input: RelayExecuteInput) => {
      if (input.argv[0] === "delegate") await first;
      return { exitCode: 0, stdout: `${input.argv[0]}\n`, stderr: "" };
    });
    const { relay } = server(execute);
    relay.register({ executionId: "exec_root", directory: dir, env: {} });
    await request(dir, ID_A, ["delegate", "worker"]);
    await request(dir, ID_B, ["delegation", "status", "req_1"]);
    expect(await response(dir, ID_B)).toMatchObject({ stdout: "delegation\n" });
    await expect(stat(join(dir, `${ID_A}.response.json`))).rejects.toMatchObject({ code: "ENOENT" });
    releaseFirst();
    expect(await response(dir, ID_A)).toMatchObject({ stdout: "delegate\n" });
  });

  it("serves several registered executions independently and stops one on close", async () => {
    const root = await directory();
    const child = await directory();
    const execute = vi.fn(async (input: RelayExecuteInput) => ({ exitCode: 0, stdout: input.env.ALP_DELEGATION_EXECUTION_ID ?? "", stderr: "" }));
    const { relay } = server(execute);
    relay.register({ executionId: "exec_root", directory: root, env: { ALP_DELEGATION_EXECUTION_ID: "exec_root" } });
    const handle = relay.register({ executionId: "exec_child", directory: child, env: { ALP_DELEGATION_EXECUTION_ID: "exec_child" } });

    await request(child, ID_A, ["delegation", "status", "r"]);
    expect(await response(child, ID_A)).toMatchObject({ stdout: "exec_child" });

    handle.close();
    await expect(stat(join(child, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await request(child, ID_B, ["delegation", "status", "r"]);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await expect(stat(join(child, `${ID_B}.response.json`))).rejects.toMatchObject({ code: "ENOENT" });

    await request(root, ID_B, ["delegation", "status", "r"]);
    expect(await response(root, ID_B)).toMatchObject({ stdout: "exec_root" });
  });
});

describe("spawn relay executor", () => {
  it("runs the stable command with the request's argv, cwd and env, capturing both streams and the exit code", async () => {
    const dir = await directory();
    const script = join(dir, "fake-alp");
    await writeFile(script, `#!/bin/sh\necho "argv=$*"\necho "cwd=$(pwd)"\necho "binding=$ALP_EXECUTION_GRAPH_ID relay=$ALP_RELAY_DIR"\necho "oops" >&2\nexit 3\n`);
    await chmod(script, 0o755);
    const execute = spawnRelayExecutor({ stableCommand: script });
    const result = await execute({ argv: ["delegate", "worker", "--", "two words"], cwd: dir, env: { PATH: process.env.PATH ?? "", ALP_EXECUTION_GRAPH_ID: "graph_1" } });
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe(`argv=delegate worker -- two words\ncwd=${await realpath(dir)}\nbinding=graph_1 relay=\n`);
    expect(result.stderr).toBe("oops\n");
  });

  it("rejects when the command cannot be started", async () => {
    const execute = spawnRelayExecutor({ stableCommand: "/nonexistent/alp" });
    await expect(execute({ argv: ["--version"], cwd: tmpdir(), env: {} })).rejects.toThrow(/ENOENT/u);
  });
});

async function realpath(path: string): Promise<string> {
  const { realpath: real } = await import("node:fs/promises");
  return real(path);
}

describe("execution artifacts", () => {
  it("names the relay directory and creates it with the execution", async () => {
    const root = await directory();
    const paths = executionArtifactPaths(root, "exec_1");
    expect(paths.relayDirectory).toBe(join(root, "exec_1", "relay"));
    const store = new FileExecutionStore({ root });
    await store.create({
      policy: { executionId: "exec_1" } as never,
      state: { executionId: "exec_1", status: "prepared" } as never,
    });
    expect((await stat(paths.relayDirectory)).isDirectory()).toBe(true);
  });
});

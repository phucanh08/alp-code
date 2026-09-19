import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  superviseExecution,
  type LocalSupervisorResult,
  type LocalSupervisorSpec,
} from "../../src/backend/local-supervisor";
import { removeTemporary } from "../support/temporary-root";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTemporary(root)));
});

async function supervise(
  root: string,
  command: string,
  args: readonly string[],
  temporaryFiles: readonly string[] = [],
  extra: Partial<LocalSupervisorSpec> = {},
): Promise<LocalSupervisorResult> {
  const resultFile = join(root, "result.json");
  await superviseExecution({
    executionId: "exec_supervised",
    command,
    args,
    cwd: root,
    env: {},
    logFile: join(root, "run.log"),
    resultFile,
    temporaryFiles,
    ...extra,
  });
  return JSON.parse(await readFile(resultFile, "utf8")) as LocalSupervisorResult;
}

/** A runtime that would outlive any test, standing in for an agent that will not stop. */
const FOREVER = ["-e", "setInterval(() => {}, 1000)"];

const sleep = (ms: number): Promise<void> => new Promise((settle) => setTimeout(settle, ms));

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await sleep(10);
  }
}

describe("superviseExecution", () => {
  it("records the exit status and the transcript after the caller is gone", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-supervisor-"));
    roots.push(root);

    const result = await supervise(root, process.execPath, [
      "-e",
      "console.log('on stdout'); console.error('on stderr'); process.exit(4)",
    ]);

    expect(result).toMatchObject({ executionId: "exec_supervised", exitCode: 4, signal: null });
    const log = await readFile(join(root, "run.log"), "utf8");
    expect(log).toContain("on stdout");
    expect(log).toContain("on stderr");
  });

  it("names a runtime that never started rather than reporting a synthetic exit code", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-supervisor-"));
    roots.push(root);

    // A failed spawn emits both `error` and `close`. Letting the second win reported this
    // as `exit code -2`, which reads as an agent that ran and failed.
    const result = await supervise(root, "definitely-not-a-real-binary-xyz", []);

    expect(result.spawnError).toMatch(/ENOENT/);
    expect(result.exitCode).toBeNull();
  });

  it("removes the runtime's temporary files once the run is over", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-supervisor-"));
    roots.push(root);
    const temporary = join(root, "prompt.md");
    await writeFile(temporary, "task");

    await supervise(root, process.execPath, ["-e", "0"], [temporary]);

    await expect(stat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("kills a runtime that outstays its deadline and says so in the result", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-supervisor-"));
    roots.push(root);

    const result = await supervise(root, process.execPath, FOREVER, [], {
      deadlineAt: new Date(Date.now() + 150).toISOString(),
    });

    // Đồng hồ thuộc về supervisor: CLI đã gọi nó có thể đã thoát từ lâu, và nếu timer nằm ở
    // đó thì một background execution không bao giờ hết hạn.
    expect(result).toMatchObject({ terminationReason: "deadline", exitCode: null, signal: "SIGTERM" });
    expect(await readFile(join(root, "run.log"), "utf8")).toContain("exceeded its deadline");
  });

  it("stops a runtime whose deadline had already passed when it started", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-supervisor-"));
    roots.push(root);

    const result = await supervise(root, process.execPath, FOREVER, [], {
      deadlineAt: new Date(Date.now() - 60_000).toISOString(),
    });

    expect(result.terminationReason).toBe("deadline");
  });

  it("reaches the runtime's own children, not just the process it launched", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-supervisor-"));
    roots.push(root);
    const marker = join(root, "grandchild-alive");
    // Cháu ghi file mỗi 20ms. Giết mỗi process đầu sẽ để lại đúng đám đang thực sự tiêu CPU,
    // nên nếu tín hiệu không tới cả group thì file vẫn mới sau khi supervisor đã xong.
    const beat = `setInterval(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(Date.now())), 20)`;
    const script =
      `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(beat)}], { stdio: "ignore" });` +
      `setInterval(() => {}, 1000);`;

    const running = supervise(root, process.execPath, ["-e", script], [], {
      deadlineAt: new Date(Date.now() + 2_000).toISOString(),
    });
    // Chờ cháu thật sự sống trước đã: một hạn tới trước khi nó kịp khởi động sẽ cho test
    // xanh mà không chứng minh được gì.
    await waitFor(() => existsSync(marker));
    await running;

    const settledAt = Date.now();
    await sleep(200);
    expect(Number(await readFile(marker, "utf8"))).toBeLessThanOrEqual(settledAt);
  });

  it("leaves no deadline mark on a run that ended on its own", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-supervisor-"));
    roots.push(root);

    const result = await supervise(root, process.execPath, ["-e", "process.exit(0)"], [], {
      deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    // Và supervisor trả quyền điều khiển ngay khi runtime xong — một timer chưa nhả sẽ giữ
    // event loop mở tới tận hạn, biến một run một giây thành một process ngồi im hai giờ.
    expect(result.terminationReason).toBeUndefined();
    expect(result.exitCode).toBe(0);
  });

  it("keeps the reason of a kill that did not come from the clock", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-supervisor-"));
    roots.push(root);

    const result = await supervise(
      root,
      process.execPath,
      ["-e", "setTimeout(() => process.kill(process.pid, 'SIGTERM'), 30); setInterval(() => {}, 1000)"],
      [],
      { deadlineAt: new Date(Date.now() + 3_600_000).toISOString() },
    );

    // Người dùng bấm huỷ cũng tới đây dưới dạng SIGTERM. Đánh dấu `deadline` cho mọi
    // SIGTERM sẽ đổ cho đồng hồ một quyết định của con người.
    expect(result.signal).toBe("SIGTERM");
    expect(result.terminationReason).toBeUndefined();
  });

  it("serves the execution's relay for exactly as long as the runtime lives (GitHub #24)", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-supervisor-"));
    roots.push(root);
    const relayDirectory = join(root, "relay");
    await mkdir(relayDirectory);
    // Lệnh `alp` giả: in argv và binding — đủ để thấy request đi qua server với launch env.
    const stableCommand = join(root, "fake-alp");
    await writeFile(stableCommand, `#!/bin/sh\necho "relayed argv=$* binding=$ALP_EXECUTION_GRAPH_ID"\n`);
    await chmod(stableCommand, 0o755);
    // Runtime giả: đợi server.json (đăng ký phải đi trước spawn), gửi một request, in response.
    const runtime = `
      const fs = require("node:fs"); const path = require("node:path");
      const dir = process.env.ALP_RELAY_DIR;
      const wait = (file) => { const until = Date.now() + 5000; while (!fs.existsSync(file)) { if (Date.now() > until) { console.log("timeout " + file); process.exit(9); } Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); } };
      wait(path.join(dir, "server.json"));
      const server = JSON.parse(fs.readFileSync(path.join(dir, "server.json"), "utf8"));
      console.log("server pid matches supervisor: " + (server.pid === process.ppid));
      const id = "a".repeat(32);
      fs.writeFileSync(path.join(dir, id + ".request.json"), JSON.stringify({ v: 1, id, argv: ["context", "pin", "x"], cwd: process.cwd(), requestedAt: new Date().toISOString() }));
      wait(path.join(dir, id + ".response.json"));
      process.stdout.write(JSON.parse(fs.readFileSync(path.join(dir, id + ".response.json"), "utf8")).stdout);
    `;

    const result = await supervise(root, process.execPath, ["-e", runtime], [], {
      env: { PATH: process.env.PATH ?? "", ALP_RELAY_DIR: relayDirectory, ALP_EXECUTION_GRAPH_ID: "graph_bg" },
      relay: { directory: relayDirectory, stableCommand },
    });

    expect(result.exitCode).toBe(0);
    const log = await readFile(join(root, "run.log"), "utf8");
    expect(log).toContain("server pid matches supervisor: true");
    expect(log).toContain("relayed argv=context pin x binding=graph_bg");
    // Runtime đã kết thúc thì `server.json` phải biến mất — để lại là một pid chết trong file
    // mà client fail-closed dựa vào.
    expect(existsSync(join(relayDirectory, "server.json"))).toBe(false);
  });

  it("runs without relay when the spec names none, and when the relay directory cannot be served", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-supervisor-"));
    roots.push(root);
    const plain = await supervise(root, process.execPath, ["-e", "process.exit(0)"], [], { relay: null });
    expect(plain.exitCode).toBe(0);
    expect(existsSync(join(root, "relay", "server.json"))).toBe(false);

    const missing = await supervise(root, process.execPath, ["-e", "process.exit(0)"], [], {
      relay: { directory: join(root, "does-not-exist"), stableCommand: process.execPath },
    });
    expect(missing.exitCode).toBe(0);
    expect(await readFile(join(root, "run.log"), "utf8")).toContain("[alp] relay unavailable for this execution");
  });

  it("deletes a spec it was handed, deadline or not", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-supervisor-"));
    roots.push(root);
    const specFile = join(root, "spec.json");
    await writeFile(specFile, "{}", { mode: 0o600 });

    await supervise(root, process.execPath, ["-e", "0"], [], { specFile });

    // Spec mang capability của execution: nó không được sống lâu hơn run.
    await expect(stat(specFile)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

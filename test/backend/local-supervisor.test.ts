import { existsSync } from "node:fs";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
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

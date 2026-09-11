import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseInternalCommand, runInternalCommand } from "../../src/cli/internal";
import { removeTemporary } from "../support/temporary-root";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(removeTemporary)));

function validSpec(root: string): Record<string, unknown> {
  return {
    executionId: "exec_1",
    command: "fake-runtime",
    args: ["--probe"],
    cwd: root,
    env: { ALP_EXECUTION_CAPABILITY: "secret" },
    logFile: join(root, "run.log"),
    resultFile: join(root, "result.json"),
    temporaryFiles: [],
  };
}

describe("internal CLI commands", () => {
  it("accepts only bounded, explicit command shapes", () => {
    expect(parseInternalCommand(["ensure-state"])).toEqual({ command: "ensure-state" });
    expect(parseInternalCommand(["update-check"])).toEqual({ command: "update-check" });
    expect(parseInternalCommand(["supervisor", "/tmp/spec.json"])).toEqual({ command: "supervisor", specFile: "/tmp/spec.json" });
    expect(() => parseInternalCommand(["supervisor"])).toThrow(/spec/);
    expect(() => parseInternalCommand(["foreign"])).toThrow(/unknown internal command/);
  });

  it("rejects oversized or non-private supervisor specs before executing them", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-internal-"));
    roots.push(root);
    const oversized = join(root, "oversized.json");
    await writeFile(oversized, Buffer.alloc(1024 * 1024 + 1));
    await expect(runInternalCommand(["supervisor", oversized], {
      ensureState: vi.fn(), refreshUpdateCheck: vi.fn(), supervise: vi.fn(),
    })).rejects.toThrow(/too large/);

    const publicSpec = join(root, "public.json");
    await writeFile(publicSpec, "{}\n", { mode: 0o644 });
    if (process.platform !== "win32") {
      await expect(runInternalCommand(["supervisor", publicSpec], {
        ensureState: vi.fn(), refreshUpdateCheck: vi.fn(), supervise: vi.fn(),
      })).rejects.toThrow(/0600/);
    }
  });

  it("refuses a spec whose shape it cannot vouch for", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-internal-"));
    roots.push(root);
    const supervise = vi.fn();
    const write = async (name: string, value: unknown): Promise<string> => {
      const file = join(root, name);
      await writeFile(file, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
      return file;
    };
    const run = (file: string): Promise<number> => runInternalCommand(["supervisor", file], {
      ensureState: vi.fn(), refreshUpdateCheck: vi.fn(), supervise,
    });

    await expect(run(await write("broken.json", "{ not json"))).rejects.toThrow(/invalid supervisor spec JSON/);
    await expect(run(await write("partial.json", { executionId: "exec_1" }))).rejects.toThrow(/schema/);
    // Một `deadlineAt` không parse được là tệ hơn một spec thiếu hạn: supervisor sẽ tính ra
    // `NaN` và đặt một timer không bao giờ nổ, tức là đúng cái vô hạn mà hạn sinh ra để chặn.
    await expect(run(await write("bad-deadline.json", { ...validSpec(root), deadlineAt: "tomorrow-ish" })))
      .rejects.toThrow(/schema/);
    await expect(run(await write("numeric-deadline.json", { ...validSpec(root), deadlineAt: 1_760_000_000_000 })))
      .rejects.toThrow(/schema/);
    expect(supervise).not.toHaveBeenCalled();
  });

  it("accepts a spec with a deadline, without one, and with none at all", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-internal-"));
    roots.push(root);
    const deadlineAt = new Date(Date.now() + 3_600_000).toISOString();

    for (const [name, deadline] of [["with", deadlineAt], ["null", null], ["absent", undefined]] as const) {
      const file = join(root, `${name}.json`);
      const spec = { ...validSpec(root), ...(deadline === undefined ? {} : { deadlineAt: deadline }) };
      await writeFile(file, JSON.stringify(spec), { mode: 0o600 });
      const supervise = vi.fn();
      expect(await runInternalCommand(["supervisor", file], {
        ensureState: vi.fn(), refreshUpdateCheck: vi.fn(), supervise,
      })).toBe(0);
      expect(supervise).toHaveBeenCalledWith(expect.objectContaining(
        deadline === undefined ? { executionId: "exec_1" } : { deadlineAt: deadline },
      ));
    }
  });

  it("destroys the spec before handing it on, not after the run", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-internal-"));
    roots.push(root);
    const file = join(root, "spec.json");
    await writeFile(file, JSON.stringify(validSpec(root)), { mode: 0o600 });

    let existedDuringSupervise = true;
    await runInternalCommand(["supervisor", file], {
      ensureState: vi.fn(),
      refreshUpdateCheck: vi.fn(),
      supervise: () => { existedDuringSupervise = existsSync(file); },
    });

    // Spec mang env đầy đủ của execution, capability trong đó. Xoá *trước* khi runtime được
    // spawn là điều duy nhất đóng được khoảng mà chính agent vừa sinh ra đọc được spec của
    // nó — nó kế thừa cwd và quyền của ta.
    expect(existedDuringSupervise).toBe(false);
    expect(existsSync(file)).toBe(false);
  });
});

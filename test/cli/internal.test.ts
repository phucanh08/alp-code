import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseInternalCommand, runInternalCommand } from "../../src/cli/internal";
import { removeTemporary } from "../support/temporary-root";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(removeTemporary)));

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
});

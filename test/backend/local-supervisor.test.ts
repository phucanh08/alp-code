import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { superviseExecution, type LocalSupervisorResult } from "../../src/backend/local-supervisor";
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
  });
  return JSON.parse(await readFile(resultFile, "utf8")) as LocalSupervisorResult;
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
});

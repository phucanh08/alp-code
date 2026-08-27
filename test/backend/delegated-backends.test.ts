import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const localRequire = createRequire(join(process.cwd(), "test", "backend", "delegated-backends.test.ts"));
const { HerdrBackend } = localRequire("../../scripts/lib/delegation/backends/herdr/backend.cjs");
const { PaseoBackend } = localRequire("../../scripts/lib/delegation/backends/paseo/backend.cjs");
const herdrClient = localRequire("../../scripts/lib/delegation/backends/herdr/herdr-client.cjs");

function state() {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    put(value: Record<string, unknown>) { rows.set(String(value.executionId), value); return value; },
    get(id: string) { return rows.get(id) ?? null; },
    update(id: string, patch: Record<string, unknown>) { Object.assign(rows.get(id)!, patch); },
    list() { return [...rows.values()]; },
  };
}

const launchSpec = {
  command: "codex",
  args: ["exec", "prepared prompt"],
  cwd: process.cwd(),
  env: { ALP_ROLE: "search", ALP_DELEGATION_EXECUTION_ID: "exec-prepared" },
  temporaryFiles: [],
};

describe("delegated backends", () => {
  it("reads Herdr pane output as raw text", () => {
    const calls: string[][] = [];
    const output = herdrClient.readPane("w1:p2", 40, (args: string[]) => {
      calls.push(args);
      return "review result\n";
    });

    expect(output).toBe("review result\n");
    expect(calls).toEqual([["pane", "read", "w1:p2", "--source", "recent-unwrapped", "--lines", "40"]]);
  });

  it("Herdr executes a prepared launch spec without rebuilding identity/runtime config", () => {
    const calls: Record<string, unknown>[] = [];
    const backend = new HerdrBackend({
      repoRoot: process.cwd(),
      stateDir: "/unused",
      state: state(),
      runtime: {
        available: () => ({ ok: true, version: "0.8.0" }),
        spawn: (input: Record<string, unknown>) => { calls.push(input); return { pane: "pane-1", label: "prepared" }; },
        orphans: () => [],
      },
    });

    const result = backend.spawn({
      executionId: "exec-prepared",
      request: { requestId: "req-1", parentExecutionId: null, executionOptions: { background: true } },
      launchSpec,
    });

    expect(result.status).toBe("running");
    expect(calls[0]).toMatchObject({ kind: "codex", argv: launchSpec.args, cwd: launchSpec.cwd, env: launchSpec.env });
  });

  it("Herdr cleanup removes prepared runtime temporary files", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-herdr-cleanup-"));
    const temporaryFile = join(root, "prompt.md");
    await writeFile(temporaryFile, "temporary");
    try {
      const backend = new HerdrBackend({
        repoRoot: process.cwd(),
        stateDir: "/unused",
        state: state(),
        runtime: {
          available: () => ({ ok: true, version: "0.8.0" }),
          spawn: () => ({ pane: "pane-cleanup", label: "prepared" }),
          cleanup: () => undefined,
          orphans: () => [],
        },
      });
      backend.spawn({
        executionId: "exec-cleanup-herdr",
        request: { requestId: "req-cleanup", parentExecutionId: null, executionOptions: { background: true } },
        launchSpec: { ...launchSpec, temporaryFiles: [temporaryFile] },
      });

      backend.cleanup("exec-cleanup-herdr");

      await expect(access(temporaryFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("Herdr foreground completion removes prepared runtime temporary files", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-herdr-foreground-cleanup-"));
    const temporaryFile = join(root, "prompt.md");
    await writeFile(temporaryFile, "temporary");
    try {
      const backend = new HerdrBackend({
        repoRoot: process.cwd(),
        stateDir: "/unused",
        state: state(),
        runtime: { available: () => ({ ok: false, reason: "headless" }), orphans: () => [] },
        spawnProcess: () => ({ status: 0, stdout: "done", stderr: "", error: null }),
      });

      const completed = backend.spawn({
        executionId: "exec-cleanup-herdr-foreground",
        request: { requestId: "req-cleanup", parentExecutionId: null, executionOptions: { background: false, interactive: false, timeoutMs: null } },
        launchSpec: { ...launchSpec, temporaryFiles: [temporaryFile] },
      });

      expect(completed.status).toBe("completed");
      await expect(access(temporaryFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("Paseo receives the prepared runtime command, args, cwd, and env", () => {
    const calls: string[][] = [];
    const backend = new PaseoBackend({
      config: { runtimeToolsDisabled: true, home: join(process.cwd(), ".missing-paseo-home") },
      stateDir: "/unused",
      state: state(),
      runner: (args: string[]) => {
        calls.push(args);
        return { status: 0, stdout: JSON.stringify({ agentId: "agent-1", status: "running" }), stderr: "", error: null };
      },
    });
    backend.spawn({
      executionId: "exec-prepared",
      request: { requestId: "req-1", parentRole: "main", targetRole: "search", parentExecutionId: null, executionOptions: {} },
      launchSpec,
    });

    const run = calls[0];
    expect(run).toContain("codex");
    expect(run).toContain("exec");
    expect(run).toContain("prepared prompt");
    expect(run[run.indexOf("--cwd") + 1]).toBe(launchSpec.cwd);
    expect(run).toContain("ALP_ROLE=search");
  });

  it("Paseo cleanup removes prepared runtime temporary files", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-paseo-cleanup-"));
    const temporaryFile = join(root, "prompt.md");
    await writeFile(temporaryFile, "temporary");
    try {
      const backend = new PaseoBackend({
        config: { runtimeToolsDisabled: true, home: join(root, "paseo-home") },
        stateDir: "/unused",
        state: state(),
        runner: (args: string[]) => {
          if (args[0] === "run") return { status: 0, stdout: JSON.stringify({ agentId: "agent-cleanup", status: "running" }), stderr: "", error: null };
          if (args[0] === "agent") return { status: 0, stdout: JSON.stringify({ status: "archived" }), stderr: "", error: null };
          throw new Error(`unexpected command: ${args.join(" ")}`);
        },
      });
      backend.spawn({
        executionId: "exec-cleanup-paseo",
        request: { requestId: "req-cleanup", parentExecutionId: null, executionOptions: { background: true } },
        launchSpec: { ...launchSpec, temporaryFiles: [temporaryFile] },
      });

      backend.cleanup("exec-cleanup-paseo");

      await expect(access(temporaryFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("delegated backends do not import registry, memory, policy, or identity builders", async () => {
    for (const file of [
      "scripts/lib/delegation/backends/herdr/backend.cjs",
      "scripts/lib/delegation/backends/paseo/backend.cjs",
    ]) {
      const source = await readFile(join(process.cwd(), file), "utf8");
      expect(source).not.toMatch(/loadout|codex-profile|context-builder|agent-registry|memory-service|policy-engine/i);
    }
  });
});

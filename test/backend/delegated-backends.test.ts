import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { removeTemporary } from "../support/temporary-root";

const localRequire = createRequire(join(process.cwd(), "test", "backend", "delegated-backends.test.ts"));
const { PaseoBackend } = localRequire("../../scripts/lib/delegation/backends/paseo/backend.cjs");

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
  intent: { prompt: "ALP task is in /tmp/task.md; execute it.", model: "claude-sonnet-5", mode: "plan" },
};

type Runner = (args: string[]) => { status: number; stdout: string; stderr: string; error: null };

function json(payload: Record<string, unknown>): ReturnType<Runner> {
  return { status: 0, stdout: JSON.stringify(payload), stderr: "", error: null };
}

/** A backend wired to a scripted Paseo CLI, with the home path pointed at nothing. */
function paseo(runner: Runner, rows = state()) {
  return new PaseoBackend({
    config: { runtimeToolsDisabled: true, home: join(process.cwd(), ".missing-paseo-home") },
    stateDir: "/unused",
    state: rows,
    runner,
  });
}

function spawn(backend: ReturnType<typeof paseo>, executionId: string): void {
  backend.spawn({
    executionId,
    request: { requestId: `req-${executionId}`, parentExecutionId: null, executionOptions: { background: true } },
    launchSpec,
  });
}

describe("delegated backends", () => {
  /**
   * `paseo run` is `run [options] <prompt>`, so the task has to arrive as the trailing
   * positional and the model and mode as flags. The previous shape — `"--", command,
   * ...args` — made the parser read the runtime's own name as the prompt and drop the rest,
   * so every delegated agent started with the literal word `codex` as its task.
   */
  it("Paseo receives the task as the prompt, with the model and mode pinned", () => {
    const calls: string[][] = [];
    const backend = paseo((args) => {
      calls.push(args);
      return json({ agentId: "agent-1", status: "running" });
    });
    spawn(backend, "exec-prepared");

    const run = calls[0];
    expect(run.at(-1)).toBe(launchSpec.intent.prompt);
    expect(run).not.toContain("--");
    expect(run[run.indexOf("--model") + 1]).toBe("claude-sonnet-5");
    expect(run[run.indexOf("--mode") + 1]).toBe("plan");
    expect(run[run.indexOf("--cwd") + 1]).toBe(launchSpec.cwd);
    expect(run).toContain("ALP_ROLE=search");
  });

  /**
   * A prompt-less spec would spawn an agent with nothing to do, which is the failure this
   * whole change exists to remove. Refusing at the call site names it; the agent cannot.
   */
  it("Paseo refuses to spawn a prepared launch that carries no prompt", () => {
    const backend = paseo(() => json({ agentId: "agent-empty", status: "running" }));

    expect(() => backend.spawn({
      executionId: "exec-no-prompt",
      request: { requestId: "req-no-prompt", parentExecutionId: null, executionOptions: { background: true } },
      launchSpec: { ...launchSpec, intent: { ...launchSpec.intent, prompt: null } },
    })).toThrow(/prompt trống/);
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
      await removeTemporary(root);
    }
  });

  /**
   * A delegated agent runs `--background` with nobody at the keyboard, so Paseo's
   * `permission` state is terminal rather than transient: reported as `running` it was
   * indistinguishable from work, and `wait` would sit on it for its 24-hour ceiling.
   */
  it("Paseo reports a permission-blocked execution as failed, not running", () => {
    const backend = paseo((args) => {
      if (args[0] === "run") return json({ agentId: "agent-blocked", status: "running" });
      if (args[0] === "inspect") return json({ status: "permission" });
      if (args[0] === "logs") return { status: 0, stdout: "[Shell] git status", stderr: "", error: null };
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });
    spawn(backend, "exec-blocked");

    const status = backend.status("exec-blocked");

    expect(status.status).toBe("failed");
    expect(status.error.message).toContain("permission prompt");
  });

  /**
   * `paseo inspect` reports a parked agent as `running`; only `wait` names `permission`, and
   * `wait` blocks. It does list the queue though, so the block is visible in a call the
   * backend already makes. Shape measured against a real parked agent.
   */
  it("Paseo detects a block from the queue inspect already carries", () => {
    const backend = paseo((args) => {
      if (args[0] === "run") return json({ agentId: "agent-parked", status: "running" });
      if (args[0] === "inspect") {
        return json({ Status: "running", PendingPermissions: [{ id: "permission-87bf7d4a-0c9c-4558-aa56-24d063547c8c", tool: "Bash" }] });
      }
      if (args[0] === "logs") return { status: 0, stdout: "[Shell] rm victim.txt", stderr: "", error: null };
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });
    spawn(backend, "exec-parked");

    const status = backend.status("exec-parked");

    expect(status.status).toBe("failed");
    expect(status.error.message).toContain("permission prompt");
  });

  it("Paseo leaves a running execution alone when its queue is empty", () => {
    const backend = paseo((args) => {
      if (args[0] === "run") return json({ agentId: "agent-mine", status: "running" });
      if (args[0] === "inspect") return json({ Status: "running", PendingPermissions: [] });
      if (args[0] === "logs") return { status: 0, stdout: "[Read] a.ts", stderr: "", error: null };
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });
    spawn(backend, "exec-mine");

    expect(backend.status("exec-mine").status).toBe("running");
  });

  /**
   * `--json` is not a promise that stdout holds only JSON: naming a new workspace prints two
   * human lines first, which made the first delegation into any new project fail.
   */
  it("Paseo parses JSON that follows a human-readable preamble", () => {
    const backend = paseo((args) => {
      if (args[0] === "run") {
        return {
          status: 0,
          stdout: `Created workspace wks_97dc35 - scratchpad\nTip: pass --workspace <id> to run in an existing workspace.\n${JSON.stringify({ agentId: "agent-preamble", status: "running" })}`,
          stderr: "",
          error: null,
        };
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });

    expect(() => spawn(backend, "exec-preamble")).not.toThrow();
  });

  it("Paseo still rejects output that carries no JSON document", () => {
    const backend = paseo(() => ({ status: 0, stdout: "Created workspace wks_1 - only prose\n", stderr: "", error: null }));

    expect(() => spawn(backend, "exec-prose")).toThrow(/JSON không hợp lệ/);
  });

  it("Paseo surfaces the same block from wait", () => {
    const backend = paseo((args) => {
      if (args[0] === "run") return json({ agentId: "agent-blocked", status: "running" });
      if (args[0] === "wait") return json({ status: "permission" });
      if (args[0] === "logs") return { status: 0, stdout: "[Shell] git status", stderr: "", error: null };
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });
    spawn(backend, "exec-blocked-wait");

    const waited = backend.wait("exec-blocked-wait");

    expect(waited.status).toBe("failed");
    expect(waited.error.message).toContain("permission prompt");
  });

  /**
   * `wait` read the transcript and `status` did not, so a caller who polled after waiting
   * watched the output it had already been handed disappear.
   */
  it("Paseo returns the transcript from status, not only from wait", () => {
    const backend = paseo((args) => {
      if (args[0] === "run") return json({ agentId: "agent-logs", status: "running" });
      if (args[0] === "inspect") return json({ status: "running" });
      if (args[0] === "logs") return { status: 0, stdout: "[Read] src/index.ts\n", stderr: "", error: null };
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });
    spawn(backend, "exec-logs");

    expect(backend.status("exec-logs").output).toBe("[Read] src/index.ts");
  });

  /**
   * Losing the transcript must not cost the caller what an earlier `wait` already stored.
   */
  it("Paseo falls back to the stored transcript when Paseo cannot produce logs", () => {
    const rows = state();
    const backend = paseo((args) => {
      if (args[0] === "run") return json({ agentId: "agent-fallback", status: "running" });
      if (args[0] === "inspect") return json({ status: "running" });
      if (args[0] === "logs") return { status: 1, stdout: "", stderr: "log stream gone", error: null };
      throw new Error(`unexpected command: ${args.join(" ")}`);
    }, rows);
    spawn(backend, "exec-fallback");
    rows.update("exec-fallback", { output: "[Read] earlier.ts" });

    expect(backend.status("exec-fallback").output).toBe("[Read] earlier.ts");
  });

  it("delegated backends do not import registry, memory, policy, or identity builders", async () => {
    for (const file of [
      "scripts/lib/delegation/backends/paseo/backend.cjs",
    ]) {
      const source = await readFile(join(process.cwd(), file), "utf8");
      expect(source).not.toMatch(/loadout|codex-profile|context-builder|agent-registry|memory-service|policy-engine/i);
    }
  });
});

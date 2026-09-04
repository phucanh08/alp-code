import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTemporary } from "../support/temporary-root";

const HOOK = join(process.cwd(), "hooks", "compact-record.cjs");

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => removeTemporary(root))));

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
}

async function fixture(): Promise<{ root: string; journal: string; checkpoint: string; continuity: string }> {
  const root = await mkdtemp(join(tmpdir(), "alp-compact-record-"));
  roots.push(root);
  const journal = join(root, "compact-events.jsonl");
  const checkpoint = join(root, "checkpoint.json");
  const continuity = join(root, "continuity.md");
  await writeFile(checkpoint, "{}\n");
  await writeFile(continuity, "# continuity\n");
  return { root, journal, checkpoint, continuity };
}

/**
 * Drives the hook the way a real runtime does: a child process fed its payload on stdin.
 * Uses `spawn` with a manual write-then-end rather than `execFile`'s `input` convenience —
 * the latter hangs a synchronous `readFileSync(0)` child on this platform, while a plain
 * piped stdin stream does not.
 */
function record(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  stdin: string,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK, ...args], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout }));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

async function journalLines(path: string): Promise<readonly Record<string, unknown>[]> {
  const raw = await readFile(path, "utf8").catch(() => "");
  return raw.split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
}

describe("compact-record hook", () => {
  it("appends exactly one line for a valid payload", async () => {
    const { journal } = await fixture();
    const result = await record(
      ["pre", "claude"],
      { ALP_DELEGATION_EXECUTION_ID: "exec_abc123", ALP_POLICY_HASH: "policy-hash", ALP_COMPACT_EVENTS: journal },
      JSON.stringify({ session_id: "sess-1", trigger: "manual", prompt_id: "prompt-1" }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    const lines = await journalLines(journal);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      v: 1,
      executionId: "exec_abc123",
      policyHash: "policy-hash",
      runtime: "claude",
      phase: "pre",
      source: { session_id: "sess-1", trigger: "manual", prompt_id: "prompt-1" },
    });
  });

  it("records a parse error without the content that failed to parse", async () => {
    const { journal } = await fixture();
    const result = await record(
      ["post", "codex"],
      { ALP_DELEGATION_EXECUTION_ID: "exec_abc123", ALP_POLICY_HASH: "policy-hash", ALP_COMPACT_EVENTS: journal },
      "{ not json, and this text must never reach disk }",
    );

    expect(result.exitCode).toBe(0);
    const lines = await journalLines(journal);
    expect(lines).toHaveLength(1);
    expect(lines[0].source).toHaveProperty("parseError");
    expect(JSON.stringify(lines[0])).not.toContain("must never reach disk");
  });

  it("rejects stdin over 1 MiB without leaking it, and still exits clean", async () => {
    const { journal } = await fixture();
    const oversized = "x".repeat(1024 * 1024 + 1);
    const result = await record(
      ["pre", "claude"],
      { ALP_DELEGATION_EXECUTION_ID: "exec_abc123", ALP_POLICY_HASH: "policy-hash", ALP_COMPACT_EVENTS: journal },
      oversized,
    );

    expect(result.exitCode).toBe(0);
    const lines = await journalLines(journal);
    expect(lines).toHaveLength(1);
    expect(lines[0].source).toMatchObject({ parseError: expect.stringContaining("1 MiB") });
    expect(JSON.stringify(lines[0]).length).toBeLessThan(1024);
  });

  it("stays silent when the execution ID is missing — a native, non-ALP launch", async () => {
    const { journal } = await fixture();
    const result = await record(
      ["pre", "claude"],
      { ALP_POLICY_HASH: "policy-hash", ALP_COMPACT_EVENTS: journal },
      "{}",
    );

    expect(result.exitCode).toBe(0);
    expect(await journalLines(journal)).toHaveLength(0);
  });

  it("stays silent when the execution ID fails the regex", async () => {
    const { journal } = await fixture();
    const result = await record(
      ["pre", "claude"],
      { ALP_DELEGATION_EXECUTION_ID: "../not-an-id", ALP_POLICY_HASH: "policy-hash", ALP_COMPACT_EVENTS: journal },
      "{}",
    );

    expect(result.exitCode).toBe(0);
    expect(await journalLines(journal)).toHaveLength(0);
  });

  it("exits clean when the journal path cannot be written", async () => {
    const { root } = await fixture();
    // A journal whose parent directory does not exist at all — the hook never creates
    // directories (invariant 4: append-only, nothing else) — is unwritable on every platform,
    // unlike a chmod'd directory which Windows does not enforce the same way.
    const unwritable = join(root, "missing-parent", "compact-events.jsonl");

    const result = await record(
      ["pre", "claude"],
      { ALP_DELEGATION_EXECUTION_ID: "exec_abc123", ALP_POLICY_HASH: "policy-hash", ALP_COMPACT_EVENTS: unwritable },
      "{}",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("never touches checkpoint.json or continuity.md", async () => {
    const { journal, checkpoint, continuity } = await fixture();
    const beforeCheckpoint = await readFile(checkpoint, "utf8");
    const beforeContinuity = await readFile(continuity, "utf8");

    await record(
      ["post", "claude"],
      { ALP_DELEGATION_EXECUTION_ID: "exec_abc123", ALP_POLICY_HASH: "policy-hash", ALP_COMPACT_EVENTS: journal },
      JSON.stringify({ session_id: "sess-1" }),
    );

    expect(await readFile(checkpoint, "utf8")).toBe(beforeCheckpoint);
    expect(await readFile(continuity, "utf8")).toBe(beforeContinuity);
  });

  it("keeps both lines intact when two hook processes append concurrently", async () => {
    const { journal } = await fixture();
    const env = { ALP_DELEGATION_EXECUTION_ID: "exec_abc123", ALP_POLICY_HASH: "policy-hash", ALP_COMPACT_EVENTS: journal };

    await Promise.all([
      record(["pre", "claude"], env, JSON.stringify({ session_id: "sess-a", prompt_id: "a" })),
      record(["pre", "claude"], env, JSON.stringify({ session_id: "sess-b", prompt_id: "b" })),
    ]);

    const lines = await journalLines(journal);
    expect(lines).toHaveLength(2);
    const promptIds = lines.map((line) => (line.source as Record<string, unknown>).prompt_id).sort();
    expect(promptIds).toEqual(["a", "b"]);
  });

  it("drops unknown fields and never carries compact_summary", async () => {
    const { journal } = await fixture();
    await record(
      ["post", "claude"],
      { ALP_DELEGATION_EXECUTION_ID: "exec_abc123", ALP_POLICY_HASH: "policy-hash", ALP_COMPACT_EVENTS: journal },
      JSON.stringify({
        session_id: "sess-1",
        trigger: "manual",
        compact_summary: "x".repeat(20_000),
        custom_instructions: "secret plan",
        transcript_path: "/should/not/appear",
      }),
    );

    const lines = await journalLines(journal);
    const source = lines[0].source as Record<string, unknown>;
    expect(source).not.toHaveProperty("compact_summary");
    expect(source).not.toHaveProperty("custom_instructions");
    expect(source).not.toHaveProperty("transcript_path");
  });

  it("exits 0 with empty stdout on the happy path and on every failure branch", async () => {
    const { journal } = await fixture();
    const cases: Array<[readonly string[], NodeJS.ProcessEnv, string]> = [
      [["pre", "claude"], { ALP_DELEGATION_EXECUTION_ID: "exec_abc123", ALP_POLICY_HASH: "h", ALP_COMPACT_EVENTS: journal }, "{}"],
      [["pre", "claude"], {}, "{}"],
      [["bogus", "claude"], { ALP_DELEGATION_EXECUTION_ID: "exec_abc123", ALP_POLICY_HASH: "h", ALP_COMPACT_EVENTS: journal }, "{}"],
      [["pre", "bogus-runtime"], { ALP_DELEGATION_EXECUTION_ID: "exec_abc123", ALP_POLICY_HASH: "h", ALP_COMPACT_EVENTS: journal }, "{}"],
    ];
    for (const [args, env, stdin] of cases) {
      const result = await record(args, env, stdin);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    }
  });
});

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeId } from "../../src/agents/types";
import {
  collectExecutionEvidence,
  EvidenceError,
  evidenceFile,
  type CollectedEvidence,
  type EvidenceCollectorDependencies,
  type EvidenceItem,
  type GitBaselineV1,
  type VerifyRun,
} from "../../src/execution/evidence";
import { executionArtifactPaths } from "../../src/execution/execution-store";
import { ExecutionGraphService, type ChildRequest, type ExecutionBinding } from "../../src/execution/graph/execution-graph-service";
import { FileExecutionGraphStore } from "../../src/execution/graph/file-execution-graph-store";
import { capabilitiesFor, type RuntimeEnforcementCapabilitiesV1 } from "../../src/runtime/capabilities";
import { REDACTED } from "../../src/thread/history-redact";
import { HistoryBridgeRegistry, type RuntimeHistoryBridge } from "../../src/thread/history-bridge";
import type { CollectDeltaInput } from "../../src/thread/history-bridge";
import type { HistoryDelta } from "../../src/thread/history-types";
import { removeTemporary } from "../support/temporary-root";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTemporary(root))); });

const CLAUDE = capabilitiesFor("claude", "darwin");
const CLAUDE_WIN = capabilitiesFor("claude", "win32");
const CODEX = capabilitiesFor("codex", "linux");
/** A launched version the measured table applies to. */
const matching = (enforcement: RuntimeEnforcementCapabilitiesV1) => `${enforcement.measuredOn.runtimeVersion}.0`;

interface PolicyOverrides {
  readonly workspace?: string;
  readonly workspaceMode?: "read-only" | "workspace-write";
  readonly writeScope?: readonly string[] | null;
  readonly enforcement?: RuntimeEnforcementCapabilitiesV1;
  readonly runtime?: RuntimeId;
}

/**
 * A real tree on disk with a read-only `main` root standing in `<root>/ws`, plus the
 * `policy.json`/`context/` files a real `materialize()` leaves — the collector reads those,
 * not the graph, for workspace, scope and enforcement.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "alp-evidence-"));
  roots.push(root);
  const workspace = join(root, "ws");
  await mkdir(join(workspace, "src"), { recursive: true });
  const executionsRoot = join(root, "executions");
  const clock = { at: Date.parse("2026-09-17T10:00:00.000Z") };
  const now = () => new Date(clock.at);
  const graph = new ExecutionGraphService({ store: new FileExecutionGraphStore({ root: join(root, "execution-graphs") }), now });
  const main = await graph.createRoot({ agentId: "main", thread: null, executionId: "exec_root" });

  async function writePolicy(executionId: string, overrides: PolicyOverrides = {}) {
    const paths = executionArtifactPaths(executionsRoot, executionId);
    await mkdir(paths.contextDirectory, { recursive: true });
    const enforcement = overrides.enforcement ?? CLAUDE;
    await writeFile(paths.policyFile, JSON.stringify({
      executionId,
      workspace: overrides.workspace ?? workspace,
      workspaceMode: overrides.workspaceMode ?? "workspace-write",
      writeScope: overrides.writeScope === undefined ? null : overrides.writeScope,
      runtime: overrides.runtime ?? enforcement.runtime,
      enforcement,
    }));
    await writeFile(paths.stateFile, JSON.stringify({ executionId, status: "prepared" }));
  }
  async function writeLaunch(executionId: string, runtimeVersion: string) {
    const paths = executionArtifactPaths(executionsRoot, executionId);
    await writeFile(join(paths.contextDirectory, "launch.json"), JSON.stringify({
      version: 1, executionId, runtime: "claude", runtimeVersion, platform: "darwin",
      authMethod: "unknown", credentialConfigured: false, launchSpecDigest: "d", launchedAt: now().toISOString(),
    }));
  }
  async function writeBaseline(executionId: string, baseline: GitBaselineV1 | null) {
    const paths = executionArtifactPaths(executionsRoot, executionId);
    await writeFile(join(paths.contextDirectory, "baseline.json"), JSON.stringify({ version: 1, capturedAt: now().toISOString(), baseline }));
  }
  async function writeOutput(executionId: string, output: unknown) {
    const paths = executionArtifactPaths(executionsRoot, executionId);
    await writeFile(paths.stateFile, JSON.stringify({ executionId, status: "completed", output }));
  }
  await writePolicy("exec_root", { workspaceMode: "read-only", writeScope: null });

  async function child(executionId: string, options: PolicyOverrides & { readonly requiredEvidence?: readonly string[]; readonly parent?: ExecutionBinding } = {}): Promise<ExecutionBinding> {
    const request: ChildRequest = {
      requestId: `req_${executionId}`,
      agentId: "worker",
      task: "do it",
      workspace: options.workspace ?? workspace,
      workspaceMode: options.workspaceMode ?? "workspace-write",
      writeScope: options.writeScope === undefined ? null : options.writeScope,
      mode: "medium",
      background: false,
      interactive: false,
      timeoutMs: null,
      metadata: {},
      ...(options.requiredEvidence === undefined ? {} : { requiredEvidence: options.requiredEvidence }),
    };
    const reserved = await graph.reserveChild(options.parent ?? main.binding, request, { executionId });
    if (reserved.kind !== "reserved") throw new Error("expected a fresh reservation");
    await graph.startReservedChild(reserved, async () => undefined);
    await writePolicy(executionId, options);
    return reserved.binding;
  }
  async function finish(binding: ExecutionBinding, status: "completed" | "failed" | "cancelled" | "interrupted" = "completed") {
    await graph.finishExecution(binding, { status });
  }
  const tick = (ms: number) => { clock.at += ms; };

  return { root, workspace, executionsRoot, graph, main, clock, now, tick, writePolicy, writeLaunch, writeBaseline, writeOutput, child, finish };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function fakeBridge(runtime: RuntimeId, delta: Partial<HistoryDelta>): RuntimeHistoryBridge & { readonly calls: CollectDeltaInput[] } {
  const calls: CollectDeltaInput[] = [];
  return {
    runtime,
    calls,
    probe: async () => ({ completeness: "complete", pinnedVersion: "2.1" }),
    collectDelta: async (input) => {
      calls.push(input);
      return { entries: [], cursor: { transcriptPath: "/t", lineOffset: 3, lastNativeId: "a1" }, completeness: "complete", pinnedVersion: "2.1", skipped: 0, ...delta };
    },
  };
}

interface DepsOptions {
  readonly current?: GitBaselineV1;
  readonly changedBetween?: readonly string[];
  readonly bridges?: readonly RuntimeHistoryBridge[];
  readonly run?: VerifyRun | ((commandId: string) => VerifyRun);
  readonly commands?: readonly { id: string; run: string; timeoutMs?: number; cwd?: string }[];
  readonly trusted?: boolean;
}

function deps(fx: Fixture, options: DepsOptions = {}) {
  const captures: string[] = [];
  const verifierCalls: Parameters<EvidenceCollectorDependencies["verifier"]>[] = [];
  const value: EvidenceCollectorDependencies = {
    executionsRoot: fx.executionsRoot,
    graph: fx.graph,
    history: new HistoryBridgeRegistry(options.bridges ?? []),
    baseline: {
      capture: async (workspace) => { captures.push(workspace); return options.current ?? { version: 1, head: "aaa", dirty: [] }; },
      changedBetween: async () => options.changedBetween ?? [],
    },
    verifier: async (...call) => {
      verifierCalls.push(call);
      const run = options.run ?? { kind: "ran", exitCode: 0, durationMs: 5, tail: "ok\n" };
      return typeof run === "function" ? run(call[0].id) : run;
    },
    verifySettings: async (workspace) => {
      const commands = (options.commands ?? []).map((command) => ({ timeoutMs: 600000, cwd: ".", ...command }));
      return { project: workspace, commands, digest: commands.length ? "digest-1" : null };
    },
    verifyTrusted: () => options.trusted ?? false,
    now: fx.now,
  };
  return { value, captures, verifierCalls };
}

const itemsOf = (collected: CollectedEvidence, kind: EvidenceItem["kind"]) => collected.evidence.items.filter((item) => item.kind === kind);
const changeOf = (collected: CollectedEvidence, source: "git" | "history-bridge") =>
  collected.evidence.items.find((item): item is Extract<EvidenceItem, { kind: "change" }> => item.kind === "change" && item.source === source);

/**
 * Oracle: P3 spec — "Producers (1)": the git producer diffs the settle-time status against
 * the baseline `materialize()` captured; `outsideScope` is the changed paths not under the
 * scope; `outsideScopeVerified` is true only when the runtime enforces the scope. Provenance
 * per the table: observed only with no overlap and enforced write isolation, on the measured
 * version.
 */
describe("collectExecutionEvidence — git change", () => {
  it("names the files the child changed, inside and outside its scope, as observed", async () => {
    const fx = await fixture();
    const scope = join(fx.workspace, "src");
    const binding = await fx.child("exec_a", { writeScope: [scope] });
    await fx.writeLaunch("exec_a", matching(CLAUDE));
    await fx.writeBaseline("exec_a", { version: 1, head: "aaa", dirty: [{ path: join(fx.workspace, "notes.md"), status: " M", contentHash: "h" }] });
    fx.tick(60_000);
    await fx.finish(binding);
    const d = deps(fx, {
      current: { version: 1, head: "aaa", dirty: [
        { path: join(fx.workspace, "notes.md"), status: " M", contentHash: "h" },
        { path: join(fx.workspace, "src", "a.ts"), status: "??", contentHash: "h1" },
        { path: join(fx.workspace, "docs.md"), status: "??", contentHash: "h2" },
      ] },
    });
    const collected = await collectExecutionEvidence({ executionId: "exec_a" }, d.value);
    expect(d.captures).toEqual([fx.workspace]);
    expect(changeOf(collected, "git")).toEqual({
      kind: "change",
      provenance: "observed",
      source: "git",
      paths: [join(fx.workspace, "docs.md"), join(fx.workspace, "src", "a.ts")],
      commit: null,
      outsideScope: [join(fx.workspace, "docs.md")],
      // Claude on darwin measures `writeScope: partial`: what lies outside is not proven refused.
      outsideScopeVerified: false,
      ambiguousWith: [],
    });
    expect(collected.evidence).toMatchObject({ version: 1, executionId: "exec_a", requestId: "req_exec_a", collectedAt: fx.now().toISOString() });
    expect(collected.evidence.digest).toMatch(/^[0-9a-f]{64}$/);
    // Written, atomically, beside `policy.json` — never under the workspace or the Thread.
    expect(JSON.parse(await readFile(evidenceFile(fx.executionsRoot, "exec_a"), "utf8"))).toEqual(collected.evidence);
  });

  it("verifies the scope only for a runtime that enforces it", async () => {
    const fx = await fixture();
    const binding = await fx.child("exec_a", { writeScope: [join(fx.workspace, "src")], enforcement: CODEX });
    await fx.writeBaseline("exec_a", { version: 1, head: null, dirty: [] });
    await fx.finish(binding);
    const collected = await collectExecutionEvidence({ executionId: "exec_a" }, deps(fx, { current: { version: 1, head: null, dirty: [{ path: join(fx.workspace, "x"), status: "??", contentHash: "h" }] } }).value);
    expect(changeOf(collected, "git")).toMatchObject({ outsideScope: [join(fx.workspace, "x")], outsideScopeVerified: true });
  });

  it("is unknown without a baseline, and without a git repo — and never captures then", async () => {
    const fx = await fixture();
    const a = await fx.child("exec_a");
    const b = await fx.child("exec_b");
    await fx.writeBaseline("exec_b", null);
    await fx.finish(a);
    await fx.finish(b);
    const d = deps(fx);
    for (const executionId of ["exec_a", "exec_b"]) {
      const collected = await collectExecutionEvidence({ executionId }, d.value);
      expect(changeOf(collected, "git")).toMatchObject({ provenance: "unknown", paths: [], commit: null, outsideScope: [] });
    }
    expect(d.captures).toEqual([]);
  });

  it("is derived when the runtime does not enforce write isolation, or ran another version", async () => {
    const fx = await fixture();
    const cases: readonly { readonly id: string; readonly enforcement?: typeof CLAUDE_WIN; readonly launch: string | null }[] = [
      { id: "exec_win", enforcement: CLAUDE_WIN, launch: matching(CLAUDE_WIN) },
      { id: "exec_other", launch: "9.9.9" },
      { id: "exec_none", launch: null },
    ];
    // One at a time, a second apart: no two ever overlap, so `derived` below can only come
    // from the case's own cause — the platform, the version, or the missing receipt.
    for (const entry of cases) {
      const binding = await fx.child(entry.id, entry.enforcement ? { enforcement: entry.enforcement } : {});
      if (entry.launch !== null) await fx.writeLaunch(entry.id, entry.launch);
      await fx.writeBaseline(entry.id, { version: 1, head: "aaa", dirty: [] });
      fx.tick(1_000);
      await fx.finish(binding);
      fx.tick(1_000);
      const collected = await collectExecutionEvidence({ executionId: entry.id }, deps(fx, { current: { version: 1, head: "bbb", dirty: [] }, changedBetween: [join(fx.workspace, "a")] }).value);
      const change = changeOf(collected, "git");
      expect(change?.provenance).toBe("derived");
      expect(change?.ambiguousWith).toEqual([]);
    }
  });

  it("reports the commit and committed files when HEAD moved", async () => {
    const fx = await fixture();
    const binding = await fx.child("exec_a");
    await fx.writeBaseline("exec_a", { version: 1, head: "aaa", dirty: [] });
    await fx.finish(binding);
    const collected = await collectExecutionEvidence({ executionId: "exec_a" }, deps(fx, { current: { version: 1, head: "bbb", dirty: [] }, changedBetween: [join(fx.workspace, "src", "a.ts")] }).value);
    expect(changeOf(collected, "git")).toMatchObject({ paths: [join(fx.workspace, "src", "a.ts")], commit: "bbb" });
  });
});

/**
 * Oracle: spec "Overlap" + adversarial row "ancestors count too" — a sibling writing the same
 * workspace at the same time makes the change ambiguous and lowers it to `derived`; a
 * sandboxed read-only root does not; a Windows root does.
 */
describe("collectExecutionEvidence — overlap", () => {
  it("names a parallel sibling writer and drops to derived; a sandboxed read-only root is not named", async () => {
    const fx = await fixture();
    const a = await fx.child("exec_a", { writeScope: [join(fx.workspace, "src")] });
    await fx.writeLaunch("exec_a", matching(CLAUDE));
    await fx.writeBaseline("exec_a", { version: 1, head: "aaa", dirty: [] });
    fx.tick(1000);
    const b = await fx.child("exec_b");
    fx.tick(1000);
    await fx.finish(a);
    const collected = await collectExecutionEvidence({ executionId: "exec_a" }, deps(fx, { current: { version: 1, head: "aaa", dirty: [{ path: join(fx.workspace, "src", "a.ts"), status: "??", contentHash: "h" }] } }).value);
    expect(changeOf(collected, "git")).toMatchObject({ provenance: "derived", ambiguousWith: ["exec_b"] });
    await fx.finish(b);
  });

  it("does not name a sibling that finished before C started, nor one in a disjoint sandboxed scope", async () => {
    const fx = await fixture();
    const early = await fx.child("exec_early");
    fx.tick(1000);
    await fx.finish(early);
    fx.tick(1000);
    const a = await fx.child("exec_a", { writeScope: [join(fx.workspace, "src")] });
    await fx.writeLaunch("exec_a", matching(CLAUDE));
    await fx.writeBaseline("exec_a", { version: 1, head: "aaa", dirty: [] });
    await mkdir(join(fx.workspace, "docs"), { recursive: true });
    const docs = await fx.child("exec_docs", { writeScope: [join(fx.workspace, "docs")], enforcement: CODEX });
    fx.tick(1000);
    await fx.finish(a);
    const collected = await collectExecutionEvidence({ executionId: "exec_a" }, deps(fx, { current: { version: 1, head: "aaa", dirty: [{ path: join(fx.workspace, "src", "a.ts"), status: "??", contentHash: "h" }] } }).value);
    expect(changeOf(collected, "git")).toMatchObject({ provenance: "observed", ambiguousWith: [] });
    await fx.finish(docs);
  });

  it("names a root whose runtime does not sandbox, even though it is read-only", async () => {
    const fx = await fixture();
    await fx.writePolicy("exec_root", { workspaceMode: "read-only", writeScope: null, enforcement: CLAUDE_WIN });
    const a = await fx.child("exec_a");
    await fx.writeLaunch("exec_a", matching(CLAUDE));
    await fx.writeBaseline("exec_a", { version: 1, head: "aaa", dirty: [] });
    await fx.finish(a);
    const collected = await collectExecutionEvidence({ executionId: "exec_a" }, deps(fx, { current: { version: 1, head: "aaa", dirty: [{ path: join(fx.workspace, "a"), status: "??", contentHash: "h" }] } }).value);
    expect(changeOf(collected, "git")).toMatchObject({ provenance: "derived", ambiguousWith: ["exec_root"] });
  });
});

/**
 * Oracle: spec "Producers (2)" — the bridge's delta on the child goes under the child's own
 * `context/history/`, never into the Thread; tool calls and write tool calls become items;
 * `complete` ⇒ observed, `partial` ⇒ derived, no bridge ⇒ `unsupported`, no throw.
 */
describe("collectExecutionEvidence — history bridge", () => {
  it("collects on the child and mirrors under its context, as observed when complete", async () => {
    const fx = await fixture();
    const binding = await fx.child("exec_a", { writeScope: [join(fx.workspace, "src")] });
    await fx.writeLaunch("exec_a", matching(CLAUDE));
    await fx.finish(binding);
    const bridge = fakeBridge("claude", {
      entries: [
        { kind: "tool", nativeId: "a1", createdAt: "2026-09-17T10:00:01.000Z", name: "Write", callId: "toolu_1", summary: "Write /ws/src/a.ts", isError: false, artifact: null },
        { kind: "change", nativeId: "a1", createdAt: "2026-09-17T10:00:01.000Z", workspace: fx.workspace, paths: [join(fx.workspace, "src", "a.ts"), join(fx.workspace, "README.md")], commit: null, artifact: null },
        { kind: "assistant", nativeId: "a2", createdAt: "2026-09-17T10:00:02.000Z", text: "done" },
      ],
    });
    const collected = await collectExecutionEvidence({ executionId: "exec_a" }, deps(fx, { bridges: [bridge] }).value);
    const context = executionArtifactPaths(fx.executionsRoot, "exec_a").contextDirectory;
    expect(bridge.calls).toEqual([{ execution: { executionId: "exec_a", runtime: "claude", workspace: fx.workspace, contextDirectory: context }, cursor: null }]);
    expect(collected.evidence.completeness).toBe("complete");
    expect(itemsOf(collected, "tool-call")).toEqual([{
      kind: "tool-call", provenance: "observed", source: "history-bridge",
      ref: { kind: "tool", nativeId: "a1", createdAt: "2026-09-17T10:00:01.000Z", name: "Write", callId: "toolu_1", summary: "Write /ws/src/a.ts", isError: false, artifact: null },
    }]);
    expect(changeOf(collected, "history-bridge")).toEqual({
      kind: "change", provenance: "observed", source: "history-bridge",
      paths: [join(fx.workspace, "src", "a.ts"), join(fx.workspace, "README.md")], commit: null,
      outsideScope: [join(fx.workspace, "README.md")], outsideScopeVerified: false, ambiguousWith: [],
    });
    const entries = JSON.parse(await readFile(join(context, "history", "entries.json"), "utf8"));
    expect(entries).toHaveLength(3);
    expect(JSON.parse(await readFile(join(context, "history", "cursor.json"), "utf8"))).toEqual({ transcriptPath: "/t", lineOffset: 3, lastNativeId: "a1" });
    // Nothing of the Thread's: no `messages/` anywhere near the execution.
    await expect(stat(join(context, "messages"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("is derived when partial, and lowered when the runtime version was not the measured one", async () => {
    const fx = await fixture();
    const a = await fx.child("exec_a");
    await fx.writeLaunch("exec_a", matching(CLAUDE));
    const b = await fx.child("exec_b");
    await fx.writeLaunch("exec_b", "3.0.0");
    await fx.finish(a);
    await fx.finish(b);
    const entries = [{ kind: "tool" as const, nativeId: "a1", createdAt: "2026-09-17T10:00:01.000Z", name: "Read", callId: null, summary: "Read", isError: false, artifact: null }];
    const partial = await collectExecutionEvidence({ executionId: "exec_a" }, deps(fx, { bridges: [fakeBridge("claude", { entries, completeness: "partial" })] }).value);
    expect(partial.evidence.completeness).toBe("partial");
    expect(itemsOf(partial, "tool-call")[0]?.provenance).toBe("derived");
    const mismatched = await collectExecutionEvidence({ executionId: "exec_b" }, deps(fx, { bridges: [fakeBridge("claude", { entries })] }).value);
    expect(itemsOf(mismatched, "tool-call")[0]?.provenance).toBe("derived");
  });

  it("does not throw without a bridge: completeness unsupported, tool calls unknown-free, boundary kept", async () => {
    const fx = await fixture();
    const binding = await fx.child("exec_a");
    await fx.writeLaunch("exec_a", matching(CLAUDE));
    await fx.finish(binding, "failed");
    const collected = await collectExecutionEvidence({ executionId: "exec_a" }, deps(fx).value);
    expect(collected.evidence.completeness).toBe("unsupported");
    expect(itemsOf(collected, "tool-call")).toEqual([]);
    expect(itemsOf(collected, "boundary")).toEqual([{
      kind: "boundary", provenance: "observed", source: "runtime-event",
      ref: expect.objectContaining({ kind: "boundary", outcome: "failed", runtime: "claude", historyCompleteness: "unsupported", collected: 0, skipped: 0 }),
    }]);
  });

  it("survives a bridge that throws: final-only, derived", async () => {
    const fx = await fixture();
    const binding = await fx.child("exec_a");
    await fx.finish(binding);
    const broken: RuntimeHistoryBridge = { runtime: "claude", probe: async () => ({ completeness: "complete", pinnedVersion: "2.1" }), collectDelta: async () => { throw new Error("boom"); } };
    const collected = await collectExecutionEvidence({ executionId: "exec_a" }, deps(fx, { bridges: [broken] }).value);
    expect(collected.evidence.completeness).toBe("final-only");
  });
});

/**
 * Oracle: spec "Producers (3)" and "Evaluator" — a required `verify:<id>` runs only when the
 * project's verify block is trusted; otherwise `verify-skipped: untrusted` and the evaluation
 * is unknown. The command runs in the child's workspace with a minimal env; a non-zero exit
 * is `unsatisfied`; a timeout is `verify-skipped: timeout`; an id the settings do not name is
 * `not-configured`. The tail is redacted and capped at 4 KB.
 */
describe("collectExecutionEvidence — verify", () => {
  const TEST = { id: "test", run: "npm test", timeoutMs: 1234 };

  it("skips an untrusted block as unknown, without running anything", async () => {
    const fx = await fixture();
    const binding = await fx.child("exec_a", { requiredEvidence: ["verify:test"] });
    await fx.finish(binding);
    const d = deps(fx, { commands: [TEST], trusted: false });
    const collected = await collectExecutionEvidence({ executionId: "exec_a" }, d.value);
    expect(d.verifierCalls).toEqual([]);
    expect(itemsOf(collected, "verify-skipped")).toEqual([{ kind: "verify-skipped", provenance: "unknown", source: "alp-verifier", commandId: "test", reason: "untrusted" }]);
    expect(collected).toMatchObject({ required: ["verify:test"], evaluation: "unknown", missing: [] });
  });

  it("runs a trusted command in the workspace with only PATH and HOME, and judges the exit code", async () => {
    const fx = await fixture();
    const pass = await fx.child("exec_pass", { requiredEvidence: ["verify:test"] });
    const fail = await fx.child("exec_fail", { requiredEvidence: ["verify:test"] });
    await fx.finish(pass);
    await fx.finish(fail);
    const ok = deps(fx, { commands: [TEST], trusted: true, run: { kind: "ran", exitCode: 0, durationMs: 42, tail: "all green\ntoken=abcdefgh12345678\n" } });
    const passed = await collectExecutionEvidence({ executionId: "exec_pass" }, ok.value);
    expect(ok.verifierCalls).toHaveLength(1);
    const [command, options] = ok.verifierCalls[0];
    expect(command).toEqual({ id: "test", run: "npm test", timeoutMs: 1234, cwd: "." });
    expect(options.cwd).toBe(fx.workspace);
    expect(Object.keys(options.env).sort()).toEqual(["HOME", "PATH"]);
    expect(options.timeoutMs).toBe(1234);
    const item = itemsOf(passed, "verify")[0] as Extract<EvidenceItem, { kind: "verify" }>;
    expect(item).toMatchObject({ provenance: "observed", source: "alp-verifier", commandId: "test", exitCode: 0, durationMs: 42, ambiguousWith: [] });
    expect(item.commandDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(item.tail).toContain(REDACTED);
    expect(item.tail).not.toContain("abcdefgh12345678");
    expect(passed).toMatchObject({ evaluation: "satisfied", missing: [] });

    const failed = await collectExecutionEvidence({ executionId: "exec_fail" }, deps(fx, { commands: [TEST], trusted: true, run: { kind: "ran", exitCode: 1, durationMs: 1, tail: "1 failed" } }).value);
    expect(itemsOf(failed, "verify")[0]).toMatchObject({ exitCode: 1 });
    expect(failed).toMatchObject({ evaluation: "unsatisfied", missing: ["verify:test"] });
  });

  it("caps the tail at 4 KB", async () => {
    const fx = await fixture();
    const binding = await fx.child("exec_a", { requiredEvidence: ["verify:test"] });
    await fx.finish(binding);
    const collected = await collectExecutionEvidence({ executionId: "exec_a" }, deps(fx, { commands: [TEST], trusted: true, run: { kind: "ran", exitCode: 0, durationMs: 1, tail: "x".repeat(10_000) } }).value);
    expect(Buffer.byteLength((itemsOf(collected, "verify")[0] as Extract<EvidenceItem, { kind: "verify" }>).tail, "utf8")).toBeLessThanOrEqual(4096);
  });

  it("records a timeout and an unconfigured id as skipped, unknown", async () => {
    const fx = await fixture();
    const binding = await fx.child("exec_a", { requiredEvidence: ["verify:lint", "verify:test"] });
    await fx.finish(binding);
    const collected = await collectExecutionEvidence({ executionId: "exec_a" }, deps(fx, { commands: [TEST], trusted: true, run: { kind: "timeout" } }).value);
    expect(itemsOf(collected, "verify-skipped")).toEqual([
      { kind: "verify-skipped", provenance: "unknown", source: "alp-verifier", commandId: "lint", reason: "not-configured" },
      { kind: "verify-skipped", provenance: "unknown", source: "alp-verifier", commandId: "test", reason: "timeout" },
    ]);
    expect(collected.evaluation).toBe("unknown");
  });

  it("runs nothing that was not required, even when configured and trusted", async () => {
    const fx = await fixture();
    const binding = await fx.child("exec_a");
    await fx.finish(binding);
    const d = deps(fx, { commands: [TEST], trusted: true });
    const collected = await collectExecutionEvidence({ executionId: "exec_a" }, d.value);
    expect(d.verifierCalls).toEqual([]);
    expect(itemsOf(collected, "verify")).toEqual([]);
    expect(collected).toMatchObject({ required: [], evaluation: "satisfied" });
  });

  it("names the executions active while the command ran", async () => {
    const fx = await fixture();
    const a = await fx.child("exec_a", { requiredEvidence: ["verify:test"] });
    await fx.finish(a);
    const b = await fx.child("exec_b");
    const collected = await collectExecutionEvidence({ executionId: "exec_a" }, deps(fx, { commands: [TEST], trusted: true }).value);
    expect(itemsOf(collected, "verify")[0]).toMatchObject({ ambiguousWith: ["exec_b"] });
    await fx.finish(b);
  });
});

describe("collectExecutionEvidence — output and requirements", () => {
  it("records the self-reported output by digest, which satisfies nothing", async () => {
    const fx = await fixture();
    const binding = await fx.child("exec_a", { requiredEvidence: ["change"] });
    await fx.writeOutput("exec_a", "all done");
    await fx.finish(binding);
    const collected = await collectExecutionEvidence({ executionId: "exec_a" }, deps(fx).value);
    expect(itemsOf(collected, "output")).toEqual([{ kind: "output", provenance: "self-reported", source: "agent-output", digest: createHash("sha256").update("all done", "utf8").digest("hex") }]);
    // `change` is unknown here (no baseline) — not missing — so the answer is unknown, not unsatisfied.
    expect(collected).toMatchObject({ required: ["change"], evaluation: "unknown", missing: [] });
  });

  it("refuses to collect on an execution that has not ended", async () => {
    const fx = await fixture();
    await fx.child("exec_a");
    await expect(collectExecutionEvidence({ executionId: "exec_a" }, deps(fx).value)).rejects.toMatchObject({ code: "EXECUTION_NOT_TERMINAL" });
    await expect(collectExecutionEvidence({ executionId: "exec_a" }, deps(fx).value)).rejects.toBeInstanceOf(EvidenceError);
    await expect(collectExecutionEvidence({ executionId: "exec_nope" }, deps(fx).value)).rejects.toMatchObject({ code: "EXECUTION_NOT_FOUND" });
    await expect(stat(evidenceFile(fx.executionsRoot, "exec_a"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

/**
 * Oracle: spec "Trigger points" — `evidence.json` is idempotent: a second collection returns
 * what is there and re-derives only `unknown` items, so a verify that already ran is never
 * run twice, and an untrusted block that is trusted later fills its gap.
 */
describe("collectExecutionEvidence — idempotence", () => {
  it("does not re-run a verify that already ran, and returns the same digest", async () => {
    const fx = await fixture();
    const binding = await fx.child("exec_a", { requiredEvidence: ["verify:test"] });
    await fx.writeBaseline("exec_a", { version: 1, head: "aaa", dirty: [] });
    await fx.finish(binding);
    const d = deps(fx, { commands: [{ id: "test", run: "npm test" }], trusted: true });
    const first = await collectExecutionEvidence({ executionId: "exec_a" }, d.value);
    const second = await collectExecutionEvidence({ executionId: "exec_a" }, d.value);
    expect(d.verifierCalls).toHaveLength(1);
    expect(d.captures).toHaveLength(1);
    expect(second.evidence).toEqual(first.evidence);
  });

  it("fills an unknown item once its cause is gone, keeping the rest", async () => {
    const fx = await fixture();
    const binding = await fx.child("exec_a", { requiredEvidence: ["verify:test"] });
    await fx.writeBaseline("exec_a", { version: 1, head: "aaa", dirty: [] });
    await fx.writeOutput("exec_a", "done");
    await fx.finish(binding);
    const untrusted = deps(fx, { commands: [{ id: "test", run: "npm test" }], trusted: false });
    const first = await collectExecutionEvidence({ executionId: "exec_a" }, untrusted.value);
    expect(first.evaluation).toBe("unknown");
    const trusted = deps(fx, { commands: [{ id: "test", run: "npm test" }], trusted: true, current: { version: 1, head: "zzz", dirty: [] } });
    const second = await collectExecutionEvidence({ executionId: "exec_a" }, trusted.value);
    expect(trusted.verifierCalls).toHaveLength(1);
    expect(second.evaluation).toBe("satisfied");
    expect(itemsOf(second, "verify-skipped")).toEqual([]);
    expect(itemsOf(second, "verify")).toHaveLength(1);
    // The git change was already derived from the first pass; it is not captured again.
    expect(trusted.captures).toEqual([]);
    expect(changeOf(second, "git")).toEqual(changeOf(first, "git"));
    expect(itemsOf(second, "output")).toEqual(itemsOf(first, "output"));
    expect(JSON.parse(await readFile(evidenceFile(fx.executionsRoot, "exec_a"), "utf8")).digest).toBe(second.evidence.digest);
  });
});

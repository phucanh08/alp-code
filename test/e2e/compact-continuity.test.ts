import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { agentRegistry } from "../../src/agents/registry";
import type { RuntimeId } from "../../src/agents/types";
import { runContextCommand } from "../../src/cli/commands/context";
import { readCheckpoint } from "../../src/context/checkpoint";
import { reduceCompactJournal, replayCompactJournal } from "../../src/context/compact-journal";
import { INTERACTIVE_TASK_SENTINEL } from "../../src/context/continuity";
import type { PreparedExecution } from "../../src/execution/types";
import { cleanupEnvironments, createE2eEnvironment, type CompactFixture, type E2eEnvironment } from "./harness";

afterEach(cleanupEnvironments);

/** Prepares the interactive `main` execution directly, without going through `runMainSession`
 * — so a test can pin decisions between `prepare()` and the runtime launch, which the CLI
 * entrypoint has no seam for. */
async function prepareMain(environment: E2eEnvironment, executionId: string): Promise<PreparedExecution> {
  return environment.executionService.prepare({
    executionId,
    parent: "principal",
    target: "main",
    task: INTERACTIVE_TASK_SENTINEL,
    workspace: environment.project,
    workspaceMode: "workspace-write",
    memoryQueries: [],
    characterBudget: 0,
    invariantContext: "ALP execution policy is authoritative and fails closed.",
    policyContext: "Direct raw runtime launch is unsupported; use ALP workflows.",
  });
}

async function pin(
  environment: E2eEnvironment,
  executionId: string,
  kind: "decision" | "constraint",
  text: string,
): Promise<void> {
  const code = await runContextCommand(["pin", kind, "--", text], {
    executionsRoot: environment.executionsRoot,
    env: { ALP_DELEGATION_EXECUTION_ID: executionId },
    write: () => {},
  });
  expect(code).toBe(0);
}

function fixturesFor(runtime: RuntimeId): readonly CompactFixture[] {
  return runtime === "claude"
    ? [
      { phase: "pre", runtime, payload: { session_id: "sess-e2e", trigger: "manual", prompt_id: "prompt-e2e", compact_summary: null } },
      { phase: "post", runtime, payload: { session_id: "sess-e2e", trigger: "manual", prompt_id: "prompt-e2e", compact_summary: "x".repeat(20_000) } },
    ]
    : [
      { phase: "pre", runtime, payload: { session_id: "sess-e2e", trigger: "manual", turn_id: "turn-e2e" } },
      { phase: "post", runtime, payload: { session_id: "sess-e2e", trigger: "manual", turn_id: "turn-e2e" } },
    ];
}

describe.each([["claude"], ["codex"]] as const)("e2e: compact continuity bridge (%s)", (runtime) => {
  const executionId = `exec_compact_e2e_${runtime}`;

  it("seeds, pins, survives a simulated compaction, and reinjects at the next SessionStart", async () => {
    const environment = await createE2eEnvironment({
      compactBridge: true,
      compactFixtures: fixturesFor(runtime),
    });
    const prepared = await prepareMain(environment, executionId);

    // 1: checkpoint seeded and continuity renderable from the very first session — the
    // interactive sentinel means an empty objective, so continuity is empty until pinned.
    const seeded = await readCheckpoint(prepared.artifacts.checkpointFile, {
      executionId, policyHash: prepared.policy.policyHash,
    });
    expect(seeded).toMatchObject({ ok: true, value: { objective: INTERACTIVE_TASK_SENTINEL, decisions: [], constraints: [] } });

    // 2 (proven by the main e2e suite already, and re-asserted after launch below): no
    // synthetic task ever reaches this launch.

    // 3: principal pins survive independently of any runtime launch.
    await pin(environment, executionId, "decision", "chose the fixture path over a live model");
    await pin(environment, executionId, "constraint", "never replay the native summary");

    // 4 + 5: fixtures dispatch through the real hook, and a second, simulated SessionStart
    // captures what reinjection actually delivers.
    const definition = agentRegistry.get("main");
    const adapter = environment.adapters.get(runtime);
    if (!adapter) throw new Error(`runtime \`${runtime}\` not registered`);
    const launchSpec = await adapter.prepare({
      execution: prepared,
      model: definition.model[runtime],
      reasoningEffort: definition.reasoningEffort[runtime],
      interactive: true,
    });
    const spawned = await environment.backend.spawn({
      executionId,
      launchSpec,
      lifecycle: { requestId: executionId, parentExecutionId: null, background: false, interactive: true, timeoutMs: null },
    });
    const result = spawned.status === "running" ? await environment.backend.wait(executionId) : spawned;
    expect(result.status).toBe("completed");

    const capture = await environment.capture(runtime);
    expect(capture.task).toBeNull();
    expect(capture.argv.some((argument) => argument.includes("task.md"))).toBe(false);
    expect(capture.reinjected).toContain("ALP continuity checkpoint");
    expect(capture.reinjected).toContain("chose the fixture path over a live model");
    expect(capture.reinjected).toContain("never replay the native summary");
    // Session context (identity) still arrives ahead of continuity in the same message.
    expect(capture.reinjected).toContain(capture.sessionContext);

    // 6: exactly one completed compaction, nothing left pending.
    const replay = await replayCompactJournal(prepared.artifacts.compactEventsFile);
    expect(replay.droppedLines).toBe(0);
    const state = reduceCompactJournal(replay.events);
    expect(state.generation).toBe(1);
    expect(state.pending).toBeNull();
    expect(state.lastCompleted).toMatchObject({ runtime, trigger: "manual" });

    // 7: the native summary never reaches anything ALP keeps.
    const journalRaw = await readFile(prepared.artifacts.compactEventsFile, "utf8");
    expect(journalRaw).not.toContain("compact_summary");
    expect(journalRaw.length).toBeLessThan(2000);
    const continuity = await readFile(prepared.artifacts.continuityFile, "utf8");
    expect(continuity).not.toContain("x".repeat(100));
    const checkpointRaw = await readFile(prepared.artifacts.checkpointFile, "utf8");
    expect(checkpointRaw).not.toContain("compact_summary");

    // 8: policy binding is untouched by any of the above.
    const finalCheckpoint = await readCheckpoint(prepared.artifacts.checkpointFile, {
      executionId, policyHash: prepared.policy.policyHash,
    });
    expect(finalCheckpoint).toMatchObject({ ok: true, value: { policyHash: prepared.policy.policyHash } });
  });
});

/**
 * These two exercise paths a synthetic-envelope unit test cannot: the real hook binary
 * appending to a real file, twice in the same session, through the same journal the reducer
 * then replays.
 */
describe("e2e: compact continuity failure modes", () => {
  it("counts two consecutive compactions as generation 2 with nothing left pending", async () => {
    const executionId = "exec_compact_e2e_twice";
    const fixtures: CompactFixture[] = [
      { phase: "pre", runtime: "claude", payload: { session_id: "sess-e2e", trigger: "manual", prompt_id: "prompt-1" } },
      { phase: "post", runtime: "claude", payload: { session_id: "sess-e2e", trigger: "manual", prompt_id: "prompt-1" } },
      { phase: "pre", runtime: "claude", payload: { session_id: "sess-e2e", trigger: "auto", prompt_id: "prompt-2" } },
      { phase: "post", runtime: "claude", payload: { session_id: "sess-e2e", trigger: "auto", prompt_id: "prompt-2" } },
    ];
    const environment = await createE2eEnvironment({ compactBridge: true, compactFixtures: fixtures });
    const prepared = await prepareMain(environment, executionId);
    const definition = agentRegistry.get("main");
    const adapter = environment.adapters.get("claude");
    if (!adapter) throw new Error("claude adapter not registered");
    const launchSpec = await adapter.prepare({
      execution: prepared, model: definition.model.claude, reasoningEffort: definition.reasoningEffort.claude, interactive: true,
    });
    const spawned = await environment.backend.spawn({
      executionId, launchSpec,
      lifecycle: { requestId: executionId, parentExecutionId: null, background: false, interactive: true, timeoutMs: null },
    });
    if (spawned.status === "running") await environment.backend.wait(executionId);

    const replay = await replayCompactJournal(prepared.artifacts.compactEventsFile);
    const state = reduceCompactJournal(replay.events);
    expect(state.generation).toBe(2);
    expect(state.pending).toBeNull();
  });

  it("does not double-count a completion the runtime reports twice", async () => {
    const executionId = "exec_compact_e2e_dup";
    const fixtures: CompactFixture[] = [
      { phase: "pre", runtime: "claude", payload: { session_id: "sess-e2e", trigger: "manual", prompt_id: "prompt-dup" } },
      { phase: "post", runtime: "claude", payload: { session_id: "sess-e2e", trigger: "manual", prompt_id: "prompt-dup" } },
      { phase: "post", runtime: "claude", payload: { session_id: "sess-e2e", trigger: "manual", prompt_id: "prompt-dup" } },
    ];
    const environment = await createE2eEnvironment({ compactBridge: true, compactFixtures: fixtures });
    const prepared = await prepareMain(environment, executionId);
    const definition = agentRegistry.get("main");
    const adapter = environment.adapters.get("claude");
    if (!adapter) throw new Error("claude adapter not registered");
    const launchSpec = await adapter.prepare({
      execution: prepared, model: definition.model.claude, reasoningEffort: definition.reasoningEffort.claude, interactive: true,
    });
    const spawned = await environment.backend.spawn({
      executionId, launchSpec,
      lifecycle: { requestId: executionId, parentExecutionId: null, background: false, interactive: true, timeoutMs: null },
    });
    if (spawned.status === "running") await environment.backend.wait(executionId);

    const replay = await replayCompactJournal(prepared.artifacts.compactEventsFile);
    // All three lines parse fine — the journal itself has no dedupe (invariant 4: the hook
    // only ever appends). Collapsing the repeat is the reducer's job.
    expect(replay.events).toHaveLength(3);
    const state = reduceCompactJournal(replay.events);
    expect(state.generation).toBe(1);
  });
});

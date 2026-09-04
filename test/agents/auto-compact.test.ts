import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { defineAgent } from "../../src/agents/agent-definition";
import { agentRegistry, createAgentRegistry } from "../../src/agents/registry";
import { createExecutionPolicy } from "../../src/execution/execution-policy";
import { ClaudeRuntimeAdapter } from "../../src/runtime/claude-adapter";
import { CodexRuntimeAdapter } from "../../src/runtime/codex-adapter";
import { MODEL_CONTEXT_WINDOWS, defaultAutoCompactTokens } from "../../src/agents/model-context";
import { cleanupExecutionFixtures, policyFixture, probeDefinition, runtimeFixture } from "../support/execution-fixture";

/**
 * `autoCompactTokens` — when the runtime is allowed to nén transcript của chính nó.
 *
 * The threshold is the one number that decides what a long session still remembers, so it
 * belongs to the role rather than to whichever machine happened to launch it: a `search`
 * that grows to 150k tokens has gone wrong, and `main` should keep everything the model can
 * hold. Both runtimes have the knob under a different name — `autoCompactWindow` in Claude
 * settings, `model_auto_compact_token_limit` in Codex config — so the declaration is one
 * number and the translation is per adapter.
 *
 * Range is Claude's documented one (100k–1M). Codex publishes no bounds; sharing Claude's
 * keeps a single declared number meaningful on both, which is the point of declaring it on
 * the role at all.
 */

afterEach(cleanupExecutionFixtures);

const withThreshold = (autoCompactTokens: number | undefined) =>
  defineAgent(probeDefinition({ autoCompactTokens }));

describe("auto-compact threshold — registry ceiling", () => {
  it("rejects a threshold under the runtime minimum", () => {
    expect(() => createAgentRegistry([withThreshold(50_000)]))
      .toThrowError(/auto-compact threshold `50000`/);
  });

  it("rejects a threshold over the runtime maximum", () => {
    expect(() => createAgentRegistry([withThreshold(2_000_000)]))
      .toThrowError(/auto-compact threshold `2000000`/);
  });

  /** A fractional token count is a typo, not a budget — nothing downstream rounds it. */
  it("rejects a threshold that is not a whole number of tokens", () => {
    expect(() => createAgentRegistry([withThreshold(150_000.5)]))
      .toThrowError(/auto-compact threshold `150000.5`/);
  });

  it("accepts a threshold in range, and a role that declares none", () => {
    expect(() => createAgentRegistry([withThreshold(150_000)])).not.toThrow();
    expect(() => createAgentRegistry([withThreshold(undefined)])).not.toThrow();
  });
});

describe("auto-compact threshold — policy snapshot", () => {
  const policyFor = (autoCompactTokens: number | undefined) => createExecutionPolicy({
    executionId: "exec-compact",
    definition: defineAgent(probeDefinition({ autoCompactTokens })),
    workspace: "/workspace",
    workspaceMode: "read-only",
    createdAt: "2026-09-04T00:00:00.000Z",
  });

  it("carries the declared threshold into the snapshot", () => {
    expect(policyFor(300_000).autoCompactTokens).toBe(300_000);
  });

  /** `null`, not `undefined`: the snapshot says "runtime default" rather than saying nothing. */
  it("records the absence as null", () => {
    expect(policyFor(undefined).autoCompactTokens).toBeNull();
  });

  /**
   * How long a role remembers is part of what that role is, so moving the threshold moves
   * both hashes — an execution run under the old budget stays distinguishable from one run
   * under the new.
   */
  it("changes both hashes when the threshold moves", () => {
    const before = policyFor(200_000);
    const after = policyFor(400_000);
    expect(after.definitionHash).not.toBe(before.definitionHash);
    expect(after.policyHash).not.toBe(before.policyHash);
  });
});

describe("auto-compact threshold — runtime translation", () => {
  it("writes the threshold into Claude's settings file", async () => {
    const { root, prepared } = await runtimeFixture(policyFixture({ autoCompactTokens: 300_000 }));
    const adapter = new ClaudeRuntimeAdapter({ platform: "linux", env: { HOME: root, ALP_REPO_ROOT: root } });
    const launch = await adapter.prepare({ execution: prepared, model: "claude-test", reasoningEffort: "high", interactive: false });

    const settings = JSON.parse(await readFile(launch.env.ALP_RUNTIME_CONFIG, "utf8")) as { autoCompactWindow?: number };
    expect(settings.autoCompactWindow).toBe(300_000);
  });

  /**
   * Absent, not zero: a role that declares nothing on a model ALP has no window for leaves
   * the runtime free to pick the window it tunes itself. `claude-test` is that model — the
   * declared-nothing case on a *known* model resolves to 90% below.
   */
  it("leaves Claude's setting out when neither the role nor the table has a number", async () => {
    const { root, prepared } = await runtimeFixture(policyFixture());
    const adapter = new ClaudeRuntimeAdapter({ platform: "linux", env: { HOME: root, ALP_REPO_ROOT: root } });
    const launch = await adapter.prepare({ execution: prepared, model: "claude-test", reasoningEffort: "high", interactive: false });

    const settings = JSON.parse(await readFile(launch.env.ALP_RUNTIME_CONFIG, "utf8")) as Record<string, unknown>;
    expect(settings).not.toHaveProperty("autoCompactWindow");
  });

  /**
   * On argv, not in `codex-config.toml`: that file is written by ALP and read by nobody —
   * Codex loads `$CODEX_HOME/config.toml`, so a threshold left there would never bind.
   */
  it("passes the threshold to Codex as a config override on argv", async () => {
    const { root, prepared } = await runtimeFixture(policyFixture({ autoCompactTokens: 300_000 }));
    const adapter = new CodexRuntimeAdapter({ platform: "linux", env: { HOME: root, ALP_REPO_ROOT: root } });
    const launch = await adapter.prepare({ execution: prepared, model: "codex-test", reasoningEffort: "high", interactive: false });

    expect(launch.args).toContain("model_auto_compact_token_limit=300000");
  });

  it("leaves Codex's override out when neither the role nor the table has a number", async () => {
    const { root, prepared } = await runtimeFixture(policyFixture());
    const adapter = new CodexRuntimeAdapter({ platform: "linux", env: { HOME: root, ALP_REPO_ROOT: root } });
    const launch = await adapter.prepare({ execution: prepared, model: "codex-test", reasoningEffort: "high", interactive: false });

    expect(launch.args.join(" ")).not.toContain("model_auto_compact_token_limit");
  });
});

describe("auto-compact threshold — built-ins", () => {
  /**
   * Every shipped role states its own budget. The ordering is the claim worth pinning: the
   * seat that has to hold the whole picture keeps the most, and the one-shot specialists
   * keep less than it — a `search` near `main`'s budget would mean one of the two is
   * declared wrong.
   */
  it("gives every built-in a threshold in range", () => {
    for (const definition of agentRegistry.list()) {
      expect(definition.autoCompactTokens, definition.id).toBeGreaterThanOrEqual(100_000);
      expect(definition.autoCompactTokens, definition.id).toBeLessThanOrEqual(1_000_000);
    }
  });

  it("keeps the orchestration seat's budget above every specialist's", () => {
    const main = agentRegistry.get("main").autoCompactTokens ?? 0;
    for (const definition of agentRegistry.list()) {
      if (definition.id === "main") continue;
      expect(definition.autoCompactTokens ?? 0, definition.id).toBeLessThan(main);
    }
  });
});

/**
 * A role that declares no threshold still gets one: 90% of its model's context window.
 *
 * Silence used to mean "whatever the runtime does", and the two runtimes do different
 * things — Codex compacts at 90% of the model window, Claude at a window it tunes per model
 * and per the launching machine's settings. So the same role remembered a different amount
 * depending on where it ran, which is the machine-dependence declaring the threshold on the
 * role was meant to end. ALP resolves the default itself, from the model the role declares,
 * and it lands identically on both runtimes.
 */
describe("auto-compact threshold — default of 90% of the model window", () => {
  it("takes 90% of a known model's context window", () => {
    expect(defaultAutoCompactTokens("claude-opus-5")).toBe(900_000);
    expect(defaultAutoCompactTokens("claude-haiku-4-5")).toBe(180_000);
    expect(defaultAutoCompactTokens("gpt-5.6-sol")).toBe(244_800);
  });

  /** Never a guessed window: a model ALP has no number for gets no default at all. */
  it("returns null for a model outside the table", () => {
    expect(defaultAutoCompactTokens("claude-test")).toBeNull();
    expect(defaultAutoCompactTokens("")).toBeNull();
  });

  it("writes the resolved default into Claude's settings file", async () => {
    const { root, prepared } = await runtimeFixture(policyFixture());
    const adapter = new ClaudeRuntimeAdapter({ platform: "linux", env: { HOME: root, ALP_REPO_ROOT: root } });
    const launch = await adapter.prepare({ execution: prepared, model: "claude-opus-5", reasoningEffort: "high", interactive: false });

    const settings = JSON.parse(await readFile(launch.env.ALP_RUNTIME_CONFIG, "utf8")) as { autoCompactWindow?: number };
    expect(settings.autoCompactWindow).toBe(900_000);
  });

  it("passes the resolved default to Codex on argv", async () => {
    const { root, prepared } = await runtimeFixture(policyFixture());
    const adapter = new CodexRuntimeAdapter({ platform: "linux", env: { HOME: root, ALP_REPO_ROOT: root } });
    const launch = await adapter.prepare({ execution: prepared, model: "gpt-5.6-sol", reasoningEffort: "high", interactive: false });

    expect(launch.args).toContain("model_auto_compact_token_limit=244800");
  });

  /** The default is a floor for silence, not a ceiling on the declaration. */
  it("keeps a declared threshold ahead of the default on both runtimes", async () => {
    const claudeFixture = await runtimeFixture(policyFixture({ autoCompactTokens: 300_000 }));
    const claude = new ClaudeRuntimeAdapter({ platform: "linux", env: { HOME: claudeFixture.root, ALP_REPO_ROOT: claudeFixture.root } });
    const claudeLaunch = await claude.prepare({ execution: claudeFixture.prepared, model: "claude-opus-5", reasoningEffort: "high", interactive: false });
    const settings = JSON.parse(await readFile(claudeLaunch.env.ALP_RUNTIME_CONFIG, "utf8")) as { autoCompactWindow?: number };
    expect(settings.autoCompactWindow).toBe(300_000);

    const codexFixture = await runtimeFixture(policyFixture({ autoCompactTokens: 300_000 }));
    const codex = new CodexRuntimeAdapter({ platform: "linux", env: { HOME: codexFixture.root, ALP_REPO_ROOT: codexFixture.root } });
    const codexLaunch = await codex.prepare({ execution: codexFixture.prepared, model: "gpt-5.6-sol", reasoningEffort: "high", interactive: false });
    expect(codexLaunch.args).toContain("model_auto_compact_token_limit=300000");
  });

  /**
   * The table has to cover every model a shipped role can be launched on, or "declares
   * nothing" quietly stops meaning 90% for that role — the failure a routing change would
   * otherwise make silently.
   */
  it("has a window for every model the built-ins route to", () => {
    for (const definition of agentRegistry.list()) {
      expect(MODEL_CONTEXT_WINDOWS, `${definition.id}/claude`).toHaveProperty(definition.model.claude);
      expect(MODEL_CONTEXT_WINDOWS, `${definition.id}/codex`).toHaveProperty(definition.model.codex);
    }
  });

  /**
   * Claude refuses an `autoCompactWindow` outside 100k–1M, so a window whose 90% falls
   * outside that range would produce a settings file the runtime rejects. Pinned here
   * rather than clamped at launch: the fix belongs in the table, where it is visible.
   */
  it("keeps every resolved default inside the range both runtimes accept", () => {
    for (const [model, window] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
      const resolved = defaultAutoCompactTokens(model);
      expect(resolved, model).toBe(Math.floor((window * 90) / 100));
      expect(resolved, model).toBeGreaterThanOrEqual(100_000);
      expect(resolved, model).toBeLessThanOrEqual(1_000_000);
    }
  });
});

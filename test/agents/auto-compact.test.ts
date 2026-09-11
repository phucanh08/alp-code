import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { defineAgent } from "../../src/agents/agent-definition";
import { MODEL_CONTEXT_WINDOWS, defaultAutoCompactTokens } from "../../src/agents/model-context";
import { agentRegistry, createAgentRegistry } from "../../src/agents/registry";
import { RUNTIME_IDS } from "../../src/agents/types";
import type { RuntimeModelMap, RuntimeTokenBudgetMap } from "../../src/agents/types";
import { createExecutionPolicy } from "../../src/execution/execution-policy";
import { ClaudeRuntimeAdapter } from "../../src/runtime/claude-adapter";
import { CodexRuntimeAdapter } from "../../src/runtime/codex-adapter";
import { cleanupExecutionFixtures, policyFixture, probeDefinition, runtimeFixture } from "../support/execution-fixture";

/**
 * `autoCompactTokens` — khi nào runtime được phép nén transcript của chính nó.
 *
 * Ngưỡng là con số quyết định một phiên dài còn nhớ được gì, nên nó thuộc về vai chứ không
 * thuộc về cái máy tình cờ chạy vai đó. Nhưng nó cũng thuộc về **model**: một vai chạy trên
 * hai model có hai cửa sổ context khác nhau thì một con số dùng chung là con số sai ở ít
 * nhất một bên — 500k trên cửa sổ 1M là "nén sớm", trên cửa sổ 272k là một dòng chết không
 * bao giờ chạm tới. Nên ngưỡng khai theo runtime, cùng khuôn với `model` và
 * `reasoningEffort`, và phía nào bỏ trống thì lấy 90% cửa sổ của chính model phía đó.
 */

afterEach(cleanupExecutionFixtures);

/** Model thật, để phần kiểm cửa sổ của registry có cửa sổ mà kiểm. */
const knownModels: RuntimeModelMap = { claude: "claude-haiku-4-5", codex: "gpt-5.6-sol" };

const withThreshold = (autoCompactTokens: RuntimeTokenBudgetMap | undefined, model: RuntimeModelMap = knownModels) =>
  defineAgent(probeDefinition({ autoCompactTokens, model }));

describe("auto-compact threshold — registry ceiling", () => {
  it("rejects a threshold under the runtime minimum, naming the side that is wrong", () => {
    expect(() => createAgentRegistry([withThreshold({ claude: 50_000 })]))
      .toThrowError(/claude auto-compact threshold `50000`/);
  });

  it("rejects a threshold over the runtime maximum", () => {
    expect(() => createAgentRegistry([withThreshold({ codex: 2_000_000 })]))
      .toThrowError(/codex auto-compact threshold `2000000`/);
  });

  /** A fractional token count is a typo, not a budget — nothing downstream rounds it. */
  it("rejects a threshold that is not a whole number of tokens", () => {
    expect(() => createAgentRegistry([withThreshold({ claude: 150_000.5 })]))
      .toThrowError(/claude auto-compact threshold `150000\.5`/);
  });

  /**
   * Cái bug con số-theo-vai để lọt: một ngưỡng lớn hơn cửa sổ của model thì transcript
   * không bao giờ chạm tới, runtime rơi về chốt cứng của nó, và argv vẫn in ra con số
   * trông rất thuyết phục. Ngưỡng đi theo model nên chỗ này kiểm được — và kiểm lúc load.
   */
  it("rejects a threshold the model's context window can never reach", () => {
    expect(() => createAgentRegistry([withThreshold({ codex: 500_000 })]))
      .toThrowError(/codex auto-compact threshold `500000` .*`gpt-5\.6-sol` .*272000/);
    expect(() => createAgentRegistry([withThreshold({ claude: 300_000 })]))
      .toThrowError(/claude auto-compact threshold `300000` .*`claude-haiku-4-5` .*200000/);
  });

  /** Model ngoài bảng thì không có cửa sổ để kiểm — chỉ còn biên chung, không đoán thêm. */
  it("checks only the shared range for a model it has no window for", () => {
    const unknown: RuntimeModelMap = { claude: "claude-probe", codex: "codex-probe" };
    expect(() => createAgentRegistry([withThreshold({ claude: 900_000 }, unknown)])).not.toThrow();
  });

  it("accepts a threshold in range, one side alone, and a role that declares none", () => {
    expect(() => createAgentRegistry([withThreshold({ claude: 150_000, codex: 150_000 })])).not.toThrow();
    expect(() => createAgentRegistry([withThreshold({ codex: 150_000 })])).not.toThrow();
    expect(() => createAgentRegistry([withThreshold({})])).not.toThrow();
    expect(() => createAgentRegistry([withThreshold(undefined)])).not.toThrow();
  });
});

describe("auto-compact threshold — policy snapshot", () => {
  const policyFor = (autoCompactTokens: RuntimeTokenBudgetMap | undefined) => createExecutionPolicy({
    executionId: "exec-compact",
    thread: null,
    definition: withThreshold(autoCompactTokens),
    workspace: "/workspace",
    workspaceMode: "read-only",
    createdAt: "2026-09-04T00:00:00.000Z",
  });

  it("carries each declared side into the snapshot", () => {
    expect(policyFor({ claude: 180_000, codex: 150_000 }).autoCompactTokens)
      .toEqual({ claude: 180_000, codex: 150_000 });
  });

  /** `null`, not an absent key: the snapshot has to say "not declared" out loud, per runtime. */
  it("records an absent side as null, on every runtime", () => {
    expect(policyFor({ codex: 150_000 }).autoCompactTokens).toEqual({ claude: null, codex: 150_000 });
    expect(policyFor(undefined).autoCompactTokens).toEqual({ claude: null, codex: null });
  });

  /**
   * How long a role remembers is part of what that role is, so moving either side moves both
   * hashes — an execution run under the old budget stays distinguishable from one run under
   * the new, even when the other runtime's number never changed.
   */
  it("changes both hashes when either side moves", () => {
    const before = policyFor({ claude: 180_000, codex: 150_000 });
    const after = policyFor({ claude: 180_000, codex: 200_000 });
    expect(after.definitionHash).not.toBe(before.definitionHash);
    expect(after.policyHash).not.toBe(before.policyHash);
  });
});

describe("auto-compact threshold — runtime translation", () => {
  /** Mỗi adapter chỉ đọc phía của mình; con số của runtime kia không được rò sang. */
  it("writes each runtime its own declared side", async () => {
    const declared = { claude: 300_000, codex: 150_000 };

    const claudeFixture = await runtimeFixture(policyFixture({ autoCompactTokens: declared }));
    const claude = new ClaudeRuntimeAdapter({ platform: "linux", env: { HOME: claudeFixture.root, ALP_REPO_ROOT: claudeFixture.root } });
    const claudeLaunch = await claude.prepare({ execution: claudeFixture.prepared, model: "claude-test", reasoningEffort: "high", interactive: false });
    const settings = JSON.parse(await readFile(claudeLaunch.env.ALP_RUNTIME_CONFIG, "utf8")) as { autoCompactWindow?: number };
    expect(settings.autoCompactWindow).toBe(300_000);

    const codexFixture = await runtimeFixture(policyFixture({ autoCompactTokens: declared }));
    const codex = new CodexRuntimeAdapter({ platform: "linux", env: { HOME: codexFixture.root, ALP_REPO_ROOT: codexFixture.root } });
    const codexLaunch = await codex.prepare({ execution: codexFixture.prepared, model: "codex-test", reasoningEffort: "high", interactive: false });
    expect(codexLaunch.args).toContain("model_auto_compact_token_limit=150000");
  });

  /**
   * Absent, not zero: một vai không khai gì, trên model ALP cũng không biết cửa sổ, thì để
   * runtime tự chọn cửa sổ nó tune. `claude-test`/`codex-test` là model đó — trường hợp
   * không-khai trên model **biết** cửa sổ thì resolve ra 90% ở describe dưới.
   */
  it("leaves the setting out when neither the role nor the table has a number", async () => {
    const claudeFixture = await runtimeFixture(policyFixture());
    const claude = new ClaudeRuntimeAdapter({ platform: "linux", env: { HOME: claudeFixture.root, ALP_REPO_ROOT: claudeFixture.root } });
    const claudeLaunch = await claude.prepare({ execution: claudeFixture.prepared, model: "claude-test", reasoningEffort: "high", interactive: false });
    const settings = JSON.parse(await readFile(claudeLaunch.env.ALP_RUNTIME_CONFIG, "utf8")) as Record<string, unknown>;
    expect(settings).not.toHaveProperty("autoCompactWindow");

    const codexFixture = await runtimeFixture(policyFixture());
    const codex = new CodexRuntimeAdapter({ platform: "linux", env: { HOME: codexFixture.root, ALP_REPO_ROOT: codexFixture.root } });
    const codexLaunch = await codex.prepare({ execution: codexFixture.prepared, model: "codex-test", reasoningEffort: "high", interactive: false });
    expect(codexLaunch.args.join(" ")).not.toContain("model_auto_compact_token_limit");
  });

  /**
   * On argv, not in `codex-config.toml`: that file is written by ALP and read by nobody —
   * Codex loads `$CODEX_HOME/config.toml`, so a threshold left there would never bind.
   */
  it("passes Codex its threshold as a config override on argv", async () => {
    const { root, prepared } = await runtimeFixture(policyFixture({ autoCompactTokens: { claude: null, codex: 300_000 } }));
    const adapter = new CodexRuntimeAdapter({ platform: "linux", env: { HOME: root, ALP_REPO_ROOT: root } });
    const launch = await adapter.prepare({ execution: prepared, model: "codex-test", reasoningEffort: "high", interactive: false });

    expect(launch.args).toContain("model_auto_compact_token_limit=300000");
  });
});

/**
 * Phía nào không khai thì nhận 90% cửa sổ context của **model phía đó**.
 *
 * Im lặng trước đây nghĩa là "tuỳ runtime", mà hai runtime quyết khác nhau: Codex nén ở 90%
 * cửa sổ model, Claude nén ở cửa sổ nó tự tune theo model và theo settings của máy đang
 * chạy. Cùng một vai lại nhớ được nhiều ít khác nhau tuỳ chỗ chạy — đúng cái phụ thuộc-vào-
 * máy mà việc khai ngưỡng trên vai sinh ra để chấm dứt.
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

  it("resolves the default per runtime, from that runtime's model", async () => {
    const claudeFixture = await runtimeFixture(policyFixture());
    const claude = new ClaudeRuntimeAdapter({ platform: "linux", env: { HOME: claudeFixture.root, ALP_REPO_ROOT: claudeFixture.root } });
    const claudeLaunch = await claude.prepare({ execution: claudeFixture.prepared, model: "claude-opus-5", reasoningEffort: "high", interactive: false });
    const settings = JSON.parse(await readFile(claudeLaunch.env.ALP_RUNTIME_CONFIG, "utf8")) as { autoCompactWindow?: number };
    expect(settings.autoCompactWindow).toBe(900_000);

    const codexFixture = await runtimeFixture(policyFixture());
    const codex = new CodexRuntimeAdapter({ platform: "linux", env: { HOME: codexFixture.root, ALP_REPO_ROOT: codexFixture.root } });
    const codexLaunch = await codex.prepare({ execution: codexFixture.prepared, model: "gpt-5.6-sol", reasoningEffort: "high", interactive: false });
    expect(codexLaunch.args).toContain("model_auto_compact_token_limit=244800");
  });

  /** Một phía khai, một phía không: phía khai giữ số của nó, phía kia rơi về 90%. */
  it("mixes a declared side with a defaulted one", async () => {
    const declared = { claude: 300_000, codex: null };

    const claudeFixture = await runtimeFixture(policyFixture({ autoCompactTokens: declared }));
    const claude = new ClaudeRuntimeAdapter({ platform: "linux", env: { HOME: claudeFixture.root, ALP_REPO_ROOT: claudeFixture.root } });
    const claudeLaunch = await claude.prepare({ execution: claudeFixture.prepared, model: "claude-opus-5", reasoningEffort: "high", interactive: false });
    const settings = JSON.parse(await readFile(claudeLaunch.env.ALP_RUNTIME_CONFIG, "utf8")) as { autoCompactWindow?: number };
    expect(settings.autoCompactWindow).toBe(300_000);

    const codexFixture = await runtimeFixture(policyFixture({ autoCompactTokens: declared }));
    const codex = new CodexRuntimeAdapter({ platform: "linux", env: { HOME: codexFixture.root, ALP_REPO_ROOT: codexFixture.root } });
    const codexLaunch = await codex.prepare({ execution: codexFixture.prepared, model: "gpt-5.6-sol", reasoningEffort: "high", interactive: false });
    expect(codexLaunch.args).toContain("model_auto_compact_token_limit=244800");
  });

  /**
   * The table has to cover every model a shipped role can be launched on, or "declares
   * nothing" quietly stops meaning 90% for that role — the failure a routing change would
   * otherwise make silently.
   */
  it("has a window for every model the built-ins route to", () => {
    for (const definition of agentRegistry.list()) {
      for (const runtime of RUNTIME_IDS) {
        expect(MODEL_CONTEXT_WINDOWS, `${definition.id}/${runtime}`)
          .toHaveProperty(definition.model[runtime]);
      }
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

describe("auto-compact threshold — built-ins", () => {
  /** Ngưỡng thật của một vai trên một runtime: khai gì lấy nấy, không khai thì 90%. */
  const resolved = (id: string, runtime: (typeof RUNTIME_IDS)[number]): number => {
    const definition = agentRegistry.get(id);
    const value = definition.autoCompactTokens?.[runtime]
      ?? defaultAutoCompactTokens(definition.model[runtime]);
    expect(value, `${id}/${runtime}`).not.toBeNull();
    return value as number;
  };

  it("gives every built-in a resolved threshold in range on both runtimes", () => {
    for (const definition of agentRegistry.list()) {
      for (const runtime of RUNTIME_IDS) {
        expect(resolved(definition.id, runtime), `${definition.id}/${runtime}`).toBeGreaterThanOrEqual(100_000);
        expect(resolved(definition.id, runtime), `${definition.id}/${runtime}`).toBeLessThanOrEqual(1_000_000);
      }
    }
  });

  /**
   * The ordering is the claim worth pinning, and it has to hold **per runtime**: no
   * specialist keeps more than the seat that has to hold the whole picture. Bằng nhau thì
   * được — `oracle` suy luận trên cả tập bằng chứng một lượt nên cũng lấy trọn mặc định
   * 90% như `main`; cao hơn `main` thì không, đó là một vai khai sai. Trên cửa sổ 272k của
   * Codex thì chỉ những vai khai dưới 244 800 mới thật sự "ít hơn `main`" — con số khai
   * chung cho cả hai runtime trước đây bẹp hết ở chỗ này.
   */
  it("never lets a specialist keep more than the orchestration seat, on any runtime", () => {
    for (const runtime of RUNTIME_IDS) {
      const main = resolved("main", runtime);
      for (const definition of agentRegistry.list()) {
        if (definition.id === "main") continue;
        expect(resolved(definition.id, runtime), `${definition.id}/${runtime}`).toBeLessThanOrEqual(main);
      }
    }
    // Và ít nhất bốn vai một-lượt phải thực sự thấp hơn, nếu không thì phân tầng chỉ là chữ.
    for (const runtime of RUNTIME_IDS) {
      const main = resolved("main", runtime);
      for (const id of ["search", "compaction", "titling", "read-thread"]) {
        expect(resolved(id, runtime), `${id}/${runtime}`).toBeLessThan(main);
      }
    }
  });
});

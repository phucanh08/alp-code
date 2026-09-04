import { describe, expect, it } from "vitest";
import { MODEL_CONTEXT_WINDOWS } from "../../src/agents/model-context";
import {
  DEFAULT_MODE,
  MODE_IDS,
  MODE_PROFILES,
  modelForMode,
  parseMode,
  reasoningEffortForMode,
} from "../../src/agents/modes";
import { agentRegistry } from "../../src/agents/registry";
import { RUNTIME_IDS } from "../../src/agents/types";
import { createExecutionPolicy } from "../../src/execution/execution-policy";
import { probeDefinition } from "../support/execution-fixture";

/**
 * Dial công suất: `low` · `medium` · `high` · `ultra`.
 *
 * Bốn nấc thay cho việc phải nhớ model nào giỏi việc gì — câu hỏi duy nhất còn lại là "việc
 * này khó cỡ nào". Nấc chỉ xoay hai ghế: `main` (người làm) và `oracle` (người được hỏi khi
 * bí). Sáu vai còn lại giữ nguyên model đã khai, vì model của chúng là một phần công việc
 * chúng làm — `search` retrieval, `titling` một dòng — chứ không phải một mức cố gắng.
 *
 * `high` và `ultra` đảo chỗ hai model mạnh nhất giữa `main` và `oracle`: khi việc đã khó tới
 * mức đó thì cái quyết định kết quả là con nào **cầm bút** và con nào **soi lại**.
 */

describe("mode dial — profiles", () => {
  it("has exactly the four levels, with medium as the default", () => {
    expect(MODE_IDS).toEqual(["low", "medium", "high", "ultra"]);
    expect(DEFAULT_MODE).toBe("medium");
  });

  it("dials the working seat up across the four levels", () => {
    expect(MODE_PROFILES.low.roles.main?.model).toEqual({ claude: "claude-haiku-4-5", codex: "gpt-5.6-luna" });
    expect(MODE_PROFILES.medium.roles.main?.model).toEqual({ claude: "claude-sonnet-5", codex: "gpt-5.6-sol" });
    expect(MODE_PROFILES.high.roles.main?.model).toEqual({ claude: "claude-opus-5", codex: "gpt-5.6-sol" });
    expect(MODE_PROFILES.ultra.roles.main?.model).toEqual({ claude: "claude-fable-5-1", codex: "gpt-5.6-sol" });
  });

  /** Ghế được hỏi khi bí không bao giờ là model rẻ nhất: hỏi mà nhận câu yếu hơn thì hỏi làm gì. */
  it("keeps the oracle on a top model at every level", () => {
    for (const mode of MODE_IDS) {
      const oracle = MODE_PROFILES[mode].roles.oracle;
      expect(oracle?.model.claude, mode).not.toBe("claude-haiku-4-5");
      expect(oracle?.model.codex, mode).toBe("gpt-5.6-sol");
    }
  });

  /** `high` cầm bút bằng opus và soi lại bằng fable; `ultra` đảo lại. */
  it("swaps the two strongest models between the seats at the top two levels", () => {
    expect(MODE_PROFILES.high.roles.oracle?.model.claude).toBe("claude-fable-5-1");
    expect(MODE_PROFILES.ultra.roles.oracle?.model.claude).toBe("claude-opus-5");
  });

  /**
   * Mọi model một nấc có thể chọn phải có cửa sổ trong bảng, nếu không thì ngưỡng compact
   * mặc định (90%) lặng lẽ biến mất đúng ở nấc đó.
   */
  it("only names models the context-window table knows", () => {
    for (const mode of MODE_IDS) {
      for (const [role, profile] of Object.entries(MODE_PROFILES[mode].roles)) {
        for (const runtime of RUNTIME_IDS) {
          expect(MODEL_CONTEXT_WINDOWS, `${mode}/${role}/${runtime}`)
            .toHaveProperty(profile!.model[runtime]);
        }
      }
    }
  });

  it("only overrides roles the registry actually has", () => {
    for (const mode of MODE_IDS) {
      for (const role of Object.keys(MODE_PROFILES[mode].roles)) {
        expect(() => agentRegistry.get(role), `${mode}/${role}`).not.toThrow();
      }
    }
  });
});

describe("mode dial — resolution", () => {
  const main = agentRegistry.get("main");
  const search = agentRegistry.get("search");

  it("resolves the dialled model and effort for an overridden role", () => {
    expect(modelForMode(main, "claude", "ultra")).toBe("claude-fable-5-1");
    expect(modelForMode(main, "codex", "low")).toBe("gpt-5.6-luna");
    expect(reasoningEffortForMode(main, "codex", "low")).toBe("low");
    expect(reasoningEffortForMode(main, "codex", "high")).toBe("xhigh");
  });

  /** Vai không nằm trong nấc giữ nguyên khai báo của chính nó, ở mọi nấc. */
  it("falls back to the role's own declaration for every other role", () => {
    for (const mode of MODE_IDS) {
      expect(modelForMode(search, "claude", mode), mode).toBe(search.model.claude);
      expect(modelForMode(search, "codex", mode), mode).toBe(search.model.codex);
      expect(reasoningEffortForMode(search, "codex", mode), mode).toBe(search.reasoningEffort.codex);
    }
  });

  it("accepts the four names and refuses anything else", () => {
    for (const mode of MODE_IDS) expect(parseMode(mode)).toBe(mode);
    expect(() => parseMode("smart")).toThrowError(/mode must be one of low, medium, high, ultra/);
    expect(() => parseMode("")).toThrowError(/mode must be one of/);
    expect(() => parseMode(undefined)).toThrowError(/mode must be one of/);
  });
});

describe("mode dial — policy snapshot", () => {
  const policyFor = (mode: (typeof MODE_IDS)[number] | undefined) => createExecutionPolicy({
    executionId: "exec-mode",
    definition: probeDefinition(),
    workspace: "/workspace",
    workspaceMode: "read-only",
    createdAt: "2026-09-04T00:00:00.000Z",
    ...(mode === undefined ? {} : { mode }),
  });

  /**
   * Cùng một definition chạy được bốn model khác nhau, nên snapshot phải nói ra nấc nào đã
   * chạy — nếu không thì `policy.json` mô tả một execution mà nó không mô tả nổi.
   */
  it("records the mode and moves the policy hash with it", () => {
    expect(policyFor("ultra").mode).toBe("ultra");
    expect(policyFor(undefined).mode).toBe(DEFAULT_MODE);
    expect(policyFor("ultra").policyHash).not.toBe(policyFor("low").policyHash);
  });

  /** Nấc là lựa chọn lúc phóng, không phải một vai khác: definition hash không đổi theo nấc. */
  it("leaves the definition hash alone", () => {
    expect(policyFor("ultra").definitionHash).toBe(policyFor("low").definitionHash);
  });
});

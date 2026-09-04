import { describe, expect, it } from "vitest";
import { MODEL_CONTEXT_WINDOWS, MODEL_RUNTIMES, runtimeForModel } from "../../src/agents/model-context";
import {
  DEFAULT_MODE,
  homeRuntimeForMode,
  MODE_IDS,
  MODE_PROFILES,
  modelForMode,
  parseMode,
  reasoningEffortForMode,
  runtimeForMode,
} from "../../src/agents/modes";
import { agentRegistry } from "../../src/agents/registry";
import { createExecutionPolicy } from "../../src/execution/execution-policy";
import { probeDefinition } from "../support/execution-fixture";

/**
 * Dial công suất: `low` · `medium` · `high` · `ultra`, cộng `puck`.
 *
 * Bốn nấc thay cho việc phải nhớ model nào giỏi việc gì — câu hỏi duy nhất còn lại là "việc
 * này khó cỡ nào". Mỗi nấc là một **loadout hoàn chỉnh**: mỗi vai đúng một model, nên model
 * là thứ quyết định CLI nào chạy vai đó. `puck` nằm ngoài trục độ khó — nó trả lời "chạy
 * toàn Codex".
 */

const ROLES = ["main", "search", "librarian", "read-thread", "review", "oracle", "compaction", "titling"] as const;

describe("mode dial — loadout", () => {
  it("has the four levels plus puck, with medium as the default", () => {
    expect(MODE_IDS).toEqual(["low", "medium", "high", "ultra", "puck"]);
    expect(DEFAULT_MODE).toBe("medium");
  });

  /** Một vai không có model ở nấc đang chạy là một vai không phóng được. */
  it("gives every built-in role exactly one model at every level", () => {
    for (const mode of MODE_IDS) {
      for (const role of ROLES) {
        const profile = MODE_PROFILES[mode].roles[role];
        expect(profile?.model, `${mode}/${role}`).toBeTypeOf("string");
        expect(MODEL_RUNTIMES, `${mode}/${role}`).toHaveProperty(profile!.model);
        // Không có cửa sổ thì ngưỡng compact mặc định (90%) biến mất đúng ở nấc đó.
        expect(MODEL_CONTEXT_WINDOWS, `${mode}/${role}`).toHaveProperty(profile!.model);
      }
      expect(Object.keys(MODE_PROFILES[mode].roles).sort()).toEqual([...ROLES].sort());
    }
  });

  it("dials the working seat up across the four levels", () => {
    expect(MODE_PROFILES.low.roles.main.model).toBe("claude-haiku-4-5");
    expect(MODE_PROFILES.medium.roles.main.model).toBe("gpt-5.6-sol");
    expect(MODE_PROFILES.high.roles.main.reasoningEffort).toBe("xhigh");
    expect(MODE_PROFILES.ultra.roles.main.model).toBe("claude-fable-5-1");
  });

  /** `high` cầm bút bằng Sol và soi lại bằng Fable; `ultra` đảo lại — đúng khuôn Amp. */
  it("swaps the two strongest models between the seats at the top two levels", () => {
    expect(MODE_PROFILES.high.roles.oracle.model).toBe("claude-fable-5-1");
    expect(MODE_PROFILES.ultra.roles.oracle.model).toBe("gpt-5.6-sol");
  });

  /** Sáu vai ngoài trục độ khó không đổi qua bốn nấc dial: model của chúng là việc, không phải mức cố gắng. */
  it("keeps the six off-dial roles identical across the four dial levels", () => {
    const offDial = ROLES.filter((role) => role !== "main" && role !== "oracle");
    for (const role of offDial) {
      const baseline = MODE_PROFILES.low.roles[role];
      for (const mode of ["medium", "high", "ultra"] as const) {
        expect(MODE_PROFILES[mode].roles[role], `${mode}/${role}`).toEqual(baseline);
      }
    }
  });

  it("runs every seat on Codex in puck", () => {
    for (const role of ROLES) {
      expect(runtimeForModel(MODE_PROFILES.puck.roles[role].model), role).toBe("codex");
    }
  });

  it("only names roles the registry actually has", () => {
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

  it("resolves the dialled model, effort, and the runtime that model implies", () => {
    expect(modelForMode(main, "ultra")).toBe("claude-fable-5-1");
    expect(runtimeForMode(main, "ultra")).toBe("claude");
    expect(modelForMode(main, "low")).toBe("claude-haiku-4-5");
    expect(reasoningEffortForMode(main, "high")).toBe("xhigh");
    expect(runtimeForMode(main, "puck")).toBe("codex");
    // Một nấc trộn hai CLI trong cùng phiên — Amp cũng vậy.
    expect(runtimeForMode(search, "ultra")).toBe("codex");
  });

  /**
   * Vai chưa có trong loadout (custom agent mai này) rơi về khai báo của chính nó, ở phía
   * runtime mà nấc đang đứng — chứ không phải một phía cố định.
   */
  it("falls back to the role's own declaration on the mode's home runtime", () => {
    const custom = probeDefinition({ id: "probe" });
    expect(homeRuntimeForMode("ultra")).toBe("claude");
    expect(homeRuntimeForMode("puck")).toBe("codex");
    expect(modelForMode(custom, "ultra")).toBe(custom.model.claude);
    expect(modelForMode(custom, "puck")).toBe(custom.model.codex);
    expect(reasoningEffortForMode(custom, "puck")).toBe(custom.reasoningEffort.codex);
  });

  it("accepts the five names and refuses anything else", () => {
    for (const mode of MODE_IDS) expect(parseMode(mode)).toBe(mode);
    expect(() => parseMode("smart")).toThrowError(/mode must be one of low, medium, high, ultra, puck/);
    expect(() => parseMode("")).toThrowError(/mode must be one of/);
    expect(() => parseMode(undefined)).toThrowError(/mode must be one of/);
  });

  it("refuses a model with no runtime rather than guessing from its name", () => {
    expect(() => runtimeForModel("gpt-oss-120b")).toThrowError(/MODEL_RUNTIMES/);
  });
});

describe("mode dial — policy snapshot", () => {
  const policyFor = (mode: ModeArg) => createExecutionPolicy({
    executionId: "exec-mode",
    definition: probeDefinition(),
    workspace: "/workspace",
    workspaceMode: "read-only",
    createdAt: "2026-09-04T00:00:00.000Z",
    ...(mode === undefined ? {} : { mode }),
  });
  type ModeArg = (typeof MODE_IDS)[number] | undefined;

  /**
   * Cùng một definition chạy được năm loadout khác nhau, nên snapshot phải nói ra nấc nào đã
   * chạy — nếu không thì `policy.json` mô tả một execution mà nó không mô tả nổi.
   */
  it("records the mode and moves the policy hash with it", () => {
    expect(policyFor("ultra").mode).toBe("ultra");
    expect(policyFor(undefined).mode).toBe(DEFAULT_MODE);
    expect(policyFor("ultra").policyHash).not.toBe(policyFor("puck").policyHash);
  });

  /** Nấc là lựa chọn lúc phóng, không phải một vai khác: definition hash không đổi theo nấc. */
  it("leaves the definition hash alone", () => {
    expect(policyFor("ultra").definitionHash).toBe(policyFor("low").definitionHash);
  });
});

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
  type ModeProfiles,
} from "../../src/agents/modes";
import { applyModeSettings, parseModeSettings } from "../../src/agents/mode-settings";
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

const ROLES = ["main", "worker", "search", "librarian", "read-thread", "review", "oracle", "compaction", "titling"] as const;

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
    expect(MODE_PROFILES.low.roles.worker.model).toBe("claude-sonnet-5");
    expect(MODE_PROFILES.low.roles.worker.reasoningEffort).toBe("high");
    expect(MODE_PROFILES.medium.roles.worker.model).toBe("gpt-5.6-sol");
    expect(MODE_PROFILES.high.roles.worker.model).toBe("claude-opus-5");
    expect(MODE_PROFILES.high.roles.worker.reasoningEffort).toBe("high");
    expect(MODE_PROFILES.ultra.roles.worker.model).toBe("claude-opus-5");
  });

  /**
   * Ghế điều phối đứng ngoài dial từ 2026-09-10. Việc của nó — nghe principal, nghĩ cùng họ,
   * cắt việc — không dễ đi hơn khi bài toán dễ đi; thứ đổi theo độ khó là ghế cầm bút. Nếu
   * `main` lại trôi theo nấc thì nấc `low` sẽ hạ cả chất lượng đối thoại lẫn chất lượng nhát
   * cắt, mà đó chính là hai thứ quyết định phần còn lại của phiên.
   */
  it("keeps the coordinating seat off the dial", () => {
    for (const mode of ["low", "medium", "high", "ultra"] as const) {
      expect(MODE_PROFILES[mode].roles.main, mode).toEqual({ model: "claude-opus-5", reasoningEffort: "high" });
    }
  });

  /** `oracle` luôn đứng ở runtime đối diện `worker` — người được hỏi khi bí phải là một cách
   * nhìn khác, không phải cùng model tự hỏi lại chính nó. */
  it("keeps the oracle seat on the runtime opposite the working seat at every dial level", () => {
    for (const mode of ["low", "medium", "high", "ultra"] as const) {
      const workerRuntime = runtimeForModel(MODE_PROFILES[mode].roles.worker.model);
      const oracleRuntime = runtimeForModel(MODE_PROFILES[mode].roles.oracle.model);
      expect(oracleRuntime, mode).not.toBe(workerRuntime);
    }
  });

  /** `high` và `ultra` cùng cầm bút bằng Opus 5; khác nhau ở oracle — `ultra` leo lên model
   * mới nhất (Astra) thay vì chỉ tăng effort. */
  it("escalates the oracle model rather than the working seat between high and ultra", () => {
    expect(MODE_PROFILES.high.roles.oracle.model).toBe("gpt-5.6-sol");
    expect(MODE_PROFILES.high.roles.oracle.reasoningEffort).toBe("xhigh");
    expect(MODE_PROFILES.ultra.roles.oracle.model).toBe("gpt-6-astra");
    expect(MODE_PROFILES.ultra.roles.oracle.reasoningEffort).toBe("high");
  });

  /** Bảy vai ngoài trục độ khó không đổi qua bốn nấc dial: model của chúng là việc, không phải mức cố gắng. */
  it("keeps the seven off-dial roles identical across the four dial levels", () => {
    const offDial = ROLES.filter((role) => role !== "worker" && role !== "oracle");
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
  const worker = agentRegistry.get("worker");
  const search = agentRegistry.get("search");

  it("resolves the dialled model, effort, and the runtime that model implies", () => {
    expect(modelForMode(worker, "ultra")).toBe("claude-opus-5");
    expect(runtimeForMode(worker, "ultra")).toBe("claude");
    expect(modelForMode(worker, "low")).toBe("claude-sonnet-5");
    expect(reasoningEffortForMode(worker, "high")).toBe("high");
    expect(runtimeForMode(worker, "puck")).toBe("codex");
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
  const policyFor = (mode: ModeArg, modeProfiles?: ModeProfiles) => createExecutionPolicy({
    executionId: "exec-mode",
    thread: null,
    definition: probeDefinition(),
    workspace: "/workspace",
    workspaceMode: "read-only",
    createdAt: "2026-09-04T00:00:00.000Z",
    ...(mode === undefined ? {} : { mode }),
    ...(modeProfiles === undefined ? {} : { modeProfiles }),
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

  /**
   * Từ khi settings sửa được nội dung một nấc, tên nấc một mình không còn trả lời được "lần
   * chạy này chạy gì". Model, mức nghĩ và CLI nằm luôn trong snapshot — nên đổi một dòng
   * settings đổi `policyHash`, đúng như đổi nấc.
   */
  it("records the loadout it resolved, and moves the hash when settings move it", () => {
    const file = "/project/.alp/settings.json";
    const profiles = applyModeSettings(MODE_PROFILES, [{
      file,
      settings: parseModeSettings({ modes: { high: { probe: { model: "gpt-5.6-terra", reasoningEffort: "low" } } } }, file),
    }]);
    const builtIn = policyFor("high");
    const configured = policyFor("high", profiles);

    expect(builtIn).toMatchObject({ model: "claude-haiku-4-5", reasoningEffort: "low", runtime: "claude" });
    expect(configured).toMatchObject({ model: "gpt-5.6-terra", reasoningEffort: "low", runtime: "codex" });
    expect(configured.mode).toBe("high");
    expect(configured.policyHash).not.toBe(builtIn.policyHash);
    // Vẫn là cùng một vai: settings ghim loadout chứ không sửa quyền, nên definition hash đứng yên.
    expect(configured.definitionHash).toBe(builtIn.definitionHash);
  });

  /** Nấc là lựa chọn lúc phóng, không phải một vai khác: definition hash không đổi theo nấc. */
  it("leaves the definition hash alone", () => {
    expect(policyFor("ultra").definitionHash).toBe(policyFor("low").definitionHash);
  });
});

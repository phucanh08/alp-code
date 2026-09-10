import { describe, expect, it } from "vitest";
import {
  applyModeSettings,
  InvalidModeSettings,
  modeOverrides,
  parseModeSettings,
} from "../../src/agents/mode-settings";
import { MODE_IDS, MODE_PROFILES, modelForMode, reasoningEffortForMode, runtimeForMode } from "../../src/agents/modes";
import { agentRegistry } from "../../src/agents/registry";

/**
 * Loadout sửa được — `settings.json` nói vai nào chạy model nào, ở nấc nào.
 *
 * Dial vẫn là năm nấc và vẫn trả lời "việc này khó cỡ nào". Cái mở ra chỉ là **nội dung** một
 * nấc: model và mức nghĩ, hai thứ vốn đã là dữ liệu. Không có đường nào từ file này đi tới
 * quyền — tool, memory, workspace, delegates_to đều ở ngoài tầm với của nó.
 */

const layer = (modes: unknown, file = "/settings.json") => ({
  file,
  settings: parseModeSettings({ modes }, file),
});

describe("mode settings — parsing", () => {
  it("reads a per-mode role override", () => {
    const settings = parseModeSettings(
      { modes: { high: { worker: { model: "claude-opus-5", reasoningEffort: "max" } } } },
      "/settings.json",
    );
    expect(settings.modes.high.worker).toEqual({ model: "claude-opus-5", reasoningEffort: "max" });
  });

  /** ALP không phải chủ duy nhất của `settings.json`, nên khoá gốc lạ không phải lỗi. */
  it("ignores keys outside `modes` and treats a missing `modes` as no opinion", () => {
    expect(parseModeSettings({ editor: "vim" }, "/settings.json").modes).toEqual({});
  });

  /**
   * Bên trong `modes` thì ngược lại: một khoá gõ sai ở đây không làm gì cả mà vẫn trông như
   * đã làm, và người dùng tin mình đang chạy loadout mình vừa viết.
   */
  it("refuses an unknown key inside a role override", () => {
    expect(() => parseModeSettings(
      { modes: { high: { worker: { model: "claude-opus-5", effort: "max" } } } },
      "/settings.json",
    )).toThrow(/unknown key `effort`/);
  });

  it("refuses a mode that does not exist", () => {
    expect(() => parseModeSettings({ modes: { deep: { worker: { model: "claude-opus-5" } } } }, "/s.json"))
      .toThrow(/`modes.deep` is not a mode/);
  });

  /** Model quyết định CLI được phóng; một tên không có trong `MODEL_RUNTIMES` phải chết ở đây. */
  it("refuses a model no runtime is mapped to", () => {
    expect(() => parseModeSettings({ modes: { high: { worker: { model: "gpt-9" } } } }, "/s.json"))
      .toThrow(/chưa được gán runtime/);
  });

  it("refuses a reasoning effort that does not exist", () => {
    expect(() => parseModeSettings({ modes: { high: { worker: { reasoningEffort: "hard" } } } }, "/s.json"))
      .toThrow(/reasoningEffort must be one of/);
  });

  it("refuses an override that sets nothing", () => {
    expect(() => parseModeSettings({ modes: { high: { worker: {} } } }, "/s.json")).toThrow(/sets nothing/);
    expect(() => parseModeSettings({ modes: { high: { worker: "opus" } } }, "/s.json")).toThrow(/must be an object/);
  });

  it("names the file in every complaint", () => {
    expect(() => parseModeSettings({ modes: { high: 3 } }, "/home/me/.alp/settings.json"))
      .toThrow(/\/home\/me\/\.alp\/settings\.json/);
  });
});

describe("mode settings — merging", () => {
  it("leaves the built-in loadout untouched when nothing is configured", () => {
    expect(applyModeSettings(MODE_PROFILES, [])).toBe(MODE_PROFILES);
  });

  it("replaces one role at one mode and leaves every other seat alone", () => {
    const profiles = applyModeSettings(MODE_PROFILES, [
      layer({ high: { worker: { model: "gpt-5.6-terra", reasoningEffort: "low" } } }),
    ]);
    expect(profiles.high.roles.worker).toEqual({ model: "gpt-5.6-terra", reasoningEffort: "low" });
    expect(profiles.high.roles.oracle).toEqual(MODE_PROFILES.high.roles.oracle);
    expect(profiles.medium.roles.worker).toEqual(MODE_PROFILES.medium.roles.worker);
    expect(MODE_PROFILES.high.roles.worker.model).toBe("claude-opus-5");
  });

  /** Nửa còn lại mượn từ built-in: sửa mức nghĩ không bắt phải chép lại tên model. */
  it("merges a half override onto the built-in half", () => {
    const profiles = applyModeSettings(MODE_PROFILES, [layer({ ultra: { oracle: { reasoningEffort: "max" } } })]);
    expect(profiles.ultra.roles.oracle).toEqual({ model: "gpt-6-astra", reasoningEffort: "max" });
  });

  it("applies `*` to every mode, and lets a named mode win over it", () => {
    const profiles = applyModeSettings(MODE_PROFILES, [
      layer({
        "*": { titling: { model: "claude-haiku-4-5", reasoningEffort: "medium" } },
        low: { titling: { model: "gpt-5.6-luna", reasoningEffort: "low" } },
      }),
    ]);
    for (const mode of MODE_IDS) {
      if (mode === "low") continue;
      expect(profiles[mode].roles.titling.reasoningEffort, mode).toBe("medium");
    }
    expect(profiles.low.roles.titling).toEqual({ model: "gpt-5.6-luna", reasoningEffort: "low" });
  });

  /** Thứ tự lớp là thứ tự thắng: máy → project → local. */
  it("lets a later layer override an earlier one", () => {
    const profiles = applyModeSettings(MODE_PROFILES, [
      layer({ high: { worker: { model: "gpt-5.6-terra", reasoningEffort: "low" } } }, "/home/.alp/settings.json"),
      layer({ high: { worker: { model: "claude-sonnet-5" } } }, "/project/.alp/settings.local.json"),
    ]);
    expect(profiles.high.roles.worker).toEqual({ model: "claude-sonnet-5", reasoningEffort: "low" });
  });

  /**
   * Custom agent chưa có ghế trong loadout nào, nên không có nửa nào để mượn — khai thiếu
   * thì ném, chứ không đoán nốt.
   */
  it("requires both fields for a role no mode carries a loadout for", () => {
    expect(() => applyModeSettings(MODE_PROFILES, [layer({ high: { auditor: { model: "claude-sonnet-5" } } })]))
      .toThrow(InvalidModeSettings);
    const profiles = applyModeSettings(MODE_PROFILES, [
      layer({ high: { auditor: { model: "claude-sonnet-5", reasoningEffort: "high" } } }),
    ]);
    expect(profiles.high.roles.auditor).toEqual({ model: "claude-sonnet-5", reasoningEffort: "high" });
  });

  it("keeps each mode's summary, because settings pin models and nothing else", () => {
    const profiles = applyModeSettings(MODE_PROFILES, [layer({ "*": { review: { reasoningEffort: "low" } } })]);
    for (const mode of MODE_IDS) expect(profiles[mode].summary).toBe(MODE_PROFILES[mode].summary);
  });
});

describe("mode settings — what a launch reads", () => {
  const worker = agentRegistry.get("worker");

  it("moves the model, the effort, and therefore the CLI a role launches on", () => {
    const profiles = applyModeSettings(MODE_PROFILES, [
      layer({ high: { worker: { model: "gpt-5.6-sol", reasoningEffort: "xhigh" } } }),
    ]);
    expect(runtimeForMode(worker, "high")).toBe("claude");
    expect(runtimeForMode(worker, "high", profiles)).toBe("codex");
    expect(modelForMode(worker, "high", profiles)).toBe("gpt-5.6-sol");
    expect(reasoningEffortForMode(worker, "high", profiles)).toBe("xhigh");
  });

  /**
   * `homeRuntimeForMode` neo vào ghế `worker`, nên ghi đè worker cũng đổi "nhà" của nấc —
   * đúng ý: nhà của một nấc là nơi việc thật đang chạy.
   */
  it("moves the fallback runtime a role without a loadout inherits", () => {
    const profiles = applyModeSettings(MODE_PROFILES, [
      layer({ medium: { worker: { model: "claude-opus-5", reasoningEffort: "high" } } }),
    ]);
    const custom = { ...worker, id: "auditor" };
    expect(modelForMode(custom, "medium")).toBe(custom.model.codex);
    expect(modelForMode(custom, "medium", profiles)).toBe(custom.model.claude);
  });

  it("lists exactly the seats that differ from the built-in dial", () => {
    const profiles = applyModeSettings(MODE_PROFILES, [
      layer({ high: { worker: { reasoningEffort: "max" }, auditor: { model: "claude-sonnet-5", reasoningEffort: "low" } } }),
    ]);
    expect(modeOverrides("high", profiles)).toEqual([
      { role: "auditor", model: "claude-sonnet-5", reasoningEffort: "low", builtIn: null },
      { role: "worker", model: "claude-opus-5", reasoningEffort: "max", builtIn: MODE_PROFILES.high.roles.worker },
    ]);
    expect(modeOverrides("medium", profiles)).toEqual([]);
  });
});

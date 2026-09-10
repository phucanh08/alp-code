import { DEFAULT_MODE, type ModeId, type ModeProfiles } from "../../agents/modes";
import { modeOverrides } from "../../agents/mode-settings";
import { FileModePreferenceStore, type ModePreferenceStore } from "../mode-preference-store";

/**
 * `alp mode show|set <nấc>` — nấc mặc định lưu ở `~/.alp/mode.json`.
 *
 * Thay chỗ `alp runtime show|set` cũ: từ khi mỗi vai ở mỗi nấc chỉ có một model, runtime là
 * hệ quả của model chứ không còn là thứ để chọn.
 */
export interface ModeCommandInput {
  readonly action: "show" | "set";
  readonly mode?: ModeId;
}

/**
 * Loadout đang thật sự có hiệu lực, để `show` in ra được cái sẽ chạy chứ không phải cái ALP
 * ship sẵn. Bỏ trống thì không có dòng nào thêm — máy chưa cấu hình gì thì output y như cũ.
 */
export interface ModeCommandSettings {
  readonly files: readonly string[];
  readonly profiles: ModeProfiles;
}

export async function runModeCommand(
  input: ModeCommandInput,
  options: {
    readonly store?: ModePreferenceStore;
    readonly write?: (text: string) => unknown;
    readonly settings?: ModeCommandSettings;
  } = {},
): Promise<ModeId> {
  const store = options.store ?? new FileModePreferenceStore();
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  if (input.action === "set") {
    if (!input.mode) throw new Error("mode set requires low, medium, high, ultra, or puck");
    await store.write(input.mode);
    write(`${input.mode}\n`);
    return input.mode;
  }
  const preference = await store.read();
  if (preference.warning) write(`WARNING  ${preference.warning}\n`);
  const mode = preference.mode ?? DEFAULT_MODE;
  write(`${mode}\n`);
  // Dòng đầu vẫn chỉ là tên nấc, để chỗ nào đang đọc `alp mode show` bằng script không gãy.
  // Phần dưới là câu trả lời cho "nấc này ở máy này nghĩa là gì" — câu mà từ khi có settings
  // thì tên nấc một mình không còn trả lời nổi.
  if (options.settings) {
    for (const file of options.settings.files) write(`SETTINGS ${file}\n`);
    for (const row of modeOverrides(mode, options.settings.profiles)) {
      write(`OVERRIDE ${row.role.padEnd(12)} ${row.model} · ${row.reasoningEffort}${row.builtIn
        ? ` (built-in ${row.builtIn.model} · ${row.builtIn.reasoningEffort})`
        : " (no built-in loadout)"}\n`);
    }
  }
  return mode;
}

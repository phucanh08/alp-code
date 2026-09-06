import { DEFAULT_MODE, type ModeId } from "../../agents/modes";
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

export async function runModeCommand(
  input: ModeCommandInput,
  options: { readonly store?: ModePreferenceStore; readonly write?: (text: string) => unknown } = {},
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
  return mode;
}

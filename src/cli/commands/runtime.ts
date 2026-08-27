import type { RuntimeId } from "../../agents/types";
import { FileRuntimePreferenceStore, type RuntimePreferenceStore } from "../../runtime/runtime-preference-store";

export interface RuntimeCommandInput {
  readonly action: "show" | "set";
  readonly runtime?: RuntimeId;
}

export async function runRuntimeCommand(
  input: RuntimeCommandInput,
  options: { readonly store?: RuntimePreferenceStore; readonly write?: (text: string) => unknown } = {},
): Promise<RuntimeId> {
  const store = options.store ?? new FileRuntimePreferenceStore();
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  if (input.action === "set") {
    if (!input.runtime) throw new Error("runtime set requires claude or codex");
    await store.write(input.runtime);
    write(`${input.runtime}\n`);
    return input.runtime;
  }
  const preference = await store.read();
  if (preference.warning) write(`WARNING  ${preference.warning}\n`);
  const runtime = preference.runtime ?? "claude";
  write(`${runtime}\n`);
  return runtime;
}

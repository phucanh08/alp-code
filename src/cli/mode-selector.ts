import { PassThrough } from "node:stream";
import { emitKeypressEvents } from "node:readline";
import { DEFAULT_MODE, MODE_IDS, MODE_PROFILES, type ModeId } from "../agents/modes";
import {
  FileModePreferenceStore,
  type ModePreferenceStore,
} from "./mode-preference-store";
import type {
  RuntimeTerminalInput,
  RuntimeTerminalOutput,
  TerminalKey,
} from "../runtime/types";

/**
 * Menu chọn **nấc**, không phải chọn runtime.
 *
 * Từ khi mỗi vai ở mỗi nấc chỉ có một model, model quyết định CLI — nên câu hỏi lúc mở phiên
 * không còn là "chạy Claude hay Codex" mà là "việc này khó cỡ nào". Menu vẫn giữ nguyên
 * khuôn cũ: nhớ lựa chọn lần trước, hỏi một lần trên TTY, Ctrl+C là huỷ chứ không phải chọn
 * bừa.
 */
const MODES: readonly ModeId[] = MODE_IDS;

export type ModeSelectionSource = "explicit" | "interactive" | "persisted" | "default";

export type ModeSelection =
  | { readonly ok: true; readonly mode: ModeId; readonly source: ModeSelectionSource }
  | { readonly ok: false; readonly exitCode: 130 };

export interface ModeSelectorOptions {
  readonly preferenceStore?: ModePreferenceStore;
  readonly input?: RuntimeTerminalInput;
  readonly output?: RuntimeTerminalOutput;
  readonly readKey?: () => Promise<TerminalKey>;
}

export interface SelectModeInput {
  readonly requestedMode?: ModeId;
  readonly interactive: boolean;
}

interface KeypressReader {
  read(): Promise<TerminalKey>;
  close(): void;
}

function normalizeKeypress(
  sequence: string | undefined,
  key: { readonly ctrl?: boolean; readonly name?: string } = {},
): TerminalKey {
  if (key.ctrl && key.name === "c") return "cancel";
  if (key.name === "up") return "up";
  if (key.name === "down") return "down";
  if (
    key.name === "return" ||
    key.name === "enter" ||
    sequence === "\r" ||
    sequence === "\n"
  ) {
    return "enter";
  }
  return "other";
}

function createKeypressReader(input: RuntimeTerminalInput): KeypressReader {
  const decoder = new PassThrough();
  const queued: TerminalKey[] = [];
  const waiting: Array<{
    resolve(value: TerminalKey): void;
    reject(error: unknown): void;
  }> = [];
  let terminalError: unknown = null;

  const onKeypress = (
    sequence: string | undefined,
    key: { readonly ctrl?: boolean; readonly name?: string },
  ) => {
    const value = normalizeKeypress(sequence, key);
    const waiter = waiting.shift();
    if (waiter) waiter.resolve(value);
    else queued.push(value);
  };
  const onError = (error: unknown) => {
    terminalError = error;
    for (const waiter of waiting.splice(0)) waiter.reject(error);
  };
  const onData = (chunk: never) => {
    decoder.write(chunk);
  };

  emitKeypressEvents(decoder);
  decoder.on("keypress", onKeypress);
  input.on("data", onData);
  input.on("error", onError);

  return {
    read() {
      const queuedKey = queued.shift();
      if (queuedKey !== undefined) return Promise.resolve(queuedKey);
      if (terminalError !== null) return Promise.reject(terminalError);
      return new Promise<TerminalKey>((resolve, reject) => {
        waiting.push({ resolve, reject });
      });
    },
    close() {
      input.removeListener("data", onData);
      input.removeListener("error", onError);
      decoder.removeListener("keypress", onKeypress);
      decoder.destroy();
    },
  };
}

function renderMenu(
  output: RuntimeTerminalOutput,
  current: ModeId,
  selectedIndex: number,
  redraw: boolean,
): void {
  if (redraw) output.write(`\u001b[${MODES.length + 1}A`);
  for (const [index, mode] of MODES.entries()) {
    const pointer = index === selectedIndex ? "❯" : " ";
    const persisted = mode === current ? " (current)" : "";
    output.write(`\r\u001b[2K  ${pointer} ${mode.padEnd(6)}${persisted} — ${MODE_PROFILES[mode].summary}\n`);
  }
  output.write("\r\u001b[2K↑/↓ select · Enter confirm · Ctrl+C cancel\n");
}

export class ModeSelector {
  private readonly preferenceStore: ModePreferenceStore;
  private readonly input?: RuntimeTerminalInput;
  private readonly output: RuntimeTerminalOutput;
  private readonly injectedReadKey?: () => Promise<TerminalKey>;

  constructor(options: ModeSelectorOptions = {}) {
    this.preferenceStore = options.preferenceStore ?? new FileModePreferenceStore();
    this.input = options.input ?? (process.stdin as RuntimeTerminalInput);
    this.output = options.output ?? process.stdout;
    this.injectedReadKey = options.readKey;
  }

  async select(input: SelectModeInput): Promise<ModeSelection> {
    if (input.requestedMode !== undefined) {
      if (!MODES.includes(input.requestedMode)) {
        throw new Error(`invalid mode \`${String(input.requestedMode)}\``);
      }
      return { ok: true, mode: input.requestedMode, source: "explicit" };
    }

    const preference = await this.preferenceStore.read();
    if (preference.warning) {
      this.output.write(`WARNING  ${preference.warning}\n`);
    }
    const current = preference.mode ?? DEFAULT_MODE;
    if (!input.interactive) {
      return {
        ok: true,
        mode: current,
        source: preference.mode === null ? "default" : "persisted",
      };
    }

    const selected = await this.prompt(current);
    if (selected === null) return { ok: false, exitCode: 130 };
    await this.preferenceStore.write(selected);
    return { ok: true, mode: selected, source: "interactive" };
  }

  private async prompt(current: ModeId): Promise<ModeId | null> {
    if (!this.injectedReadKey && !this.input) {
      throw new Error("interactive mode selection requires terminal input");
    }
    const wasFlowing = this.input?.readableFlowing === true;
    const wasRaw = Boolean(this.input?.isRaw);
    const keypress = this.injectedReadKey || !this.input
      ? null
      : createKeypressReader(this.input);
    const readKey = this.injectedReadKey ?? keypress!.read;
    let changedRawMode = false;
    let selectedIndex = Math.max(0, MODES.indexOf(current));

    this.output.write("\nSelect mode for this ALP session:\n");
    this.output.write("\u001b[?25l");
    try {
      if (
        keypress &&
        !wasRaw &&
        typeof this.input?.setRawMode === "function"
      ) {
        this.input.setRawMode(true);
        changedRawMode = true;
      }
      if (keypress && typeof this.input?.resume === "function") {
        this.input.resume();
      }
      renderMenu(this.output, current, selectedIndex, false);
      for (;;) {
        const key = await readKey();
        if (key === "up") {
          selectedIndex = (selectedIndex - 1 + MODES.length) % MODES.length;
          renderMenu(this.output, current, selectedIndex, true);
        } else if (key === "down") {
          selectedIndex = (selectedIndex + 1) % MODES.length;
          renderMenu(this.output, current, selectedIndex, true);
        } else if (key === "enter") {
          return MODES[selectedIndex];
        } else if (key === "cancel") {
          return null;
        }
      }
    } finally {
      keypress?.close();
      if (
        keypress &&
        !wasFlowing &&
        typeof this.input?.pause === "function"
      ) {
        this.input.pause();
      }
      if (changedRawMode) this.input?.setRawMode?.(false);
      this.output.write("\u001b[?25h");
    }
  }
}

import { PassThrough } from "node:stream";
import { emitKeypressEvents } from "node:readline";
import {
  FileRuntimePreferenceStore,
  type RuntimePreferenceStore,
} from "./runtime-preference-store";
import type {
  RuntimeId,
  RuntimeSelection,
  RuntimeTerminalInput,
  RuntimeTerminalOutput,
  TerminalKey,
} from "./types";

const RUNTIMES: readonly RuntimeId[] = ["claude", "codex"];
const LABELS: Readonly<Record<RuntimeId, string>> = {
  claude: "Claude",
  codex: "Codex",
};
const DEFAULT_RUNTIME: RuntimeId = "claude";

export interface RuntimeSelectorOptions {
  readonly preferenceStore?: RuntimePreferenceStore;
  readonly input?: RuntimeTerminalInput;
  readonly output?: RuntimeTerminalOutput;
  readonly readKey?: () => Promise<TerminalKey>;
}

export interface SelectRuntimeInput {
  readonly requestedRuntime?: RuntimeId;
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
  current: RuntimeId,
  selectedIndex: number,
  redraw: boolean,
): void {
  if (redraw) output.write(`\u001b[${RUNTIMES.length + 1}A`);
  for (const [index, runtime] of RUNTIMES.entries()) {
    const pointer = index === selectedIndex ? "❯" : " ";
    const persisted = runtime === current ? " (current)" : "";
    output.write(`\r\u001b[2K  ${pointer} ${LABELS[runtime]}${persisted}\n`);
  }
  output.write("\r\u001b[2K↑/↓ select · Enter confirm · Ctrl+C cancel\n");
}

export class RuntimeSelector {
  private readonly preferenceStore: RuntimePreferenceStore;
  private readonly input?: RuntimeTerminalInput;
  private readonly output: RuntimeTerminalOutput;
  private readonly injectedReadKey?: () => Promise<TerminalKey>;

  constructor(options: RuntimeSelectorOptions = {}) {
    this.preferenceStore = options.preferenceStore ?? new FileRuntimePreferenceStore();
    this.input = options.input ?? (process.stdin as RuntimeTerminalInput);
    this.output = options.output ?? process.stdout;
    this.injectedReadKey = options.readKey;
  }

  async select(input: SelectRuntimeInput): Promise<RuntimeSelection> {
    if (input.requestedRuntime !== undefined) {
      if (!RUNTIMES.includes(input.requestedRuntime)) {
        throw new Error(`invalid runtime \`${String(input.requestedRuntime)}\``);
      }
      return {
        ok: true,
        runtime: input.requestedRuntime,
        source: "explicit",
      };
    }

    const preference = await this.preferenceStore.read();
    if (preference.warning) {
      this.output.write(`WARNING  ${preference.warning}\n`);
    }
    const current = preference.runtime ?? DEFAULT_RUNTIME;
    if (!input.interactive) {
      return {
        ok: true,
        runtime: current,
        source: preference.runtime === null ? "default" : "persisted",
      };
    }

    const selected = await this.prompt(current);
    if (selected === null) return { ok: false, exitCode: 130 };
    await this.preferenceStore.write(selected);
    return { ok: true, runtime: selected, source: "interactive" };
  }

  private async prompt(current: RuntimeId): Promise<RuntimeId | null> {
    if (!this.injectedReadKey && !this.input) {
      throw new Error("interactive runtime selection requires terminal input");
    }
    const wasFlowing = this.input?.readableFlowing === true;
    const wasRaw = Boolean(this.input?.isRaw);
    const keypress = this.injectedReadKey || !this.input
      ? null
      : createKeypressReader(this.input);
    const readKey = this.injectedReadKey ?? keypress!.read;
    let changedRawMode = false;
    let selectedIndex = Math.max(0, RUNTIMES.indexOf(current));

    this.output.write("\nSelect runtime for this ALP session:\n");
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
          selectedIndex = (selectedIndex - 1 + RUNTIMES.length) % RUNTIMES.length;
          renderMenu(this.output, current, selectedIndex, true);
        } else if (key === "down") {
          selectedIndex = (selectedIndex + 1) % RUNTIMES.length;
          renderMenu(this.output, current, selectedIndex, true);
        } else if (key === "enter") {
          return RUNTIMES[selectedIndex];
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

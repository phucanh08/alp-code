import type { RuntimeId as AgentRuntimeId } from "../agents/types";

export type RuntimeId = AgentRuntimeId;
export type RuntimeSelectionSource = "explicit" | "interactive" | "persisted" | "default";
export type TerminalKey = "up" | "down" | "enter" | "cancel" | "other";

export type RuntimeSelection =
  | {
      readonly ok: true;
      readonly runtime: RuntimeId;
      readonly source: RuntimeSelectionSource;
    }
  | {
      readonly ok: false;
      readonly exitCode: 130;
    };

export interface RuntimeTerminalInput {
  readonly isTTY?: boolean;
  readonly readableFlowing?: boolean | null;
  readonly isRaw?: boolean;
  setRawMode?(value: boolean): void;
  resume?(): unknown;
  pause?(): unknown;
  on(event: string, listener: (...args: never[]) => void): unknown;
  removeListener(event: string, listener: (...args: never[]) => void): unknown;
}

export interface RuntimeTerminalOutput {
  readonly isTTY?: boolean;
  write(chunk: string): unknown;
}

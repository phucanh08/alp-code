export interface CommandInvocation {
  readonly executable: string;
  readonly args: readonly string[];
}

export function hookInvocation(
  stableCommand: string,
  hook: "session-boot" | "session-end" | "compact-record",
  args: readonly string[] = [],
): CommandInvocation {
  return Object.freeze({ executable: stableCommand, args: Object.freeze(["hook", hook, ...args]) });
}

function posix(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function windows(value: string, force = false): string {
  if (!force && !/[\s"]/u.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}

export function renderHookCommand(
  invocation: CommandInvocation,
  options: {
    readonly platform: NodeJS.Platform;
    readonly runtime: "claude" | "codex";
    readonly windowsPathCommand?: string;
  },
): string {
  if (options.platform !== "win32") return [invocation.executable, ...invocation.args].map(posix).join(" ");
  if (options.runtime === "codex") {
    const command = options.windowsPathCommand ?? invocation.executable;
    if (/\s/u.test(command)) throw new Error("Codex Windows hook command must have an unquoted first token");
    return [command, ...invocation.args.map((value) => windows(value))].join(" ");
  }
  return [windows(invocation.executable, true), ...invocation.args.map((value) => windows(value))].join(" ");
}

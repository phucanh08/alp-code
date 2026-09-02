import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

/**
 * Matches the launch line of a Windows batch shim: `"<node>" "<script>" %*`, anchored to
 * one line so it cannot straddle the `SET "_prog=…"` line that precedes it in npm's shims.
 */
const LAUNCH_LINE = /"(?:%_prog%|[^"\r\n]*?node(?:\.exe)?)"[ \t]+([^\r\n]+?)[ \t]+%\*[ \t]*$/im;
const ARGUMENT = /"([^"]*)"|(\S+)/g;

export interface SpawnCommand {
  readonly command: string;
  readonly args: readonly string[];
}

function locate(command: string, env: NodeJS.ProcessEnv): string | null {
  if (isAbsolute(command) || /[\\/]/.test(command)) return existsSync(command) ? command : null;
  for (const directory of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, command);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function tokenize(launchArguments: string, directory: string): string[] {
  const tokens: string[] = [];
  ARGUMENT.lastIndex = 0;
  for (let match = ARGUMENT.exec(launchArguments); match; match = ARGUMENT.exec(launchArguments))
    tokens.push((match[1] ?? match[2]).replace(/%~?dp0%?/gi, directory));
  return tokens;
}

/**
 * Node cannot spawn a Windows `.cmd`/`.bat` directly — it fails with EINVAL — and
 * `shell: true` is not an option here: cmd.exe would re-parse the prompt argument, which
 * carries spaces and quotes. Every such shim we launch (`claude.cmd`, `codex.cmd` from
 * npm) wraps a Node script, so read the wrapper and spawn that script ourselves with
 * argv passed through byte for byte.
 *
 * Anything else — a real `.exe`, any POSIX platform, a shim we cannot parse — is returned
 * untouched, so the caller still gets the original error rather than a silent substitute.
 */
export function resolveSpawnCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  nodeExecutable = process.execPath,
): SpawnCommand {
  if (platform !== "win32" || !/\.(?:cmd|bat)$/i.test(command)) return { command, args };

  const file = locate(command, env);
  if (file === null) return { command, args };

  let text: string;
  try { text = readFileSync(file, "utf8"); }
  catch { return { command, args }; }

  const launch = LAUNCH_LINE.exec(text);
  if (launch === null) return { command, args };

  const tokens = tokenize(launch[1], dirname(file));
  return tokens.length === 0 ? { command, args } : { command: nodeExecutable, args: [...tokens, ...args] };
}

import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import type { RuntimeId } from "../agents/types";
import type { RuntimeLaunchSpec } from "./runtime-adapter";
import { resolveSpawnCommand } from "./windows-shim";

/**
 * The launch receipt: which binary actually ran an execution, at what version, authenticated
 * how. Written to `<execution>/context/launch.json` by the backend *before* the process
 * exists, so a spawn that crashes still leaves one.
 *
 * Deliberately not in `policy.json`: the policy is frozen and hashed before the process
 * exists, and the receipt is an event, not a decision. `policy.enforcement.measuredOn` says
 * which version the table was measured on; the receipt says which version ran. When the two
 * disagree the launch still happens — blocking would take ALP down on every CLI update — and
 * the record simply claims less (P3 lowers provenance; `alp doctor` warns).
 */
export interface LaunchProvenanceV1 {
  readonly version: 1;
  readonly executionId: string;
  readonly runtime: RuntimeId;
  /** From `<runtime> --version`; `"unknown"` when that hung, failed or printed nothing usable. */
  readonly runtimeVersion: string;
  readonly platform: NodeJS.Platform;
  /** Detected from the *presence* of a variable or file — never from a value. */
  readonly authMethod: AuthMethod;
  readonly credentialConfigured: boolean;
  /** `sha256` of command, args, cwd and the **names** of the environment — see `launchSpecDigest`. */
  readonly launchSpecDigest: string;
  readonly launchedAt: string;
}

export type AuthMethod = "oauth" | "api-key" | "unknown";

export const DEFAULT_VERSION_TIMEOUT_MS = 2000;

const LAUNCH_RECEIPT_FILE_MODE = 0o600;

/**
 * How the runtime will authenticate, resolved the way the runtimes resolve it: an explicit
 * key wins over a stored login. Only the existence of a variable or a file is consulted; the
 * value never passes through here, so there is nothing a receipt could leak.
 *
 * `keychainHas` covers macOS, where Claude Code keeps its OAuth credential in the keychain
 * rather than in `.credentials.json`; it defaults to "no" so a caller without a keychain
 * (every test, every other platform) sees a pure function of `env` and `exists`.
 */
export function detectAuthMethod(
  runtime: RuntimeId,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
  keychainHas: (service: string) => boolean = () => false,
): AuthMethod {
  const set = (name: string): boolean => typeof env[name] === "string" && env[name] !== "";
  if (runtime === "claude") {
    if (set("ANTHROPIC_API_KEY")) return "api-key";
    if (set("CLAUDE_CODE_OAUTH_TOKEN")) return "oauth";
    const configDirectory = env.CLAUDE_CONFIG_DIR ?? (env.HOME === undefined ? null : join(env.HOME, ".claude"));
    if (configDirectory !== null && exists(join(configDirectory, ".credentials.json"))) return "oauth";
    if (keychainHas("Claude Code-credentials")) return "oauth";
    return "unknown";
  }
  if (set("OPENAI_API_KEY")) return "api-key";
  const codexHome = env.CODEX_HOME ?? (env.HOME === undefined ? null : join(env.HOME, ".codex"));
  if (codexHome !== null && exists(join(codexHome, "auth.json"))) return "oauth";
  return "unknown";
}

/**
 * `security find-generic-password -s <service>` without `-w`: exit status says whether the
 * item exists, and nothing secret reaches stdout because the flag that would print it is
 * not given.
 */
export function macKeychainHas(service: string): boolean {
  if (process.platform !== "darwin") return false;
  try {
    return spawnSync("security", ["find-generic-password", "-s", service], { stdio: "ignore", timeout: DEFAULT_VERSION_TIMEOUT_MS }).status === 0;
  } catch {
    return false;
  }
}

/** The first dotted version in a `--version` line: `2.1.269 (Claude Code)`, `codex-cli 0.154.0`. */
export function parseRuntimeVersion(output: string): string | null {
  return /\b(\d+\.\d+(?:\.\d+)*)\b/.exec(output)?.[1] ?? null;
}

export type VersionRunner = (command: string, args: readonly string[], timeoutMs: number) => Promise<string | null>;

export interface RuntimeVersionReaderOptions {
  readonly timeoutMs?: number;
  /** Defaults to `["--version"]`; a test hands a script path to a Node binary instead. */
  readonly versionArgs?: readonly string[];
  /** Runs the binary and answers stdout, or `null` on any failure — the boundary a test replaces. */
  readonly run?: VersionRunner;
  /** Where a bare command name is looked up; the launch environment, not the parent's. */
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

function locate(command: string, env: NodeJS.ProcessEnv): string | null {
  if (isAbsolute(command) || /[\\/]/.test(command)) return existsSync(command) ? command : null;
  for (const directory of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, command);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function defaultRunner(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): VersionRunner {
  return (command, args, timeoutMs) => new Promise((settle) => {
    const spec = resolveSpawnCommand(command, args, env, platform);
    try {
      execFile(spec.command, spec.args, { env, timeout: timeoutMs, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
        settle(error ? null : stdout);
      });
    } catch {
      settle(null);
    }
  });
}

/**
 * `<runtime> --version`, budgeted and cached.
 *
 * Two seconds is the budget because the receipt is written on the launch path: a version
 * probe that hung would hold every delegation hostage to a CLI's startup time. The cache key
 * is the binary's path and mtime — a new binary at the same path is a new question, and the
 * same binary asked twice in one process is not.
 */
export function createRuntimeVersionReader(options: RuntimeVersionReaderOptions = {}): (command: string) => Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS;
  const versionArgs = options.versionArgs ?? ["--version"];
  const env = options.env ?? process.env;
  const run = options.run ?? defaultRunner(env, options.platform ?? process.platform);
  const cache = new Map<string, Promise<string>>();

  return async (command) => {
    const file = locate(command, env);
    let key: string | null = null;
    if (file !== null) {
      try { key = `${file}\0${statSync(file).mtimeMs}`; } catch { key = null; }
    }
    const cached = key === null ? undefined : cache.get(key);
    if (cached !== undefined) return cached;

    const answer = (async () => {
      let stdout: string | null;
      try { stdout = await run(command, versionArgs, timeoutMs); } catch { stdout = null; }
      return (stdout === null ? null : parseRuntimeVersion(stdout)) ?? "unknown";
    })();
    if (key !== null) cache.set(key, answer);
    return answer;
  };
}

/**
 * Identifies *what was launched*: command, argv, cwd and the sorted **names** of the
 * environment. Two launches that differ only in a variable's value are the same launch —
 * a value can be a secret, and a digest that moved with it would leak one bit per run.
 * `temporaryFiles` is bookkeeping about the launch, not the launch.
 */
export function launchSpecDigest(spec: RuntimeLaunchSpec): string {
  return createHash("sha256")
    .update(JSON.stringify({
      command: spec.command,
      args: [...spec.args],
      cwd: spec.cwd,
      envNames: Object.keys(spec.env).sort(),
    }))
    .digest("hex");
}

export interface BuildLaunchProvenanceInput {
  readonly executionId: string;
  readonly runtime: RuntimeId;
  readonly launchSpec: RuntimeLaunchSpec;
  readonly platform: NodeJS.Platform;
  /** The environment the process will run under — for auth detection by name only. */
  readonly env: NodeJS.ProcessEnv;
  readonly launchedAt: string;
  readonly versionOf: (command: string) => Promise<string>;
  readonly exists: (path: string) => boolean;
  readonly keychainHas?: (service: string) => boolean;
}

export async function buildLaunchProvenance(input: BuildLaunchProvenanceInput): Promise<LaunchProvenanceV1> {
  const authMethod = detectAuthMethod(input.runtime, input.env, input.exists, input.keychainHas);
  return Object.freeze({
    version: 1,
    executionId: input.executionId,
    runtime: input.runtime,
    runtimeVersion: await input.versionOf(input.launchSpec.command),
    platform: input.platform,
    authMethod,
    credentialConfigured: authMethod !== "unknown",
    launchSpecDigest: launchSpecDigest(input.launchSpec),
    launchedAt: input.launchedAt,
  });
}

export async function writeLaunchReceipt(file: string, receipt: LaunchProvenanceV1): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: LAUNCH_RECEIPT_FILE_MODE });
}

/** `null` when no receipt was written; an error for a receipt of another version. */
export async function readLaunchReceipt(file: string): Promise<LaunchProvenanceV1 | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(raw) as Partial<LaunchProvenanceV1> | null;
  if (parsed === null || typeof parsed !== "object" || parsed.version !== 1) {
    throw new Error(`launch receipt at ${file} is not a version 1 record`);
  }
  return parsed as LaunchProvenanceV1;
}

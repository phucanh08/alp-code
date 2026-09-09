import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentsDirectory } from "../install/paths";

type FinalizeExecution = typeof import("../hooks/execution-bridge").finalizeExecution;

const ROLE_PATTERN = /^[a-z][a-z0-9-]*$/;
const EXECUTION_ID_PATTERN = /^exec_[a-zA-Z0-9_-]+$/;
const MAX_CONTINUITY_BYTES = 24 * 1024;
const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 16 * 1024;
const MAX_VALUE_LENGTH = 256;
const SOURCE_WHITELIST = {
  claude: ["session_id", "trigger", "model", "prompt_id", "agent_id", "agent_type"],
  codex: ["session_id", "trigger", "model", "turn_id", "agent_id", "agent_type"],
} as const;

export interface HookDependencies {
  readonly env: NodeJS.ProcessEnv;
  readonly readStdin: () => Buffer;
  readonly write: (text: string) => unknown;
  readonly now: () => string;
  readonly finalize: FinalizeExecution;
}

function defaults(): HookDependencies {
  return {
    env: process.env,
    readStdin: () => {
      try { return readFileSync(0); } catch { return Buffer.alloc(0); }
    },
    write: (text) => process.stdout.write(text),
    now: () => new Date().toISOString(),
    finalize: async (input) => {
      const { finalizeExecution } = await import("../hooks/execution-bridge");
      return finalizeExecution(input);
    },
  };
}

function loadSessionContext(env: NodeJS.ProcessEnv): string {
  if (env.ALP_SESSION_CONTEXT) return readFileSync(env.ALP_SESSION_CONTEXT, "utf8");
  const role = env.ALP_ROLE || "main";
  if (!ROLE_PATTERN.test(role)) throw new Error(`invalid role \`${role}\``);
  const primary = join(agentsDirectory(env), `${role}.md`);
  try { return readFileSync(primary, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !env.ALP_REPO_ROOT) throw error;
    return readFileSync(join(env.ALP_REPO_ROOT, ".alp", "agents", `${role}.md`), "utf8");
  }
}

function loadContinuity(env: NodeJS.ProcessEnv): { text: string; warning: string | null } {
  const file = env.ALP_CONTINUITY_CONTEXT;
  if (!file) return { text: "", warning: null };
  let content: string;
  try { content = readFileSync(file, "utf8"); }
  catch (error) {
    const failure = error as NodeJS.ErrnoException;
    return { text: "", warning: failure.code === "ENOENT" ? null : `ALP continuity not loaded: ${failure.message}` };
  }
  if (!content.trim()) return { text: "", warning: null };
  if (Buffer.byteLength(content) > MAX_CONTINUITY_BYTES) {
    return { text: "", warning: "ALP continuity exceeds its injection bound and was skipped" };
  }
  return { text: content, warning: null };
}

function emitSessionBoot(dependencies: HookDependencies): number {
  let context = "";
  let warning: string | null = null;
  try {
    const session = loadSessionContext(dependencies.env);
    const continuity = loadContinuity(dependencies.env);
    context = continuity.text ? `${session}\n\n${continuity.text}` : session;
    warning = continuity.warning;
  } catch (error) {
    warning = `ALP identity not loaded: ${(error as Error).message}. Run \`alp identity sync\`.`;
  }
  dependencies.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
    ...(warning ? { systemMessage: `⚠️  ${warning}` } : {}),
  }));
  return 0;
}

async function emitSessionEnd(dependencies: HookDependencies): Promise<number> {
  const executionId = dependencies.env.ALP_DELEGATION_EXECUTION_ID || "";
  let message: string;
  try {
    const payload = JSON.parse(dependencies.readStdin().toString("utf8") || "{}") as Record<string, unknown>;
    const output = payload.last_assistant_message ?? payload.output ?? payload.final_output ?? payload.result;
    const result = await dependencies.finalize({ executionId, output });
    message = result.ok
      ? `execution ${executionId} finalized`
      : `execution ${executionId} finalized with issues: ${result.issues.join("; ")}`;
  } catch (error) {
    message = `execution ${executionId} could not be finalized: ${(error as Error).message}`;
  }
  dependencies.write(JSON.stringify({ systemMessage: message }));
  return 0;
}

function filterSource(runtime: "claude" | "codex", payload: unknown): Record<string, string> {
  const source: Record<string, string> = {};
  if (payload !== null && typeof payload === "object") {
    for (const key of SOURCE_WHITELIST[runtime]) {
      const value = (payload as Record<string, unknown>)[key];
      if (typeof value === "string") source[key] = value.slice(0, MAX_VALUE_LENGTH);
      else if (typeof value === "number" || typeof value === "boolean") source[key] = String(value);
    }
  }
  return source;
}

function recordCompact(args: readonly string[], dependencies: HookDependencies): number {
  try {
    const phase = args[0];
    const runtime = args[1];
    if ((phase !== "pre" && phase !== "post") || (runtime !== "claude" && runtime !== "codex")) return 0;
    const executionId = dependencies.env.ALP_DELEGATION_EXECUTION_ID || "";
    const policyHash = dependencies.env.ALP_POLICY_HASH || "";
    const journal = dependencies.env.ALP_COMPACT_EVENTS || "";
    if (!EXECUTION_ID_PATTERN.test(executionId) || !policyHash || !journal) return 0;

    const input = dependencies.readStdin();
    let source: Record<string, string>;
    if (input.length > MAX_STDIN_BYTES) source = { parseError: "stdin exceeded 1 MiB" };
    else {
      try { source = filterSource(runtime, JSON.parse(input.length ? input.toString("utf8") : "{}")); }
      catch (error) { source = { parseError: String((error as Error).message || "invalid JSON").slice(0, MAX_VALUE_LENGTH) }; }
    }
    const line = `${JSON.stringify({ v: 1, at: dependencies.now(), executionId, policyHash, runtime, phase, source })}\n`;
    if (Buffer.byteLength(line) <= MAX_LINE_BYTES) {
      try { appendFileSync(journal, line, { encoding: "utf8", mode: 0o600, flag: "a" }); } catch { /* fail-open */ }
    }
  } catch { /* compact recording is unconditionally fail-open */ }
  return 0;
}

export async function runHookCommand(
  argv: readonly string[],
  dependencies: HookDependencies = defaults(),
): Promise<number> {
  if (argv[0] === "session-boot" && argv.length === 1) return emitSessionBoot(dependencies);
  if (argv[0] === "session-end" && argv.length === 1) return emitSessionEnd(dependencies);
  if (argv[0] === "compact-record") return recordCompact(argv.slice(1), dependencies);
  throw new Error("usage: alp hook session-boot|session-end|compact-record <pre|post> <claude|codex>");
}

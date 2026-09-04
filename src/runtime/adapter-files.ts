import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import type { ExecutionArtifactPaths, IdentityCapsule, PreparedExecution } from "../execution/types";
import { renderSessionContext } from "./render-session-context";
import { renderTaskInput } from "./render-task-input";

let sequence = 0;

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * Resolve a runtime CLI's real command name on PATH. Windows installs of `claude`/`codex`
 * are `.cmd` from npm, `.exe` from winget/native installers, or anything else PATHEXT
 * lists — hardcoding `.cmd` misses every non-npm install even though it's on PATH and
 * working (e.g. this very Claude Code session). Returns null when nothing on PATH matches,
 * so callers can fall back to a platform-appropriate default for error messages.
 */
export async function resolveRuntimeCommand(
  name: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const directories = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  if (platform !== "win32") {
    for (const directory of directories) {
      try { await access(join(directory, name)); return name; } catch { /* continue */ }
    }
    return null;
  }
  const extensions = (env.PATHEXT || DEFAULT_PATHEXT).split(";").map((value) => value.trim()).filter(Boolean);
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = name + extension;
      try { await access(join(directory, candidate)); return candidate; } catch { /* continue */ }
    }
  }
  return null;
}

export async function atomicRuntimeFile(path: string, content: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${++sequence}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return path;
}

export interface RuntimeContextFiles {
  /** Always written. Delivered by the SessionStart hook, never as a turn. */
  readonly sessionContextFile: string;
  /** Written only for a headless run — an interactive session's first turn is the principal's. */
  readonly taskFile: string | null;
}

/**
 * Writes the two context files every runtime needs, and decides which of them exists.
 *
 * Both adapters share this because the split is a property of ALP, not of a harness:
 * session context describes the agent for the whole session and must never create a turn;
 * task input *is* a turn, so it exists only where ALP is the one starting the conversation.
 * Interactive therefore gets no task file at all — there is nothing for an adapter to
 * accidentally hand to the CLI as a positional prompt.
 */
export async function writeRuntimeContextFiles(
  execution: PreparedExecution,
  interactive: boolean,
): Promise<RuntimeContextFiles> {
  const { capsule, policy, artifacts } = execution;
  const sessionContextFile = await atomicRuntimeFile(
    join(artifacts.runtimeDirectory, "session-context.md"),
    renderSessionContext(capsule, policy),
  );
  const taskFile = interactive
    ? null
    : await atomicRuntimeFile(
      join(artifacts.runtimeDirectory, "task.md"),
      renderTaskInput(capsule),
    );
  return Object.freeze({ sessionContextFile, taskFile });
}

/**
 * The positional argument that turns a task file into the session's first turn.
 *
 * Empty for an interactive launch. That emptiness is the whole point of this change, so it
 * is expressed once here rather than repeated as a conditional in each adapter.
 */
export function taskArguments(files: RuntimeContextFiles): readonly string[] {
  return files.taskFile === null
    ? Object.freeze([])
    : Object.freeze([`ALP task is in ${files.taskFile}; execute it.`]);
}

export function baseRuntimeEnvironment(
  capsule: IdentityCapsule,
  files: RuntimeContextFiles,
  artifacts: Pick<ExecutionArtifactPaths, "continuityFile" | "compactEventsFile">,
): Record<string, string> {
  return {
    ALP_ROLE: capsule.role,
    ALP_DELEGATED_ROLE: capsule.role,
    ALP_DELEGATION_EXECUTION_ID: capsule.executionId,
    ALP_DELEGATION_WORKSPACE: capsule.activeWorkspace,
    // Read by `hooks/session-boot.cjs`. Taking it here rather than in each adapter is what
    // stops a runtime from being wired up without it and silently falling back to the
    // static role document, which carries no invariants or policy context.
    ALP_SESSION_CONTEXT: files.sessionContextFile,
    // Bound to the capsule's own policy, not read from a file: this is what
    // `compact-record.cjs` stamps onto every journal line, and what `alp context` checks a
    // checkpoint against before trusting it (invariant 5).
    ALP_POLICY_HASH: capsule.policyHash,
    // Read by `session-boot.cjs` on every SessionStart, `source="compact"` included — the
    // continuity bridge's reinjection channel (plan §8.6).
    ALP_CONTINUITY_CONTEXT: artifacts.continuityFile,
    // Read only by `compact-record.cjs`; unconditional here because the checkpoint and its
    // rendering exist regardless of `ALP_COMPACT_BRIDGE` — only the PreCompact/PostCompact
    // hook registration is gated on that flag (see `compactBridgeEnabled`).
    ALP_COMPACT_EVENTS: artifacts.compactEventsFile,
  };
}

/**
 * Whether this launch should register the PreCompact/PostCompact hooks. Gated on an
 * environment variable rather than a runtime capability check: rollback is unsetting one
 * variable, and Stage 4 of the rollout (plan §18) changes only the default returned here.
 */
export function compactBridgeEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.ALP_COMPACT_BRIDGE === "1";
}

export function runtimeSkillRoots(env: NodeJS.ProcessEnv): string {
  const home = env.HOME ?? env.USERPROFILE;
  const roots = [
    ...(env.ALP_SKILL_ROOTS ?? "").split(delimiter),
    env.ALP_REPO_ROOT ? join(env.ALP_REPO_ROOT, "skills") : "",
    home ? join(home, ".agents", "skills") : "",
    env.CODEX_HOME ? join(env.CODEX_HOME, "skills") : home ? join(home, ".codex", "skills") : "",
    env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, "skills") : home ? join(home, ".claude", "skills") : "",
  ].filter(Boolean).map((value) => resolve(value));
  return [...new Set(roots)].join(delimiter);
}

/**
 * Quotes for a shell, not for JSON. `JSON.stringify` escapes backslashes, so a Windows
 * path came out as `C:\\Users\\...` inside the command — tolerated by path resolution,
 * but wrong, and unreadable in the settings file. Plain double quotes are enough: these
 * are paths we generate ourselves, and neither Windows nor our layout admits a `"`.
 */
export function hookCommand(script: string, nodeExecutable = process.execPath): string {
  return `"${nodeExecutable}" "${script}"`;
}

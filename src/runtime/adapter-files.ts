import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import type { IdentityCapsule } from "../execution/types";

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

export function renderCapsulePrompt(capsule: IdentityCapsule): string {
  const memory = capsule.memoryContext.entries.length === 0
    ? "(no memory entries selected)"
    : capsule.memoryContext.entries
      .map((entry) => `## ${entry.id}\n\n${entry.content}`)
      .join("\n\n");
  // Static identity (`capsule.instructions`) is deliberately absent: the SessionStart hook
  // injects it from `.alp/agents/<role>.md` before turn 1. This file carries only what
  // varies per execution, so reading it costs nothing the hook already paid for.
  return [
    `# ALP execution ${capsule.executionId}`,
    `Role: ${capsule.displayName} (${capsule.role})`,
    `Workspace: ${capsule.activeWorkspace}`,
    "## Invariants",
    capsule.memoryContext.invariantContext,
    "## Policy",
    capsule.memoryContext.policyContext,
    "## Selected memory",
    memory,
    "## Task",
    capsule.task,
    "## Reporting",
    "Answer in prose. Close with your status, what you actually did, and the evidence for it — commands you ran, files you changed, output you saw. Do not claim a step you skipped.",
  ].join("\n\n");
}

export function baseRuntimeEnvironment(capsule: IdentityCapsule): Record<string, string> {
  return {
    ALP_ROLE: capsule.role,
    ALP_DELEGATED_ROLE: capsule.role,
    ALP_DELEGATION_EXECUTION_ID: capsule.executionId,
    ALP_DELEGATION_WORKSPACE: capsule.activeWorkspace,
  };
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

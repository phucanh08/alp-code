import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import type { IdentityCapsule } from "../execution/types";

let sequence = 0;

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
  return [
    `# ALP execution ${capsule.executionId}`,
    `Role: ${capsule.displayName} (${capsule.role})`,
    `Workspace: ${capsule.activeWorkspace}`,
    "## Instructions",
    capsule.instructions,
    "## Invariants",
    capsule.memoryContext.invariantContext,
    "## Policy",
    capsule.memoryContext.policyContext,
    "## Selected memory",
    memory,
    "## Task",
    capsule.task,
    "## Required final output",
    `Return only one JSON value for contract \`${capsule.outputContract.name}\`, with no prose or Markdown fence. It must satisfy this JSON Schema:`,
    JSON.stringify(capsule.outputContract.schema, null, 2),
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

export function hookCommand(script: string, nodeExecutable = process.execPath): string {
  return `${JSON.stringify(nodeExecutable)} ${JSON.stringify(script)}`;
}

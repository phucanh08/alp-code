import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { InstallChannel } from "../install-layout";

function home(env: NodeJS.ProcessEnv): string {
  const value = env.HOME || env.USERPROFILE || homedir();
  if (!value) throw new Error("không xác định được HOME/USERPROFILE");
  return value;
}

export function stateHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.ALP_STATE_HOME ? resolve(env.ALP_STATE_HOME) : join(home(env), ".alp");
}

export function memoryRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.ALP_MEMORY_ROOT ? resolve(env.ALP_MEMORY_ROOT) : join(stateHome(env), "memory");
}

export function agentsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateHome(env), "agents");
}

export function executionsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateHome(env), "executions");
}

export function executionGraphsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateHome(env), "execution-graphs");
}

export function projectsRegistry(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateHome(env), "projects.json");
}

export function installRecord(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateHome(env), "install.json");
}

export function installedDelegationDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateHome(env), "delegation", "installed");
}

export function legacyDelegationDirectory(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = createHash("sha256").update(resolve(root)).digest("hex").slice(0, 12);
  return join(home(env), ".alp", "delegation", key);
}

export function defaultDelegationDirectory(
  root: string,
  env: NodeJS.ProcessEnv,
  channel: InstallChannel,
): string {
  return channel === "dev" ? legacyDelegationDirectory(root, env) : installedDelegationDirectory(env);
}

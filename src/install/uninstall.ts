import { existsSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { InstallLayout } from "../install-layout";
import { memoryRoot, projectsRegistry, stateHome } from "./paths";

const OWNED_STATE = Object.freeze([
  "agents", "hooks", "executions", "delegation", "install.json", "update-check.json", "mode.json", "projects.json",
]);

function within(parent: string, child: string): boolean {
  const relation = relative(resolve(parent), resolve(child));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function backupPath(anchor: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const base = `${anchor}.memory-backup-${stamp}`;
  let candidate = base;
  for (let suffix = 2; existsSync(candidate); suffix += 1) candidate = `${base}-${suffix}`;
  return candidate;
}

function registeredProjects(env: NodeJS.ProcessEnv): readonly string[] {
  try {
    const parsed = JSON.parse(readFileSync(projectsRegistry(env), "utf8")) as { projects?: Array<{ path?: unknown }> };
    return [...new Set((parsed.projects ?? []).flatMap((entry) => typeof entry.path === "string" ? [resolve(entry.path)] : []))];
  } catch { return []; }
}

function cleanupProjects(projects: readonly string[]): void {
  for (const project of projects) {
    for (const relativeFile of [join(".claude", "settings.local.json"), join(".codex", "config.toml")]) {
      const file = join(project, relativeFile);
      try {
        const content = readFileSync(file, "utf8");
        if (!content.toLowerCase().includes("alp init")) continue;
        rmSync(file, { force: true });
        const backup = `${file}.alp-backup`;
        if (existsSync(backup)) renameSync(backup, file);
      } catch { /* absent/read-only projects do not block uninstall */ }
    }
  }
}

function removeOwnedState(root: string): void {
  for (const name of OWNED_STATE) rmSync(join(root, name), { recursive: true, force: true });
  try { if (readdirSync(root).length === 0) rmSync(root, { recursive: false }); } catch { /* preserve foreign state */ }
}

export interface UninstallOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly purgeMemory?: boolean;
  readonly now?: Date;
  readonly platform?: NodeJS.Platform;
  readonly spawnProcess?: typeof spawnSync;
}

export interface UninstallResult {
  readonly memoryBackup: string | null;
  readonly leftovers: readonly string[];
}

export function uninstallBinary(layout: InstallLayout, options: UninstallOptions = {}): UninstallResult {
  if (layout.channel !== "binary") throw new Error("native uninstall only owns the binary channel");
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const installHome = dirname(dirname(layout.installRoot));
  if (dirname(installHome) === installHome) throw new Error(`refusing to uninstall filesystem root: ${installHome}`);
  if (within(installHome, cwd)) throw new Error(`cwd is inside ${installHome}; change directory before uninstalling`);

  const localState = stateHome(env);
  const memory = memoryRoot(env);
  const projects = registeredProjects(env);
  let memoryBackup: string | null = null;
  if (!options.purgeMemory && existsSync(memory)) {
    memoryBackup = backupPath(localState, options.now ?? new Date());
    renameSync(memory, memoryBackup);
  }

  try {
    cleanupProjects(projects);
    const platform = options.platform ?? process.platform;
    if (platform !== "win32") rmSync(layout.stableCommand, { force: true });
    const leftovers: string[] = [];
    if (platform === "win32") {
      // The running executable may stay locked. Remove everything the OS permits and name
      // the immutable home precisely instead of claiming it disappeared.
      try { rmSync(join(installHome, "current"), { recursive: true, force: true }); } catch { /* reported with the home below */ }
      try { rmSync(installHome, { recursive: true, force: true }); } catch { leftovers.push(installHome); }
    } else {
      rmSync(join(installHome, "current"), { recursive: true, force: true });
      rmSync(installHome, { recursive: true, force: true });
    }
    if (options.purgeMemory) rmSync(memory, { recursive: true, force: true });
    removeOwnedState(localState);
    return Object.freeze({ memoryBackup, leftovers: Object.freeze(leftovers) });
  } catch (error) {
    if (memoryBackup && existsSync(memoryBackup) && !existsSync(memory)) {
      try { renameSync(memoryBackup, memory); memoryBackup = null; } catch { /* backup remains recoverable */ }
    }
    throw error;
  }
}

export function uninstallInstallation(layout: InstallLayout, options: UninstallOptions = {}): UninstallResult {
  if (layout.channel === "binary") return uninstallBinary(layout, options);
  if (layout.channel === "dev") throw new Error("refusing to uninstall a dev clone from the compiled CLI; use scripts/alp.cjs so git safety checks run");

  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const cacheRoot = dirname(dirname(dirname(layout.installRoot)));
  if (dirname(cacheRoot) === cacheRoot) throw new Error(`refusing to remove npm cache root: ${cacheRoot}`);
  if (within(cacheRoot, cwd)) throw new Error(`cwd is inside ${cacheRoot}; change directory before uninstalling`);
  const localState = stateHome(env);
  const memory = memoryRoot(env);
  let memoryBackup: string | null = null;
  if (!options.purgeMemory && existsSync(memory)) {
    memoryBackup = backupPath(localState, options.now ?? new Date());
    renameSync(memory, memoryBackup);
  }

  try {
    const removed = (options.spawnProcess ?? spawnSync)("npm", ["uninstall", "--global", "alp-code"], {
      env,
      stdio: "inherit",
    });
    if (removed.error || removed.status !== 0) {
      throw new Error(`npm uninstall -g alp-code failed${removed.error ? `: ${removed.error.message}` : ` (exit ${removed.status})`}`);
    }
    cleanupProjects(registeredProjects(env));
    const leftovers: string[] = [];
    try { rmSync(cacheRoot, { recursive: true, force: true }); }
    catch (error) {
      if ((options.platform ?? process.platform) === "win32") leftovers.push(`${cacheRoot}: ${(error as Error).message}`);
      else throw error;
    }
    if (options.purgeMemory) rmSync(memory, { recursive: true, force: true });
    removeOwnedState(localState);
    return Object.freeze({ memoryBackup, leftovers: Object.freeze(leftovers) });
  } catch (error) {
    if (memoryBackup && existsSync(memoryBackup) && !existsSync(memory)) {
      try { renameSync(memoryBackup, memory); memoryBackup = null; } catch { /* backup remains recoverable */ }
    }
    throw error;
  }
}

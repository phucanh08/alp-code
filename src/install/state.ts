import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { InstallLayout } from "../install-layout";
import { loadDelegationConfig } from "./config";
import {
  agentsDirectory,
  executionsDirectory,
  installRecord,
  legacyDelegationDirectory,
  memoryRoot as resolveMemoryRoot,
  projectsRegistry,
  stateHome as resolveStateHome,
} from "./paths";
import { hookInvocation, renderHookCommand } from "../runtime/hook-command";

export interface EnsureStateOptions {
  readonly layout: InstallLayout;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => string;
}

export interface EnsureStateResult {
  readonly stateHome: string;
  readonly memoryRoot: string;
  readonly channel: InstallLayout["channel"];
  readonly log: readonly { readonly level: string; readonly text: string }[];
}

function mkdirPrivate(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try { chmodSync(directory, 0o700); } catch { /* existing foreign ownership is diagnosed elsewhere */ }
  }
}

function isDirectory(candidate: string): boolean {
  try { return statSync(candidate).isDirectory(); } catch { return false; }
}

function isEmptyish(directory: string): boolean {
  try { return !readdirSync(directory).some((entry) => !entry.startsWith(".")); }
  catch { return true; }
}

export function movePath(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try { renameSync(from, to); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error; }
  cpSync(from, to, { recursive: true });
  rmSync(from, { recursive: true, force: true });
}

function copyMissing(source: string, destination: string, made: string[]): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) copyMissing(from, to, made);
    else if (!existsSync(to)) {
      cpSync(from, to);
      made.push(to);
    }
  }
}

function legacyMemoryCandidates(layout: InstallLayout, env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME || env.USERPROFILE;
  const previous = (() => {
    try { return JSON.parse(readFileSync(installRecord(env), "utf8")) as { root?: string }; }
    catch { return {}; }
  })();
  return [...new Set([
    join(layout.installRoot, "memory"),
    ...(env.ALP_HOME ? [join(resolve(env.ALP_HOME), "memory")] : []),
    ...(home ? [join(home, ".alp-code", "memory")] : []),
    ...(previous.root ? [join(previous.root, "memory")] : []),
  ])];
}

function ensureMemory(layout: InstallLayout, env: NodeJS.ProcessEnv, log: Array<{ level: string; text: string }>): string {
  const destination = resolveMemoryRoot(env);
  if (isEmptyish(destination)) {
    const legacy = legacyMemoryCandidates(layout, env)
      .find((candidate) => resolve(candidate) !== resolve(destination) && isDirectory(candidate) && !isEmptyish(candidate));
    if (legacy) {
      rmSync(destination, { recursive: true, force: true });
      movePath(legacy, destination);
      log.push({ level: "MOVED", text: `memory ${legacy} → ${destination}` });
    }
  }
  mkdirPrivate(destination);
  const seed = join(layout.assetRoot, "scaffold", "memory");
  if (!isDirectory(seed)) throw new Error(`thiếu ${seed} — bản cài hỏng, không dựng lại memory được`);
  const made: string[] = [];
  copyMissing(seed, destination, made);
  for (const directory of [join(destination, "shared", "decisions"), join(destination, "shared", "people"), join(destination, "shared", "reference"), join(destination, "private")]) {
    if (!existsSync(directory)) { mkdirSync(directory, { recursive: true }); made.push(directory); }
  }
  log.push({ level: made.length ? "WROTE" : "OK", text: made.length ? `${made.length} memory paths` : `memory ${destination} đã đủ khung` });
  return destination;
}

function atomicJson(file: string, value: unknown): void {
  mkdirPrivate(dirname(file));
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function repairProjectHooks(
  layout: InstallLayout,
  env: NodeJS.ProcessEnv,
  log: Array<{ level: string; text: string }>,
): void {
  let projects: Array<{ path?: unknown }>;
  try {
    const registry = JSON.parse(readFileSync(projectsRegistry(env), "utf8")) as { projects?: unknown };
    projects = Array.isArray(registry.projects) ? registry.projects : [];
  } catch { return; }
  const command = renderHookCommand(hookInvocation(layout.stableCommand, "session-boot"), {
    platform: process.platform,
    runtime: "claude",
  });
  let repaired = 0;
  for (const project of projects) {
    if (typeof project.path !== "string") continue;
    const file = join(project.path, ".claude", "settings.local.json");
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
      if (parsed.$generatedBy !== "alp init") continue;
      const groups = parsed.hooks?.SessionStart;
      if (!Array.isArray(groups)) continue;
      const owned = groups
        .flatMap((group: any) => Array.isArray(group?.hooks) ? group.hooks : [])
        .find((hook: any) => typeof hook?.command === "string" && (
          /session-boot\.cjs/.test(hook.command) || /\bhook(?:'|"|\s)+\s*(?:'|")?session-boot\b/.test(hook.command)
        ));
      if (!owned || owned.command === command) continue;
      owned.type = "command";
      owned.command = command;
      atomicJson(file, parsed);
      repaired += 1;
    } catch { /* malformed, missing or read-only projects are repair warnings, not state blockers */ }
  }
  if (repaired) log.push({ level: "FIXED", text: `hook command trong ${repaired} project → ${layout.stableCommand}` });
}

function inside(root: string, candidate: string): boolean {
  const relation = relative(resolve(root), resolve(candidate));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function repairProjectSkillLinks(
  layout: InstallLayout,
  previousAssetRoot: string | undefined,
  env: NodeJS.ProcessEnv,
  log: Array<{ level: string; text: string }>,
): void {
  if (!previousAssetRoot || resolve(previousAssetRoot) === resolve(layout.assetRoot)) return;
  let projects: Array<{ path?: unknown }>;
  try {
    const registry = JSON.parse(readFileSync(projectsRegistry(env), "utf8")) as { projects?: unknown };
    projects = Array.isArray(registry.projects) ? registry.projects : [];
  } catch { return; }
  const oldSkills = join(previousAssetRoot, "skills");
  const newSkills = join(layout.assetRoot, "skills");
  let repaired = 0;
  for (const project of projects) {
    if (typeof project.path !== "string") continue;
    for (const directory of [join(project.path, ".claude", "skills"), join(project.path, ".agents", "skills")]) {
      let names: string[];
      try { names = readdirSync(directory); } catch { continue; }
      for (const name of names) {
        const link = join(directory, name);
        try {
          if (!lstatSync(link).isSymbolicLink()) continue;
          const current = resolve(dirname(link), readlinkSync(link));
          if (!inside(oldSkills, current)) continue;
          const replacement = join(newSkills, name);
          rmSync(link, { force: true });
          if (existsSync(replacement)) symlinkSync(replacement, link, process.platform === "win32" ? "junction" : "dir");
          repaired += 1;
        } catch { /* project repair is best effort and doctor remains available */ }
      }
    }
  }
  if (repaired) log.push({ level: "FIXED", text: `${repaired} project skill links → ${newSkills}` });
}

export function ensureState(options: EnsureStateOptions): EnsureStateResult {
  const env = options.env ?? process.env;
  const layout = options.layout;
  const log: Array<{ level: string; text: string }> = [];
  let previousAssetRoot: string | undefined;
  try {
    const previous = JSON.parse(readFileSync(installRecord(env), "utf8")) as { assetRoot?: unknown };
    if (typeof previous.assetRoot === "string") previousAssetRoot = previous.assetRoot;
  } catch { /* first install */ }
  const stateHome = resolveStateHome(env);
  mkdirPrivate(stateHome);
  const memoryRoot = ensureMemory(layout, env, log);
  mkdirPrivate(executionsDirectory(env));
  mkdirPrivate(agentsDirectory(env));

  const delegation = loadDelegationConfig(layout.installRoot, env, layout.channel);
  if (layout.channel !== "dev" && !existsSync(delegation.stateDir)) {
    const legacy = legacyDelegationDirectory(layout.installRoot, env);
    if (legacy !== delegation.stateDir && isDirectory(legacy)) {
      movePath(legacy, delegation.stateDir);
      log.push({ level: "MOVED", text: `delegation state ${legacy} → ${delegation.stateDir}` });
    }
  }
  mkdirPrivate(delegation.stateDir);

  repairProjectSkillLinks(layout, previousAssetRoot, env, log);
  atomicJson(installRecord(env), {
    root: layout.installRoot,
    assetRoot: layout.assetRoot,
    stableCommand: layout.stableCommand,
    channel: layout.channel,
    version: layout.version,
    updatedAt: (options.now ?? (() => new Date().toISOString()))(),
  });
  repairProjectHooks(layout, env, log);
  log.push({ level: "OK", text: `install record → ${layout.channel} ${layout.installRoot}` });
  return Object.freeze({ stateHome, memoryRoot, channel: layout.channel, log: Object.freeze(log) });
}

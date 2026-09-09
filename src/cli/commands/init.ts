import { realpath } from "node:fs/promises";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { hookForwarder } from "../../state-paths";
import { hookInvocation, renderHookCommand } from "../../runtime/hook-command";

export interface RegisteredProject {
  readonly path: string;
}

interface ProjectRegistryDocument {
  readonly version: 1;
  readonly projects: readonly RegisteredProject[];
}

export interface ProjectRegistryStoreOptions {
  readonly file?: string;
}

function within(root: string, target: string): boolean {
  const relation = relative(resolve(root), resolve(target));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export class ProjectRegistryStore {
  readonly file: string;

  constructor(options: ProjectRegistryStoreOptions = {}) {
    this.file = options.file ?? join(homedir(), ".alp", "projects.json");
  }

  async read(): Promise<ProjectRegistryDocument> {
    try {
      const value = JSON.parse(await readFile(this.file, "utf8")) as ProjectRegistryDocument;
      if (value.version !== 1 || !Array.isArray(value.projects)) throw new Error("unsupported project registry");
      return { version: 1, projects: Object.freeze(value.projects.map((entry) => Object.freeze({ ...entry }))) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, projects: [] };
      throw error;
    }
  }

  async register(project: RegisteredProject): Promise<void> {
    const current = await this.read();
    const projects = current.projects.filter((entry) => entry.path !== project.path);
    projects.push(Object.freeze({ ...project }));
    projects.sort((left, right) => left.path.localeCompare(right.path));
    await this.write({ version: 1, projects });
  }

  async unregister(projectPath: string): Promise<void> {
    const current = await this.read();
    await this.write({ version: 1, projects: current.projects.filter((entry) => entry.path !== projectPath) });
  }

  async isRegistered(projectPath: string): Promise<boolean> {
    const canonical = await realpath(projectPath);
    const current = await this.read();
    return current.projects.some((entry) => entry.path === canonical);
  }

  private async write(value: ProjectRegistryDocument): Promise<void> {
    const directory = dirname(this.file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = join(directory, `.${randomUUID()}.projects.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, this.file);
      await chmod(this.file, 0o600);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

export interface InitializeProjectInput {
  readonly project: string;
  /**
   * alp-code checkout. When given, `alp init` writes a project-level SessionStart hook so
   * a hand-opened `claude` in that project loads its ALP identity at turn 1. Without it
   * only delegated executions get identity, because they carry their own settings file.
   */
  readonly repoRoot?: string;
  readonly stableCommand?: string;
  readonly assetRoot?: string;
}

export interface InitializeProjectDependencies {
  readonly store?: ProjectRegistryStore;
}

/**
 * Marker string `deinitializeProject` looks for before deleting the file — it is how we
 * tell a config we generated from one the user wrote themselves.
 */
const EXCLUDE_ENTRIES = Object.freeze([
  ".claude/settings.local.json",
  ".claude/skills/",
  ".agents/skills/",
]);

/**
 * Keeps the generated settings file out of `git status` without touching a tracked file.
 * `.git/info/exclude` is per-clone and never committed, so this stays invisible to the
 * project's collaborators — unlike appending to `.gitignore`.
 */
async function excludeLocally(project: string): Promise<void> {
  const file = join(project, ".git", "info", "exclude");
  try {
    let current = (await exists(file)) ? await readFile(file, "utf8") : "";
    const present = new Set(current.split(/\r?\n/).map((line) => line.trim()));
    const missing = EXCLUDE_ENTRIES.filter((entry) => !present.has(entry));
    if (!missing.length) return;
    await mkdir(dirname(file), { recursive: true });
    const separator = current === "" || current.endsWith("\n") ? "" : "\n";
    current = `${current}${separator}${missing.join("\n")}\n`;
    await writeFile(file, current, "utf8");
  } catch { /* not a git checkout, or exclude unwritable — the settings file still works */ }
}

async function installSkillLinks(project: string, assetRoot: string): Promise<void> {
  const source = join(assetRoot, "skills");
  let entries;
  try { entries = await readdir(source, { withFileTypes: true }); }
  catch { throw new Error(`packaged skills are missing from ${source}`); }
  for (const root of [join(project, ".claude", "skills"), join(project, ".agents", "skills")]) {
    await mkdir(root, { recursive: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const link = join(root, entry.name);
      const target = join(source, entry.name);
      if (await exists(link)) {
        const metadata = await lstat(link);
        if (metadata.isSymbolicLink() && resolve(dirname(link), await readlink(link)) === resolve(target)) continue;
        // A project skill with the same name belongs to the user. Keep it and let the runtime
        // precedence rules decide instead of replacing project content during init.
        continue;
      }
      await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    }
  }
}

function isAlpBootHook(value: unknown): value is { type: string; command: string } {
  if (!value || typeof value !== "object") return false;
  const command = (value as { command?: unknown }).command;
  return typeof command === "string" && (/session-boot\.cjs/.test(command) || /\bhook\s+session-boot\b/.test(command));
}

async function writeProjectSettings(project: string, stableCommand?: string): Promise<void> {
  const file = join(project, ".claude", "settings.local.json");
  let settings: Record<string, any> = {};
  if (await exists(file)) {
    const content = await readFile(file, "utf8");
    if (!content.toLowerCase().includes("alp init")) await rename(file, `${file}.alp-backup`);
    else {
      try { settings = JSON.parse(content) as Record<string, any>; } catch { settings = {}; }
    }
  }
  await mkdir(dirname(file), { recursive: true });
  const hook = stableCommand
    ? renderHookCommand(hookInvocation(stableCommand, "session-boot"), { platform: process.platform, runtime: "claude" })
    : `${JSON.stringify(process.execPath)} ${JSON.stringify(hookForwarder("session-boot"))}`;
  settings.$generatedBy = "alp init";
  settings.hooks ??= {};
  settings.hooks.SessionStart ??= [];
  const groups = settings.hooks.SessionStart as Array<{ hooks?: Array<Record<string, unknown>> }>;
  let owned = groups.flatMap((group) => group.hooks ?? []).find(isAlpBootHook);
  if (!owned) {
    owned = { type: "command", command: hook };
    groups.push({ hooks: [owned] });
  } else {
    owned.type = "command";
    owned.command = hook;
  }
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await excludeLocally(project);
}

export async function initializeProject(
  input: InitializeProjectInput,
  dependencies: InitializeProjectDependencies = {},
): Promise<RegisteredProject> {
  const project = await realpath(input.project);
  const metadata = await lstat(project);
  if (!metadata.isDirectory()) throw new Error(`project is not a directory: ${project}`);
  const store = dependencies.store ?? new ProjectRegistryStore();
  const registered = Object.freeze({ path: project });
  await store.register(registered);
  if (input.repoRoot || input.stableCommand) await writeProjectSettings(project, input.stableCommand);
  if (input.assetRoot) {
    await installSkillLinks(project, input.assetRoot);
    await excludeLocally(project);
  }
  return registered;
}

async function removeEmpty(directory: string): Promise<void> {
  try {
    if ((await readdir(directory)).length === 0) await rm(directory, { recursive: false });
  } catch { /* absent or non-empty */ }
}

async function removeOwnedSkillLinks(project: string, repoRoot: string): Promise<void> {
  const skillsRoot = join(repoRoot, "skills");
  for (const directory of [join(project, ".claude", "skills"), join(project, ".agents", "skills")]) {
    let entries;
    try { entries = await readdir(directory); } catch { continue; }
    for (const name of entries) {
      const link = join(directory, name);
      let metadata;
      try { metadata = await lstat(link); } catch { continue; }
      if (!metadata.isSymbolicLink()) continue;
      const target = await readlink(link);
      const resolved = resolve(dirname(link), target);
      if (within(skillsRoot, resolved)) await rm(link, { force: true });
    }
    await removeEmpty(directory);
    await removeEmpty(dirname(directory));
  }
}

async function cleanupGeneratedConfig(file: string): Promise<void> {
  const backup = `${file}.alp-backup`;
  if (await exists(file)) {
    const content = await readFile(file, "utf8");
    if (content.toLowerCase().includes("alp init")) await rm(file);
  }
  if ((await exists(backup)) && !(await exists(file))) await rename(backup, file);
  await removeEmpty(dirname(file));
}

export interface DeinitializeProjectInput {
  readonly project: string;
  readonly repoRoot: string;
}

export async function deinitializeProject(
  input: DeinitializeProjectInput,
  dependencies: InitializeProjectDependencies = {},
): Promise<void> {
  const project = await realpath(input.project);
  await removeOwnedSkillLinks(project, input.repoRoot);
  await cleanupGeneratedConfig(join(project, ".claude", "settings.local.json"));
  await cleanupGeneratedConfig(join(project, ".codex", "config.toml"));
  await (dependencies.store ?? new ProjectRegistryStore()).unregister(project);
}

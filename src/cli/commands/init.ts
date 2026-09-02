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
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface RegisteredProject {
  readonly path: string;
  readonly backend: string | null;
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

  async backendFor(projectPath: string): Promise<string | null> {
    const canonical = await realpath(projectPath);
    const current = await this.read();
    return current.projects.find((entry) => entry.path === canonical)?.backend ?? null;
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
  readonly backend?: string | null;
  /**
   * alp-code checkout. When given, `alp init` writes a project-level SessionStart hook so
   * a hand-opened `claude` in that project loads its ALP identity at turn 1. Without it
   * only delegated executions get identity, because they carry their own settings file.
   */
  readonly repoRoot?: string;
}

export interface InitializeProjectDependencies {
  readonly store?: ProjectRegistryStore;
}

/**
 * Marker string `deinitializeProject` looks for before deleting the file — it is how we
 * tell a config we generated from one the user wrote themselves.
 */
const EXCLUDE_ENTRY = ".claude/settings.local.json";

/**
 * Keeps the generated settings file out of `git status` without touching a tracked file.
 * `.git/info/exclude` is per-clone and never committed, so this stays invisible to the
 * project's collaborators — unlike appending to `.gitignore`.
 */
async function excludeLocally(project: string): Promise<void> {
  const file = join(project, ".git", "info", "exclude");
  try {
    const current = (await exists(file)) ? await readFile(file, "utf8") : "";
    if (current.split(/\r?\n/).some((line) => line.trim() === EXCLUDE_ENTRY)) return;
    await mkdir(dirname(file), { recursive: true });
    const separator = current === "" || current.endsWith("\n") ? "" : "\n";
    await writeFile(file, `${current}${separator}${EXCLUDE_ENTRY}\n`, "utf8");
  } catch { /* not a git checkout, or exclude unwritable — the settings file still works */ }
}

async function writeProjectSettings(project: string, repoRoot: string): Promise<void> {
  const file = join(project, ".claude", "settings.local.json");
  if (await exists(file)) {
    const content = await readFile(file, "utf8");
    if (!content.toLowerCase().includes("alp init")) await rename(file, `${file}.alp-backup`);
  }
  await mkdir(dirname(file), { recursive: true });
  const hook = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(repoRoot, "hooks", "session-boot.cjs"))}`;
  await writeFile(file, `${JSON.stringify({
    $generatedBy: "alp init",
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: hook }] }] },
  }, null, 2)}\n`, "utf8");
  await excludeLocally(project);
}

export async function initializeProject(
  input: InitializeProjectInput,
  dependencies: InitializeProjectDependencies = {},
): Promise<RegisteredProject> {
  const project = await realpath(input.project);
  const metadata = await lstat(project);
  if (!metadata.isDirectory()) throw new Error(`project is not a directory: ${project}`);
  if (input.backend !== undefined && input.backend !== null && !/^[a-z][a-z0-9-]*$/.test(input.backend)) {
    throw new Error(`invalid backend \`${input.backend}\``);
  }
  const store = dependencies.store ?? new ProjectRegistryStore();
  const previous = (await store.read()).projects.find((entry) => entry.path === project);
  const registered = Object.freeze({ path: project, backend: input.backend ?? previous?.backend ?? null });
  await store.register(registered);
  if (input.repoRoot) await writeProjectSettings(project, input.repoRoot);
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

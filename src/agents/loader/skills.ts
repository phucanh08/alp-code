import { lstat, readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { SkillBinding } from "../types";

/** §5.7.3 — a skill list nobody bounded is a hole in the context budget (§4.9). */
export const MAX_SKILLS_PER_AGENT = 20;
export const SKILLREF_SUFFIX = ".skillref";
export const SKILLS_DIRECTORY = "skills";

export type { SkillBinding };

export interface SkillScan {
  /** `<agent>/skills` — the one root an execution resolves this agent's skills from. */
  readonly directory: string;
  readonly bindings: readonly SkillBinding[];
  readonly issues: readonly string[];
}

function within(root: string, target: string): boolean {
  const relation = relative(root, target);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

/**
 * Reads the skill grants of one agent out of its own `skills/` directory.
 *
 * **The directory is the grant list** (§5.7): an agent sees what was placed or pointed into
 * its own `skills/`, never all of `.alp/skills/`. There is no `skills:` field in `agent.yaml`
 * to disagree with it.
 *
 * Three entry shapes, and one escape rule over all of them. A skill root is a read grant
 * (§4.4), so a link out of the sanctioned trees would turn "may read its skills" into "may
 * read anywhere" while `workspace.readRoots` still said otherwise. An escape denies the whole
 * agent rather than the single link: an agent whose grants were partly refused is one running
 * with authority nobody described.
 */
export async function scanAgentSkills(options: {
  readonly agentDirectory: string;
  readonly projectRoot: string;
  /** `<assetRoot>/skills` — the built-in skills a link may legitimately reach. */
  readonly builtinSkillsRoot: string;
}): Promise<SkillScan> {
  const directory = join(options.agentDirectory, SKILLS_DIRECTORY);
  const issues: string[] = [];
  const bindings: SkillBinding[] = [];

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return { directory, bindings: [], issues: [] };
  }

  const sanctioned = await Promise.all(
    [join(options.projectRoot, ".alp", SKILLS_DIRECTORY), options.builtinSkillsRoot]
      .map(async (root) => { try { return await realpath(root); } catch { return resolve(root); } }),
  );
  const agentSkillsReal = await realpath(directory).catch(() => resolve(directory));

  const seen = new Set<string>();
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = join(directory, entry.name);
    let name: string;
    let kind: SkillBinding["kind"];
    let target: string;

    if (entry.isSymbolicLink()) {
      name = entry.name;
      kind = "symlink";
      const link = await readlink(entryPath);
      target = resolve(directory, link);
      // Exactly one hop (§5.7.2 rule 3): a chain is a way to launder the destination past a
      // reader who checked only the first link.
      const hop = await lstat(target).catch(() => null);
      if (hop?.isSymbolicLink()) {
        issues.push(`skill \`${name}\` points at another symlink; one hop is the limit`);
        continue;
      }
    } else if (entry.isFile() && entry.name.endsWith(SKILLREF_SUFFIX)) {
      name = entry.name.slice(0, -SKILLREF_SUFFIX.length);
      kind = "skillref";
      const content = await readFile(entryPath, "utf8");
      const lines = content.split("\n").map((line) => line.trim()).filter((line) => line !== "");
      if (lines.length !== 1) {
        issues.push(`skillref \`${entry.name}\` must hold exactly one path`);
        continue;
      }
      const [reference] = lines;
      // Relative only. An absolute path inside a checked-in file is a machine's layout
      // written into the repo, and the `..` case is left to the destination check below —
      // where it is answered by where the path *lands*, not by how it is spelled.
      if (isAbsolute(reference)) {
        issues.push(`skillref \`${entry.name}\` must hold a relative path`);
        continue;
      }
      target = resolve(directory, reference);
    } else if (entry.isDirectory()) {
      name = entry.name;
      kind = "directory";
      target = entryPath;
    } else {
      issues.push(`\`${entry.name}\` is neither a skill directory, a symlink, nor a \`${SKILLREF_SUFFIX}\` file`);
      continue;
    }

    if (name === "") {
      issues.push(`\`${entry.name}\` has no skill name`);
      continue;
    }
    if (seen.has(name)) {
      issues.push(`skill \`${name}\` is granted twice`);
      continue;
    }
    seen.add(name);

    let real: string;
    try {
      real = await realpath(target);
    } catch {
      issues.push(`skill \`${name}\` points at \`${target}\`, which does not exist`);
      continue;
    }
    // A real directory is the skill itself and lives inside the agent's own tree; a link has
    // to land in one of the two trees a project may grant from.
    const allowed = kind === "directory"
      ? within(agentSkillsReal, real)
      : sanctioned.some((root) => within(root, real));
    if (!allowed) {
      issues.push(`skill \`${name}\` resolves to \`${real}\`, outside \`.alp/skills\` and the built-in skills`);
      continue;
    }
    if (!(await stat(join(real, "SKILL.md")).then((file) => file.isFile()).catch(() => false))) {
      issues.push(`skill \`${name}\` has no SKILL.md`);
      continue;
    }

    bindings.push({ name, kind, path: real });
  }

  if (bindings.length > MAX_SKILLS_PER_AGENT) {
    issues.push(`${bindings.length} skills granted, over the ${MAX_SKILLS_PER_AGENT} allowed`);
  }

  return { directory, bindings, issues };
}

import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProjectAgents, scanAgentSkills, MAX_SKILLS_PER_AGENT } from "../../src/agents/loader";
import { agentProject, cleanupAgentProjects, variant } from "../support/agent-file";
import { removeTemporary } from "../support/temporary-root";

const REPO_ROOT = process.cwd();
const BUILTIN_SKILLS = join(REPO_ROOT, "skills");

const outsideRoots: string[] = [];

afterEach(cleanupAgentProjects);
afterEach(async () => { await Promise.all(outsideRoots.splice(0).map(removeTemporary)); });

/** The fixture with the `Skill` tool, since a granted `skills/` needs one to be invoked. */
const WITH_SKILL_TOOL = variant({ "tools: [Read, Glob, Grep, Bash]": "tools: [Read, Glob, Grep, Bash, Skill]" });

async function projectWithSkills(build: (paths: {
  readonly project: string;
  readonly agentSkills: string;
  readonly sharedSkills: string;
}) => Promise<void>, file = WITH_SKILL_TOOL): Promise<string> {
  const project = await agentProject({ migrator: file });
  const agentSkills = join(project, ".alp", "agents", "migrator", "skills");
  const sharedSkills = join(project, ".alp", "skills");
  await mkdir(agentSkills, { recursive: true });
  await mkdir(sharedSkills, { recursive: true });
  await build({ project, agentSkills, sharedSkills });
  return project;
}

/** A real skill directory in neither sanctioned tree — what an escape actually points at. */
async function outsideSkill(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "alp-outside-skill-"));
  outsideRoots.push(root);
  return skillDirectory(root, "elsewhere");
}

async function skillDirectory(root: string, name: string): Promise<string> {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8");
  return path;
}

const scan = (project: string) => scanAgentSkills({
  agentDirectory: join(project, ".alp", "agents", "migrator"),
  projectRoot: project,
  builtinSkillsRoot: BUILTIN_SKILLS,
});

describe("the skills directory is the grant list", () => {
  it("grants a real directory, a symlink into `.alp/skills`, and a `.skillref`", async () => {
    const project = await projectWithSkills(async ({ agentSkills, sharedSkills }) => {
      await skillDirectory(agentSkills, "framework-migration");
      await skillDirectory(sharedSkills, "house-conventions");
      await skillDirectory(sharedSkills, "release-drill");
      await symlink(join("..", "..", "..", "skills", "house-conventions"), join(agentSkills, "house-conventions"));
      await writeFile(join(agentSkills, "release-drill.skillref"), "../../../skills/release-drill\n", "utf8");
    });

    const result = await scan(project);

    expect(result.issues).toEqual([]);
    expect(result.bindings.map((binding) => [binding.name, binding.kind])).toEqual([
      ["framework-migration", "directory"],
      ["house-conventions", "symlink"],
      ["release-drill", "skillref"],
    ]);
  });

  /**
   * The shipped tree is named, not linked. `~/.alp-code/versions/<tag>/skills` is replaced by
   * `alp update`, so a checked-in relative link to `git` would name a directory that moves.
   */
  it("grants a shipped skill by catalog name, alongside the directory grants", async () => {
    const project = await projectWithSkills(
      async ({ agentSkills }) => { await skillDirectory(agentSkills, "framework-migration"); },
      variant({ "tools: [Read, Glob, Grep, Bash]": "tools: [Read, Glob, Grep, Bash, Skill]\n  skills: [git]" }),
    );

    const { loaded, failed } = await loadProjectAgents({ projectRoot: project, builtinSkillsRoot: BUILTIN_SKILLS });

    expect(failed).toEqual([]);
    expect(loaded[0].definition.capabilities.skills).toEqual(["git", "framework-migration"]);
    expect(loaded[0].definition.capabilities.skillBindings?.map((binding) => binding.name))
      .toEqual(["framework-migration"]);
  });

  it("refuses a name that is neither in the catalog nor in the directory", async () => {
    const project = await projectWithSkills(
      async () => {},
      variant({ "tools: [Read, Glob, Grep, Bash]": "tools: [Read, Glob, Grep, Bash, Skill]\n  skills: [house-conventions]" }),
    );

    const { failed } = await loadProjectAgents({ projectRoot: project, builtinSkillsRoot: BUILTIN_SKILLS });

    expect(failed[0].issues.join("\n")).toContain("a project skill belongs in `skills/`, not here");
  });

  it("refuses the same skill granted both ways", async () => {
    const project = await projectWithSkills(
      async ({ agentSkills }) => { await skillDirectory(agentSkills, "git"); },
      variant({ "tools: [Read, Glob, Grep, Bash]": "tools: [Read, Glob, Grep, Bash, Skill]\n  skills: [git]" }),
    );

    const { failed } = await loadProjectAgents({ projectRoot: project, builtinSkillsRoot: BUILTIN_SKILLS });

    expect(failed[0].issues.join("\n")).toContain("granted twice: named here and present in `skills/`");
  });

  it("reaches the runtime as this execution's own first skill root", async () => {
    const project = await projectWithSkills(async ({ agentSkills }) => {
      await skillDirectory(agentSkills, "framework-migration");
    });

    const [agent] = (await loadProjectAgents({ projectRoot: project, builtinSkillsRoot: BUILTIN_SKILLS })).loaded;

    expect(agent.definition.capabilities.skills).toEqual(["framework-migration"]);
    expect(agent.definition.capabilities.skillRoots).toEqual([join(project, ".alp", "agents", "migrator", "skills")]);
    expect(agent.definition.capabilities.skillBindings?.[0]).toMatchObject({ kind: "directory" });
  });

  it("grants nothing when the directory is absent", async () => {
    const project = await agentProject();

    const result = await scan(project);

    expect(result).toMatchObject({ bindings: [], issues: [] });
  });
});

describe("escape and shape rules (§5.7.2)", () => {
  /**
   * The rule this pins: a skill root is a read grant, so a link out of the sanctioned trees
   * turns "may read its skills" into "may read anywhere" while `workspace.readRoots` still
   * says otherwise. It denies the whole agent — an agent whose grants were partly refused is
   * one running with authority nobody described.
   */
  it("denies a symlink that leaves `.alp/skills` and the shipped tree", async () => {
    const outside = await outsideSkill();
    const project = await projectWithSkills(async ({ agentSkills }) => {
      await symlink(outside, join(agentSkills, "elsewhere"));
    });

    const result = await scan(project);

    expect(result.issues.join("\n")).toMatch(/resolves to .*, outside `\.alp\/skills`/);
    expect(result.bindings).toEqual([]);
  });

  it("denies a `.skillref` pointing outside as firmly as a symlink", async () => {
    const outside = await outsideSkill();
    const project = await projectWithSkills(async ({ agentSkills }) => {
      await writeFile(join(agentSkills, "elsewhere.skillref"), `${relative(agentSkills, outside)}\n`, "utf8");
    });

    expect((await scan(project)).issues.join("\n")).toMatch(/outside `\.alp\/skills`/);
  });

  it("refuses an absolute `.skillref`", async () => {
    const project = await projectWithSkills(async ({ agentSkills, sharedSkills }) => {
      const target = await skillDirectory(sharedSkills, "house-conventions");
      await writeFile(join(agentSkills, "house-conventions.skillref"), `${target}\n`, "utf8");
    });

    expect((await scan(project)).issues.join("\n")).toContain("must hold a relative path");
  });

  it("refuses a `.skillref` holding more than one path", async () => {
    const project = await projectWithSkills(async ({ agentSkills }) => {
      await writeFile(join(agentSkills, "two.skillref"), "../a\n../b\n", "utf8");
    });

    expect((await scan(project)).issues.join("\n")).toContain("exactly one path");
  });

  it("follows a link exactly one hop", async () => {
    const project = await projectWithSkills(async ({ agentSkills, sharedSkills }) => {
      await skillDirectory(sharedSkills, "house-conventions");
      await symlink("house-conventions", join(sharedSkills, "alias"));
      await symlink(join("..", "..", "..", "skills", "alias"), join(agentSkills, "alias"));
    });

    expect((await scan(project)).issues.join("\n")).toContain("one hop is the limit");
  });

  it("refuses a directory with no SKILL.md", async () => {
    const project = await projectWithSkills(async ({ agentSkills }) => {
      await mkdir(join(agentSkills, "empty"), { recursive: true });
    });

    expect((await scan(project)).issues.join("\n")).toContain("has no SKILL.md");
  });

  it("refuses a dangling link", async () => {
    const project = await projectWithSkills(async ({ agentSkills }) => {
      await symlink(join("..", "..", "..", "skills", "gone"), join(agentSkills, "gone"));
    });

    expect((await scan(project)).issues.join("\n")).toContain("does not exist");
  });

  it("refuses a loose file that is neither skill nor reference", async () => {
    const project = await projectWithSkills(async ({ agentSkills }) => {
      await writeFile(join(agentSkills, "notes.md"), "hello\n", "utf8");
    });

    expect((await scan(project)).issues.join("\n")).toContain("neither a skill directory");
  });

  it("bounds the list at the budget (§5.7.3)", async () => {
    const project = await projectWithSkills(async ({ agentSkills }) => {
      for (let index = 0; index <= MAX_SKILLS_PER_AGENT; index += 1) {
        await skillDirectory(agentSkills, `skill-${String(index).padStart(2, "0")}`);
      }
    });

    expect((await scan(project)).issues.join("\n")).toContain(`over the ${MAX_SKILLS_PER_AGENT} allowed`);
  });

  it("denies the agent, not just the link", async () => {
    const outside = await outsideSkill();
    const project = await projectWithSkills(async ({ agentSkills }) => {
      await skillDirectory(agentSkills, "framework-migration");
      await symlink(outside, join(agentSkills, "elsewhere"));
    });

    const result = await loadProjectAgents({ projectRoot: project, builtinSkillsRoot: BUILTIN_SKILLS });

    expect(result.loaded).toEqual([]);
    expect(result.failed[0].issues.join("\n")).toContain("outside `.alp/skills`");
  });
});

describe("specific beats general (§5.7.1)", () => {
  it("shadows a shipped skill for one role without touching another", async () => {
    const project = await projectWithSkills(async ({ agentSkills }) => {
      await skillDirectory(agentSkills, "code-review");
    });

    const { loaded } = await loadProjectAgents({ projectRoot: project, builtinSkillsRoot: BUILTIN_SKILLS });
    const [root] = loaded[0].definition.capabilities.skillRoots ?? [];

    // The role's own root comes first, so `Skill(code-review)` resolves to the project's copy
    // for this agent; every other role still resolves the shipped one.
    expect(root).toBe(join(project, ".alp", "agents", "migrator", "skills"));
    expect(loaded[0].definition.capabilities.skills).toEqual(["code-review"]);
  });
});

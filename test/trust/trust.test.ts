import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProjectAgents } from "../../src/agents/loader";
import { agentRegistry } from "../../src/agents/registry";
import { runAgentShow } from "../../src/cli/commands/agent-show";
import { runAgentAdd, runAgentList, runAgentUntrust } from "../../src/cli/commands/agent-trust";
import { hashAgentDefinition } from "../../src/execution/execution-policy";
import {
  authorityOf,
  diffAuthority,
  readTrustedAgents,
  resolveTrust,
  trustAgent,
  trustedRegistryFor,
  untrustAgent,
} from "../../src/trust";
import { agentProject, cleanupAgentProjects, VALID_AGENT_FILE, variant } from "../support/agent-file";
import { cleanupDryRuns } from "../support/agent-dry-run";

const REPO_ROOT = process.cwd();
const ENVIRONMENT = {
  hooksDirectory: join(REPO_ROOT, "hooks"),
  skillsRoot: join(REPO_ROOT, "skills"),
  env: { HOME: tmpdir(), PATH: process.env.PATH ?? "" },
};

afterEach(cleanupAgentProjects);
afterEach(cleanupDryRuns);

async function trustFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "alp-trust-")), "trusted-agents.json");
}

function prompt(answer: string) {
  const asked: string[] = [];
  return {
    asked,
    open: () => ({
      ask: (question: string) => { asked.push(question); return Promise.resolve(answer); },
      close: () => {},
    }),
  };
}

async function addAgent(options: {
  readonly project: string;
  readonly file: string;
  readonly answer?: string;
  readonly interactive?: boolean;
  readonly id?: string;
}): Promise<{ readonly code: number; readonly output: string; readonly asked: readonly string[] }> {
  const id = options.id ?? "migrator";
  const load = await loadProjectAgents({ projectRoot: options.project });
  const asker = prompt(options.answer ?? "yes");
  let output = "";
  const code = await runAgentAdd({ id, project: options.project }, load, {
    ...ENVIRONMENT,
    write: (text) => { output += text; },
    interactive: options.interactive ?? true,
    openPrompt: asker.open,
    trustFile: options.file,
  });
  return { code, output, asked: asker.asked };
}

describe("authority diff", () => {
  it("names what a re-trust would grant and what it would take away", () => {
    const before = authorityOf(agentRegistry.get("search"));
    const after = authorityOf(agentRegistry.get("main"));

    const changes = diffAuthority(before, after);

    expect(changes.join("\n")).toContain("tools: +Write +Edit");
    expect(changes.join("\n")).toContain("workspace write: +.");
    expect(changes.some((line) => line.startsWith("model (claude)"))).toBe(true);
  });

  it("says nothing when nothing moved", () => {
    expect(diffAuthority(authorityOf(agentRegistry.get("review")), authorityOf(agentRegistry.get("review")))).toEqual([]);
  });
});

describe("the trust store", () => {
  it("writes one record per project and agent, readable only by its owner", async () => {
    const file = await trustFile();
    const record = {
      project: "/app", id: "migrator", definitionHash: "a".repeat(64),
      trustedAt: "2026-09-10T00:00:00.000Z", sourcePath: "/app/.alp/agents/migrator/agent.yaml",
      authority: authorityOf(agentRegistry.get("search")),
    };

    await trustAgent(record, file);
    await trustAgent({ ...record, project: "/other" }, file);

    expect(readTrustedAgents(file).records).toHaveLength(2);
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o077).toBe(0);
    }
  });

  it("replaces an approval for the same project and agent rather than stacking one", async () => {
    const file = await trustFile();
    const record = {
      project: "/app", id: "migrator", definitionHash: "a".repeat(64),
      trustedAt: "2026-09-10T00:00:00.000Z", sourcePath: "/app/x.yaml",
      authority: authorityOf(agentRegistry.get("search")),
    };

    await trustAgent(record, file);
    await trustAgent({ ...record, definitionHash: "b".repeat(64) }, file);
    const { records } = readTrustedAgents(file);

    expect(records).toHaveLength(1);
    expect(records[0].definitionHash).toBe("b".repeat(64));
  });

  /**
   * Fail-closed on a file nobody can read: a corrupt store must not be treated as "no
   * constraints", which is what silently ignoring it would amount to.
   */
  it("trusts nothing when the store is unreadable", async () => {
    const file = await trustFile();
    await writeFile(file, "{ not json", "utf8");

    const read = readTrustedAgents(file);

    expect(read.records).toEqual([]);
    expect(read.warning).toContain("nothing is trusted");
  });

  it("removes an approval, and says so when there was none", async () => {
    const file = await trustFile();
    await trustAgent({
      project: "/app", id: "migrator", definitionHash: "a".repeat(64),
      trustedAt: "2026-09-10T00:00:00.000Z", sourcePath: "/app/x.yaml",
      authority: authorityOf(agentRegistry.get("search")),
    }, file);

    expect(await untrustAgent("/app", "migrator", file)).toBe(true);
    expect(await untrustAgent("/app", "migrator", file)).toBe(false);
    expect(readTrustedAgents(file).records).toEqual([]);
  });
});

describe("resolveTrust", () => {
  it("separates never-approved, approved, and edited-since-approved", async () => {
    const project = await agentProject();
    const { loaded } = await loadProjectAgents({ projectRoot: project });
    const hash = hashAgentDefinition(loaded[0].definition);

    expect(resolveTrust(loaded, [], project)[0]).toMatchObject({ status: "untrusted" });

    const record = {
      project, id: "migrator", definitionHash: hash,
      trustedAt: "2026-09-10T00:00:00.000Z", sourcePath: loaded[0].sourcePath,
      authority: authorityOf(loaded[0].definition),
    };
    expect(resolveTrust(loaded, [record], project)[0]).toMatchObject({ status: "trusted" });
    expect(resolveTrust(loaded, [{ ...record, definitionHash: "b".repeat(64) }], project)[0])
      .toMatchObject({ status: "changed" });
  });

  it("does not carry an approval from one project to another", async () => {
    const project = await agentProject();
    const { loaded } = await loadProjectAgents({ projectRoot: project });
    const record = {
      project: "/somewhere/else", id: "migrator",
      definitionHash: hashAgentDefinition(loaded[0].definition),
      trustedAt: "2026-09-10T00:00:00.000Z", sourcePath: loaded[0].sourcePath,
      authority: authorityOf(loaded[0].definition),
    };

    expect(resolveTrust(loaded, [record], project)[0]).toMatchObject({ status: "untrusted" });
  });
});

describe("trustedRegistryFor", () => {
  it("keeps an unapproved agent out of the registry and says why", async () => {
    const project = await agentProject();

    const result = await trustedRegistryFor(project, { trustFile: await trustFile() });

    expect(result.registry.has("migrator")).toBe(false);
    expect(result.registry.get("main").delegatesTo).not.toContain("migrator");
    expect(result.notices.join("\n")).toContain("UNTRUSTED  migrator is not approved");
  });

  it("lets `main` delegate to an approved agent", async () => {
    const project = await agentProject();
    const file = await trustFile();
    await addAgent({ project, file });

    const result = await trustedRegistryFor(project, { trustFile: file });

    expect(result.registry.has("migrator")).toBe(true);
    expect(result.registry.get("main").delegatesTo).toContain("migrator");
    expect(result.notices).toEqual([]);
  });

  /**
   * §5.6 step 3: a definition that changed after approval is a **deny**, not a warning. The
   * notice exists so the person who edited it can tell an edit apart from a bug.
   */
  it("denies an agent that was edited after it was trusted", async () => {
    const project = await agentProject();
    const file = await trustFile();
    await addAgent({ project, file });
    await writeFile(
      join(project, ".alp", "agents", "migrator", "agent.yaml"),
      variant({ 'purpose: "Migrate one module per execution and prove the migration with tests."': 'purpose: "Delete whatever the caller names."' }),
      "utf8",
    );

    const result = await trustedRegistryFor(project, { trustFile: file });

    expect(result.registry.has("migrator")).toBe(false);
    expect(result.notices.join("\n")).toContain("DENIED     migrator changed after it was trusted");
  });
});

describe("alp agent add", () => {
  it("runs every tier, prints the authority, then asks — and records the hash on yes", async () => {
    const project = await agentProject();
    const file = await trustFile();

    const { code, output, asked } = await addAgent({ project, file });

    expect(code).toBe(0);
    expect(output).toContain("TIER 3   deny paths");
    expect(output).toContain("Authority");
    expect(output).toContain("Egress");
    expect(output).toContain("HASH     ");
    expect(asked[0]).toContain("Type yes to confirm");
    const { loaded } = await loadProjectAgents({ projectRoot: project });
    expect(readTrustedAgents(file).records[0].definitionHash).toBe(hashAgentDefinition(loaded[0].definition));
  }, 30_000);

  it("records nothing when the answer is not yes", async () => {
    const project = await agentProject();
    const file = await trustFile();

    const { code, output } = await addAgent({ project, file, answer: "y" });

    expect(code).toBe(1);
    expect(output).toContain("REFUSED  `migrator` was not trusted");
    expect(readTrustedAgents(file).records).toEqual([]);
  }, 30_000);

  /** There is no `--yes`; the one place it would be used is the place nobody is reading. */
  it("refuses without a terminal", async () => {
    const project = await agentProject();
    const file = await trustFile();

    const { code, output } = await addAgent({ project, file, interactive: false });

    expect(code).toBe(1);
    expect(output).toContain("trust needs a terminal");
    expect(readTrustedAgents(file).records).toEqual([]);
  }, 30_000);

  it("refuses a definition the loader would not accept", async () => {
    const project = await agentProject({ migrator: variant({ 'readRoots: ["."]': 'readRoots: ["/etc"]' }) });
    const file = await trustFile();

    const { code, output } = await addAgent({ project, file });

    expect(code).toBe(1);
    expect(output).toContain("does not load; there is nothing to trust yet");
    expect(readTrustedAgents(file).records).toEqual([]);
  });

  it("is a no-op when the same file is already trusted", async () => {
    const project = await agentProject();
    const file = await trustFile();
    await addAgent({ project, file });

    const { code, output, asked } = await addAgent({ project, file });

    expect(code).toBe(0);
    expect(output).toContain("is already trusted at");
    expect(asked).toEqual([]);
  }, 30_000);

  it("prints the capability diff when an approved file changed", async () => {
    const project = await agentProject();
    const file = await trustFile();
    await addAgent({ project, file });
    await writeFile(
      join(project, ".alp", "agents", "migrator", "agent.yaml"),
      variant({ "tools: [Read, Glob, Grep, Bash]": "tools: [Read, Glob, Grep]" }),
      "utf8",
    );

    const { code, output } = await addAgent({ project, file });

    expect(code).toBe(0);
    expect(output).toContain("RETRUST  previously trusted at");
    expect(output).toContain("tools: -Bash");
  }, 30_000);

  it("says the authority is unchanged when only the prompt moved", async () => {
    const project = await agentProject();
    const file = await trustFile();
    await addAgent({ project, file });
    await writeFile(
      join(project, ".alp", "agents", "migrator", "agent.yaml"),
      variant({ '"Never migrate more than one module per execution."': '"Never migrate two modules at once."' }),
      "utf8",
    );

    const { output } = await addAgent({ project, file });

    expect(output).toContain("authority unchanged; the prompt or workflow moved");
  }, 30_000);
});

describe("skill overlays for a built-in (§5.7.5)", () => {
  async function overlayProject(): Promise<string> {
    const project = await agentProject({});
    const skills = join(project, ".alp", "agents", "review", "skills", "house-conventions");
    await mkdir(skills, { recursive: true });
    await writeFile(join(skills, "SKILL.md"), "---\nname: house-conventions\n---\n", "utf8");
    return project;
  }

  it("leaves the built-in on its shipped skills until the overlay is approved", async () => {
    const project = await overlayProject();
    const file = await trustFile();

    const result = await trustedRegistryFor(project, { trustFile: file });

    expect(result.registry.get("review").capabilities.skills)
      .toEqual(agentRegistry.get("review").capabilities.skills);
    expect(result.notices.join("\n")).toContain("skill overlay for review");
    expect(result.notices.join("\n")).toContain("runs with its shipped skills");
  });

  it("adds the project skill once the overlay is trusted", async () => {
    const project = await overlayProject();
    const file = await trustFile();

    const added = await addAgent({ project, file, id: "review" });
    const result = await trustedRegistryFor(project, { trustFile: file });

    expect(added.code).toBe(0);
    expect(result.registry.get("review").capabilities.skills).toContain("house-conventions");
    expect(result.registry.get("review").capabilities.skillRoots?.[0])
      .toBe(join(project, ".alp", "agents", "review", "skills"));
    expect(result.notices).toEqual([]);
  }, 30_000);

  /** An overlay may add skills; it may not hand a role the tool to reach them (§5.7.5). */
  it("refuses an overlay on a role with no `Skill` tool", async () => {
    const project = await agentProject({});
    const skills = join(project, ".alp", "agents", "titling", "skills", "house");
    await mkdir(skills, { recursive: true });
    await writeFile(join(skills, "SKILL.md"), "# house\n", "utf8");

    const result = await trustedRegistryFor(project, { trustFile: await trustFile() });

    expect(result.notices.join("\n")).toContain("holds no `Skill` tool");
    expect(result.registry.get("titling").capabilities.skills).toEqual([]);
  });
});

describe("alp agent show", () => {
  it("prints the resolve order so a shadowed skill is visible", async () => {
    const project = await agentProject({});
    const skills = join(project, ".alp", "agents", "review", "skills", "code-review");
    await mkdir(skills, { recursive: true });
    await writeFile(join(skills, "SKILL.md"), "# project code-review\n", "utf8");
    let output = "";

    const code = runAgentShow({ id: "review", project }, await loadProjectAgents({ projectRoot: project }), {
      ...ENVIRONMENT, write: (text) => { output += text; }, interactive: false, trustFile: await trustFile(),
    });

    expect(code).toBe(0);
    expect(output).toContain("built-in + skill overlay");
    expect(output).toContain("skill resolve order (first match wins)");
    expect(output).toContain(`1. ${join(project, ".alp", "agents", "review", "skills")}`);
    expect(output).toMatch(/code-review\s+directory\s+\S/);
    // The shipped `code-review` is shadowed, not held twice.
    const granted = /\n  skills\s+(.+)\n/.exec(output)?.[1].split(", ") ?? [];
    expect(granted.filter((skill) => skill === "code-review")).toHaveLength(1);
  });

  it("prints a built-in with no project file at all", async () => {
    let output = "";

    const code = runAgentShow({ id: "search", project: REPO_ROOT },
      await loadProjectAgents({ projectRoot: REPO_ROOT }),
      { ...ENVIRONMENT, write: (text) => { output += text; }, interactive: false, trustFile: await trustFile() });

    expect(code).toBe(0);
    expect(output).toContain("source          built-in");
    expect(output).not.toContain("trust ");
  });
});

describe("alp agent list and untrust", () => {
  it("shows every agent file and whether a session can reach it", async () => {
    const project = await agentProject({ migrator: VALID_AGENT_FILE, broken: "schemaVersion: 1\nid: broken\n" });
    const file = await trustFile();
    let output = "";

    const code = runAgentList(
      { project, json: false },
      await loadProjectAgents({ projectRoot: project }),
      { ...ENVIRONMENT, write: (text) => { output += text; }, interactive: false, trustFile: file },
    );

    expect(code).toBe(1);
    expect(output).toContain("UNTRUSTED  migrator");
    expect(output).toContain("UNLOADABLE broken");
  });

  it("removes an approval, and the agent leaves the registry with it", async () => {
    const project = await agentProject();
    const file = await trustFile();
    await addAgent({ project, file });
    let output = "";

    const code = await runAgentUntrust({ id: "migrator", project }, {
      ...ENVIRONMENT, write: (text) => { output += text; }, interactive: false, trustFile: file,
    });

    expect(code).toBe(0);
    expect(output).toContain("no longer trusted");
    expect((await trustedRegistryFor(project, { trustFile: file })).registry.has("migrator")).toBe(false);
  }, 30_000);
});

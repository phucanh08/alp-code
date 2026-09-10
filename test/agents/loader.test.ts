import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_FILE_MAX_BYTES,
  createCandidateRegistry,
  loadProjectAgents,
  parseAgentFile,
} from "../../src/agents/loader";
import { CODE_NATIVE_HOUSE_RULES } from "../../src/agents/shared/house-rules";
import { renderInstructions } from "../../src/agents/shared/voice";
import { cleanupAgentProjects, VALID_AGENT_FILE, variant } from "../support/agent-file";
import { removeTemporary } from "../support/temporary-root";

const roots: string[] = [];
afterEach(cleanupAgentProjects);
afterEach(async () => { await Promise.all(roots.splice(0).map(removeTemporary)); });

async function project(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "alp-loader-"));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content, "utf8");
  }
  return root;
}

const VALID = VALID_AGENT_FILE;

describe("parseAgentFile — the untrusted boundary", () => {
  it("refuses a YAML bomb rather than expanding it", () => {
    const bomb = [
      "a: &a [x,x,x,x,x,x,x,x,x]",
      "b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]",
      "c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]",
      "schemaVersion: 1",
    ].join("\n");

    const parsed = parseAgentFile(bomb);

    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.issues[0]).toMatch(/[Aa]lias/);
  });

  it("refuses a duplicated key instead of letting the last one win", () => {
    const parsed = parseAgentFile(variant({ "  tools: [Read, Glob, Grep, Bash]": "  tools: [Read]\n  tools: [Read, Bash]" }));

    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.issues.join("\n")).toMatch(/unique/i);
  });

  it("refuses a second document riding along", () => {
    const parsed = parseAgentFile(`${VALID}\n---\nid: stowaway\n`);

    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.issues.join("\n")).toMatch(/multiple documents/i);
  });

  it("refuses a file over the size cap before parsing it", () => {
    const parsed = parseAgentFile(`${VALID}\n# ${"x".repeat(AGENT_FILE_MAX_BYTES)}`);

    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.issues[0]).toContain("over the");
  });

  it("refuses an unrecognised key rather than dropping it", () => {
    const parsed = parseAgentFile(variant({ "capabilities:": "capabilties:\n  tools: []\ncapabilities:" }));

    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.issues.join("\n")).toMatch(/capabilties|unrecognized|Unrecognized/);
  });

  it("refuses a schema version this build cannot honour", () => {
    const parsed = parseAgentFile(variant({ "schemaVersion: 1": "schemaVersion: 2" }));

    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.issues.join("\n")).toContain("schemaVersion");
  });
});

describe("loadProjectAgents", () => {
  it("builds a leaf agent that reports to main and delegates to nobody", async () => {
    const root = await project({ ".alp/agents/migrator/agent.yaml": VALID });

    const result = await loadProjectAgents({ projectRoot: root });

    expect(result.failed).toEqual([]);
    const [agent] = result.loaded;
    expect(agent.definition).toMatchObject({
      id: "migrator",
      reportsTo: "main",
      delegatesTo: [],
      capabilities: { workspace: { readRoots: ["."], writeRoots: [] }, subagents: [], mcpServers: [] },
      output: { name: "migrator-result" },
    });
    expect(agent.definition.workflow.states.REPORT.terminal).toBe(true);
  });

  it("carries the house rules a file did not ask to drop", async () => {
    const root = await project({ ".alp/agents/migrator/agent.yaml": VALID });

    const [agent] = (await loadProjectAgents({ projectRoot: root })).loaded;
    const rendered = renderInstructions(agent.definition.instructions);

    for (const rule of CODE_NATIVE_HOUSE_RULES) expect(rendered).toContain(rule);
    expect(rendered).toContain("Never migrate more than one module per execution.");
  });

  it("drops them only when the file says so", async () => {
    const root = await project({
      ".alp/agents/migrator/agent.yaml": variant({ "  role:": "  houseRules: none\n  role:" }),
    });

    const [agent] = (await loadProjectAgents({ projectRoot: root })).loaded;

    expect(agent.definition.instructions.rules).toEqual(["Never migrate more than one module per execution."]);
  });

  it.each([
    ["a write root", { '  workspace:\n    readRoots: ["."]': '  workspace:\n    readRoots: ["."]\n    writeRoots: ["."]' }, /workspace write is not available/],
    ["a read root outside the project", { 'readRoots: ["."]': 'readRoots: ["/etc"]' }, /must stay inside the project/],
    ["another role's private memory", { '"private:migrator"]\n    write': '"private:main"]\n    write' }, /another role's private memory/],
    ["a write outside its own private scope", { 'write: ["private:migrator"]': 'write: [shared]' }, /only writable scope/],
    ["a skill named without the tool to invoke it", { "tools: [Read, Glob, Grep, Bash]": "tools: [Read, Glob, Grep, Bash]\n  skills: [git]" }, /has no `Skill` tool to invoke them/],
    ["the `Skill` tool with no skill granted", { "tools: [Read, Glob, Grep, Bash]": "tools: [Read, Glob, Grep, Bash, Skill]" }, /grants no skill — that is a grant on every skill root/],
    ["an in-process subagent", { "tools: [Read, Glob, Grep, Bash]": "tools: [Read, Glob, Grep, Bash]\n  subagents: [explore]" }, /not in the subagent catalog/],
    ["an MCP server", { "tools: [Read, Glob, Grep, Bash]": "tools: [Read, Glob, Grep, Bash]\n  mcpServers: [docs]" }, /not trusted on this machine/],
    ["a tool the coordinator does not hold", { "tools: [Read, Glob, Grep, Bash]": "tools: [Read, Glob, Grep, Bash, Task]" }, /Invalid option|not held by/],
    ["a workflow state allowing an ungranted tool", { "allowedTools: [Read, Glob, Grep]": "allowedTools: [Read, Glob, Write]" }, /which this agent does not hold/],
    ["a model no runtime claims", { "claude: claude-opus-5": "claude: claude-imaginary-9" }, /not in MODEL_RUNTIMES/],
    ["an id belonging to a built-in", { "id: migrator": "id: review" }, /belongs to a built-in role|directory/],
    ["an output contract that is not text", { "  kind: text": "  kind: json" }, /kind/],
  ])("refuses %s", async (_label, replacements, message) => {
    const root = await project({ ".alp/agents/migrator/agent.yaml": variant(replacements) });

    const result = await loadProjectAgents({ projectRoot: root });

    expect(result.loaded).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].issues.join("\n")).toMatch(message);
  });

  it("refuses a file whose id does not match its directory", async () => {
    const root = await project({ ".alp/agents/migrator/agent.yaml": variant({ "id: migrator": "id: other" }) });

    const result = await loadProjectAgents({ projectRoot: root });

    expect(result.failed[0].issues[0]).toMatch(/declares id `other` but lives in directory `migrator`/);
  });

  it("reports every issue at once rather than the first", async () => {
    const root = await project({
      ".alp/agents/migrator/agent.yaml": variant({
        'readRoots: ["."]': 'readRoots: ["/etc"]\n    writeRoots: ["/etc"]',
        "claude: claude-opus-5": "claude: claude-imaginary-9",
      }),
    });

    const result = await loadProjectAgents({ projectRoot: root });

    expect(result.failed[0].issues.length).toBeGreaterThanOrEqual(3);
  });

  it("treats a directory with no agent.yaml as a skill overlay for that built-in", async () => {
    const root = await project({ ".alp/agents/review/skills/house/SKILL.md": "# house\n" });

    const result = await loadProjectAgents({ projectRoot: root });

    expect(result).toMatchObject({ loaded: [], failed: [] });
    expect(result.overlays.map((overlay) => overlay.id)).toEqual(["review"]);
    expect(result.overlays[0].definition.capabilities.skills).toContain("house");
  });

  it("ignores a directory that is neither an agent nor a built-in", async () => {
    const root = await project({ ".alp/agents/notes/README.md": "# notes\n" });

    const result = await loadProjectAgents({ projectRoot: root });

    expect(result).toMatchObject({ loaded: [], failed: [], overlays: [] });
  });

  it("refuses an overlay for a role that holds no `Skill` tool", async () => {
    const root = await project({ ".alp/agents/titling/skills/house/SKILL.md": "# house\n" });

    const result = await loadProjectAgents({ projectRoot: root });

    expect(result.failed[0].issues.join("\n")).toContain("`titling` holds no `Skill` tool");
  });

  it("returns nothing for a project with no `.alp/agents`", async () => {
    const result = await loadProjectAgents({ projectRoot: await project({}) });

    expect(result).toMatchObject({ loaded: [], failed: [], overlays: [] });
  });

  it("loads the sound agents in a project that also has a broken one", async () => {
    const root = await project({
      ".alp/agents/migrator/agent.yaml": VALID,
      ".alp/agents/broken/agent.yaml": "schemaVersion: 1\nid: broken\n",
    });

    const result = await loadProjectAgents({ projectRoot: root });

    expect(result.loaded.map((agent) => agent.id)).toEqual(["migrator"]);
    expect(result.failed.map((failure) => failure.id)).toEqual(["broken"]);
  });
});

describe("createCandidateRegistry", () => {
  it("lets the coordinator reach a candidate without touching the shipped registry", async () => {
    const root = await project({ ".alp/agents/migrator/agent.yaml": VALID });
    const { loaded } = await loadProjectAgents({ projectRoot: root });

    const registry = createCandidateRegistry(loaded);

    expect(registry.get("main").delegatesTo).toContain("migrator");
    expect(registry.get("migrator").reportsTo).toBe("main");
    const { agentRegistry } = await import("../../src/agents/registry");
    expect(agentRegistry.get("main").delegatesTo).not.toContain("migrator");
    expect(agentRegistry.has("migrator")).toBe(false);
  });
});

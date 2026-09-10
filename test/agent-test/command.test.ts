import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineAgent } from "../../src/agents/agent-definition";
import { renderAgentTestReport, testAgent } from "../../src/agent-test";
import { agentRegistry, createAgentRegistry } from "../../src/agents/registry";
import type { AgentDefinition, AgentId } from "../../src/agents/types";
import { parseAgentCommand, runAgentCommand, type AgentCommandInput } from "../../src/cli/commands/agent-test";
import { parseAlpArgs } from "../../src/cli/alp";
import { cleanupDryRuns } from "../support/agent-dry-run";
import { removeTemporary } from "../support/temporary-root";

const ROLE_IDS = agentRegistry.list().map((definition) => definition.id);
const REPO_ROOT = process.cwd();
const ENVIRONMENT = {
  hooksDirectory: join(REPO_ROOT, "hooks"),
  skillsRoot: join(REPO_ROOT, "skills"),
  env: { HOME: tmpdir(), PATH: process.env.PATH ?? "" },
};

/** A definition that passes `createAgentRegistry` — the point of the tests that use it. */
function probe(overrides: Partial<AgentDefinition<unknown>> = {}): AgentDefinition<unknown> {
  return defineAgent({
    id: "probe" as AgentId,
    displayName: "Probe 🧪",
    model: { claude: "claude-haiku-4-5", codex: "gpt-5.6-luna" },
    reasoningEffort: { claude: "low", codex: "low" },
    reportsTo: "principal",
    delegatesTo: [],
    capabilities: {
      tools: ["Read"],
      skills: [],
      subagents: [],
      mcpServers: [],
      memory: { read: ["private:probe"], write: ["private:probe"] },
      workspace: { readRoots: ["."], writeRoots: [] },
    },
    instructions: { role: "Probe", purpose: "Probe instructions", rules: [] },
    workflow: {
      id: "probe-workflow",
      initial: "REPORT",
      states: { REPORT: { allowedTools: [], transitions: [], terminal: true } },
    },
    output: {
      name: "probe-output",
      schema: {},
      validate: (value) => typeof value === "string" && value.trim().length > 0
        ? { ok: true, value }
        : { ok: false, issues: ["empty"] },
    },
    ...overrides,
  });
}

export const VALID_AGENT_FILE = `
schemaVersion: 1
id: migrator
displayName: "Migrator 🔧"
model: { claude: claude-opus-5, codex: gpt-5.6-terra }
reasoningEffort: { claude: high, codex: medium }
instructions:
  role: "Migrator, the framework migration specialist"
  purpose: "Migrate one module per execution and prove the migration with tests."
  rules:
    - "Never migrate more than one module per execution."
capabilities:
  tools: [Read, Glob, Grep, Bash]
  memory:
    read: [shared, "project:*", "private:migrator"]
    write: ["private:migrator"]
  workspace:
    readRoots: ["."]
workflow:
  - { id: ASSESS, allowedTools: [Read, Glob, Grep] }
  - { id: REPORT, allowedTools: [] }
output:
  kind: text
`.trimStart();

const projectRoots: string[] = [];

async function customAgentProject(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "alp-agent-project-"));
  projectRoots.push(root);
  await mkdir(join(root, ".alp", "agents", "migrator"), { recursive: true });
  await writeFile(join(root, ".alp", "agents", "migrator", "agent.yaml"), source, "utf8");
  return root;
}

afterEach(cleanupDryRuns);
afterEach(async () => { await Promise.all(projectRoots.splice(0).map(removeTemporary)); });

describe("alp agent test — tiers 1–3 on the shipped roles", () => {
  /**
   * Milestone M0 of the vision doc, stated as a test: the tooling has to clear all three
   * tiers on every built-in before §5 may open the same path to definitions a principal
   * writes. A role that cannot pass the check is not a candidate for being the example.
   */
  it.each(ROLE_IDS)("passes every tier for %s", async (role) => {
    const report = await testAgent({ role, registry: agentRegistry, ...ENVIRONMENT });

    expect(report.checks.filter((check) => check.status === "fail")).toEqual([]);
    expect(report.stoppedAt).toBeNull();
    expect(report.ok).toBe(true);
    expect(new Set(report.checks.map((check) => check.tier))).toEqual(new Set([1, 2, 3]));
  }, 30_000);

  it("discloses authority, egress and cost for the role it prepared", async () => {
    const report = await testAgent({ role: "review", registry: agentRegistry, ...ENVIRONMENT });

    expect(report.disclosure?.authority.some((row) => row.startsWith("| Tools |"))).toBe(true);
    expect(report.disclosure?.egress.join("\n")).toContain("no MCP server granted");
    expect(report.disclosure?.cost.join("\n")).toContain("mode `medium` runs this role on");
    expect(Object.keys(report.disclosure?.launch ?? {})).toEqual(["claude", "codex"]);
  }, 30_000);

  it("renders findings with the tier that produced them", async () => {
    const rendered = renderAgentTestReport({
      role: "probe", displayName: "Probe 🧪", mode: "medium",
      checks: [{ tier: 1, id: "workflow", status: "fail", detail: "`EXECUTE` allows ungranted Bash" }],
      disclosure: null, stoppedAt: 1, ok: false,
    });

    expect(rendered).toContain("TIER 1   static");
    expect(rendered).toContain("RESULT   1 of 1 checks failed");
    expect(rendered).toContain("Tiers after 1 were not run");
  });
});

describe("tier 1 catches what the registry accepts", () => {
  /**
   * `createAgentRegistry` never compares a workflow state's `allowedTools` against the role's
   * own grant, so a state may name a tool the role does not hold: the registry loads, and the
   * workflow silently promises an authority the runtime ACL will refuse. That gap is why tier
   * 1 re-checks invariants rather than trusting the load that produced the definition.
   */
  it("rejects a workflow state that allows an ungranted tool, and stops before tier 2", async () => {
    const registry = createAgentRegistry([probe({
      workflow: {
        id: "probe-workflow",
        initial: "EXECUTE",
        states: {
          EXECUTE: { allowedTools: ["Bash"], transitions: ["REPORT"] },
          REPORT: { allowedTools: [], transitions: [], terminal: true },
        },
      },
    })]);

    const report = await testAgent({ role: "probe", registry, ...ENVIRONMENT });

    expect(report.stoppedAt).toBe(1);
    expect(report.checks.find((check) => check.id === "workflow")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("allows ungranted Bash"),
    });
    expect(report.checks.some((check) => check.tier > 1)).toBe(false);
  });

  it("rejects an unreachable workflow state", async () => {
    const registry = createAgentRegistry([probe({
      workflow: {
        id: "probe-workflow",
        initial: "REPORT",
        states: {
          REPORT: { allowedTools: [], transitions: [], terminal: true },
          ORPHAN: { allowedTools: [], transitions: [], terminal: true },
        },
      },
    })]);

    const report = await testAgent({ role: "probe", registry, tiers: [1], ...ENVIRONMENT });

    expect(report.checks.find((check) => check.id === "workflow")?.detail).toContain("unreachable: ORPHAN");
  });

  it("rejects a skill that is named but not on disk", async () => {
    const report = await testAgent({
      role: "search", registry: agentRegistry, tiers: [1],
      ...ENVIRONMENT, skillsRoot: join(tmpdir(), "alp-no-skills-here"),
    });

    expect(report.checks.find((check) => check.id === "skill-assets")).toMatchObject({ status: "fail" });
  });

  it("rejects a model no runtime claims", async () => {
    const registry = createAgentRegistry([probe({
      model: { claude: "claude-imaginary-9", codex: "gpt-5.6-luna" },
    })]);

    const report = await testAgent({ role: "probe", registry, tiers: [1], ...ENVIRONMENT });

    expect(report.checks.find((check) => check.id === "model-runtime")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("claude-imaginary-9"),
    });
  });
});

describe("tier 3 probes every ceiling a role has", () => {
  it("names one deny path per class of grant", async () => {
    const report = await testAgent({ role: "search", registry: agentRegistry, tiers: [3], ...ENVIRONMENT });
    const ids = report.checks.map((check) => check.id);

    expect(ids).toEqual(expect.arrayContaining([
      "tool-not-granted", "raw-runtime-tool", "indirect-command",
      "private-memory", "skill-not-granted", "subagent-not-granted", "mcp-not-granted",
      "workspace-scope-mismatch", "workspace-read-only", "workspace-not-granted",
      "workspace-write-not-granted", "delegation-not-allowed",
      "definition-mutation", "policy-mutation",
    ]));
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
    // Every probe has to report the code, not just the refusal — that is the tier.
    expect(report.checks.every((check) => /→ [A-Z_]+$/.test(check.detail))).toBe(true);
  });

  it("skips the write probe for a role that declares a write root", async () => {
    const report = await testAgent({ role: "main", registry: agentRegistry, tiers: [3], ...ENVIRONMENT });

    expect(report.checks.map((check) => check.id)).not.toContain("workspace-write-not-granted");
    expect(report.checks.find((check) => check.id === "delegation-not-allowed")?.detail)
      .toContain("launching this role");
  });
});

describe("parseAgentCommand", () => {
  it("routes `alp agent` through the CLI parser", () => {
    expect(parseAlpArgs(["agent", "test", "main"])).toEqual({ command: "agent", args: ["test", "main"] });
  });

  it("defaults the project to the caller's cwd", () => {
    expect(parseAgentCommand(["test", "--all"], "/caller/project"))
      .toMatchObject({ roles: [], all: true, project: "/caller/project" });
  });

  it("accepts a project, tiers, mode and json", () => {
    expect(parseAgentCommand(["test", "review", "--project", "../app", "--tier", "1", "--mode=high", "--json"], "/caller/project"))
      .toEqual({ roles: ["review"], all: false, project: "/caller/app", tiers: [1], mode: "high", json: true });
  });

  it.each([
    [["test"], /usage: alp agent test/],
    [["test", "main", "--all"], /roles or --all, not both/],
    [["test", "main", "--tier", "9"], /--tier must be one of 1, 2, 3/],
    [["test", "main", "--depth"], /unknown option `--depth`/],
    [["test", "main", "--project"], /--project needs a value/],
    [["list"], /usage: alp agent test/],
  ])("refuses %s", (args, message) => {
    expect(() => parseAgentCommand(args, "/caller/project")).toThrowError(message);
  });
});

describe("runAgentCommand", () => {
  const run = async (input: Partial<AgentCommandInput> & { readonly project: string }) => {
    let output = "";
    const code = await runAgentCommand(
      { roles: [], all: false, tiers: [1], json: false, ...input },
      { ...ENVIRONMENT, write: (text) => { output += text; } },
    );
    return { code, output };
  };

  it("names the roles that exist when given one that does not", async () => {
    await expect(run({ project: REPO_ROOT, roles: ["migrator"] }))
      .rejects.toThrowError(/unknown agent `migrator`; known: main, search/);
  });

  it("emits one JSON object for one role", async () => {
    const { code, output } = await run({ project: REPO_ROOT, roles: ["titling"], json: true });

    expect(code).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ reports: { role: "titling", ok: true }, candidates: [] });
  });

  /**
   * The end of the path §5 opens: a definition the principal wrote, held to the ceiling,
   * and put through the same three tiers as a built-in — without being trusted, and without
   * `alp delegate` being able to reach it.
   */
  it("tests a custom agent from `.alp/agents/` and says it is not trusted", async () => {
    const root = await customAgentProject(VALID_AGENT_FILE);

    const { code, output } = await run({ project: root, roles: ["migrator"], tiers: [1, 3] });

    expect(code).toBe(0);
    expect(output).toContain("AGENT    migrator — Migrator 🔧");
    expect(output).toContain("is a candidate from `.alp/agents/`, not a trusted agent");
    expect(output).not.toContain("FAIL");
  });

  it("reports a definition the ceiling refused, and does not test it", async () => {
    const root = await customAgentProject(VALID_AGENT_FILE.replace('readRoots: ["."]', 'readRoots: ["/etc"]'));

    const { code, output } = await run({ project: root, roles: ["migrator"] });

    expect(code).toBe(1);
    expect(output).toContain("AGENT-FILE migrator");
    expect(output).toContain("must stay inside the project");
    expect(output).not.toContain("TIER 1");
  });

  it("keeps an unrelated broken file out of the exit code of a question about a built-in", async () => {
    const root = await customAgentProject("schemaVersion: 1\nid: migrator\n");

    const { code, output } = await run({ project: root, roles: ["titling"] });

    expect(code).toBe(0);
    expect(output).toContain("AGENT-FILE migrator");
    expect(output).toContain("RESULT   ");
  });
});

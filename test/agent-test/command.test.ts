import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineAgent } from "../../src/agents/agent-definition";
import { renderAgentTestReport, testAgent } from "../../src/agent-test";
import { agentRegistry, createAgentRegistry } from "../../src/agents/registry";
import type { AgentDefinition, AgentId } from "../../src/agents/types";
import { parseAgentCommand, runAgentCommand } from "../../src/cli/commands/agent-test";
import { parseAlpArgs } from "../../src/cli/alp";
import { cleanupDryRuns } from "../support/agent-dry-run";

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
    instructions: () => "Probe instructions",
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

afterEach(cleanupDryRuns);

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

  it("expands --all to every registered role", () => {
    expect(parseAgentCommand(["test", "--all"], agentRegistry).roles).toEqual(ROLE_IDS);
  });

  it("accepts tiers, mode and json", () => {
    expect(parseAgentCommand(["test", "review", "--tier", "1", "--mode=high", "--json"], agentRegistry))
      .toEqual({ roles: ["review"], tiers: [1], mode: "high", json: true });
  });

  it("names the roles that exist when given one that does not", () => {
    expect(() => parseAgentCommand(["test", "migrator"], agentRegistry))
      .toThrowError(/unknown agent `migrator`; known: main, search/);
  });

  it.each([
    [["test"], /usage: alp agent test/],
    [["test", "main", "--all"], /roles or --all, not both/],
    [["test", "main", "--tier", "9"], /--tier must be one of 1, 2, 3/],
    [["test", "main", "--depth"], /unknown option `--depth`/],
    [["list"], /usage: alp agent test/],
  ])("refuses %s", (args, message) => {
    expect(() => parseAgentCommand(args, agentRegistry)).toThrowError(message);
  });
});

describe("runAgentCommand", () => {
  it("exits 1 and prints the finding when a definition is broken", async () => {
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
    let output = "";

    const code = await runAgentCommand(
      { roles: ["probe"], tiers: [1], json: false },
      { registry, ...ENVIRONMENT, write: (text) => { output += text; } },
    );

    expect(code).toBe(1);
    expect(output).toContain("FAIL  workflow");
    expect(output).toContain("allows ungranted Bash");
  });

  it("emits one JSON object for one role", async () => {
    let output = "";

    const code = await runAgentCommand(
      { roles: ["titling"], tiers: [1], json: true },
      { registry: agentRegistry, ...ENVIRONMENT, write: (text) => { output += text; } },
    );

    expect(code).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ role: "titling", ok: true, disclosure: null });
  });
});

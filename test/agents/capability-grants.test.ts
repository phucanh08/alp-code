import { mkdtemp, mkdir, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineAgent } from "../../src/agents/agent-definition";
import { SKILL_CATALOG, type CapabilityCatalog } from "../../src/agents/capability-catalog";
import { createAgentRegistry } from "../../src/agents/registry";
import type { AgentDefinition, AgentId } from "../../src/agents/types";
import { createExecutionPolicy } from "../../src/execution/execution-policy";
import type { ExecutionPolicy, PreparedExecution } from "../../src/execution/types";
import { PolicyEngine } from "../../src/policy/policy-engine";
import { ClaudeRuntimeAdapter } from "../../src/runtime/claude-adapter";
import { CodexRuntimeAdapter } from "../../src/runtime/codex-adapter";
import { claudePermissions } from "../../src/runtime/permission-rules";
import { removeTemporary } from "../support/temporary-root";

/**
 * `capabilities.skills` / `.subagents` / `.mcpServers` — the three grants §5.3 declares by
 * name and §5.5 puts a ceiling on. A name is only a grant if something enforces it, so
 * these tests follow one name the whole way: definition -> registry invariant -> policy
 * snapshot -> the runtime flag that makes it true.
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTemporary(root)));
});

/** A catalog of things this test trusts, standing in for what the principal has declared. */
const catalog: CapabilityCatalog = Object.freeze({
  skills: Object.freeze(["code-review", "git"]),
  subagents: Object.freeze({
    prober: {
      description: "Reads files and reports what it found.",
      prompt: "You are a prober. Read only.",
      tools: Object.freeze(["Read", "Grep"] as const),
    },
  }),
  mcpServers: Object.freeze({
    docs: {
      description: "Library documentation lookup.",
      egress: "network" as const,
      command: "npx",
      args: Object.freeze(["-y", "docs-mcp"]),
    },
  }),
});

function probe(overrides: Partial<AgentDefinition<unknown>> = {}): AgentDefinition<unknown> {
  const id = (overrides.id ?? "probe") as AgentId;
  return {
    id,
    displayName: "Probe",
    model: { claude: "claude-probe", codex: "codex-probe" },
    reasoningEffort: { claude: "low", codex: "low" },
    reportsTo: "principal",
    delegatesTo: [],
    capabilities: {
      tools: ["Read"],
      skills: [],
      subagents: [],
      mcpServers: [],
      memory: { read: ["shared"], write: [] },
      workspace: { readRoots: ["/workspace"], writeRoots: [] },
    },
    instructions: () => "Probe instructions",
    workflow: {
      id: "probe-workflow",
      initial: "REPORT",
      states: { REPORT: { allowedTools: [], transitions: [], terminal: true } },
    },
    output: { name: "probe-output", schema: {}, validate: () => ({ ok: true }) },
    ...overrides,
  };
}

function withCapabilities(
  capabilities: Partial<AgentDefinition<unknown>["capabilities"]>,
): AgentDefinition<unknown> {
  const base = probe();
  return defineAgent(probe({ capabilities: { ...base.capabilities, ...capabilities } }));
}

describe("capability grants — registry ceiling", () => {
  it("rejects a skill the principal never put in scope", () => {
    expect(() => createAgentRegistry(
      [withCapabilities({ tools: ["Read", "Skill"], skills: ["deploy-to-prod"] })],
      { catalog },
    )).toThrowError(/unknown skill `deploy-to-prod`/);
  });

  /**
   * `Skill` with nothing named is not a narrow grant, it is every skill on the machine —
   * the exact shape §5.5 forbids, and what all five Skill-holding built-ins used to hold.
   */
  it("rejects the Skill tool with no skill named", () => {
    expect(() => createAgentRegistry([withCapabilities({ tools: ["Read", "Skill"] })], { catalog }))
      .toThrowError(/grants the `Skill` tool but names no skill/);
  });

  it("rejects a named skill the role has no Skill tool to invoke", () => {
    expect(() => createAgentRegistry([withCapabilities({ skills: ["git"] })], { catalog }))
      .toThrowError(/names skills but has no `Skill` tool/);
  });

  it("rejects a subagent and an MCP server that are not in the trusted catalog", () => {
    expect(() => createAgentRegistry([withCapabilities({ subagents: ["ghost"] })], { catalog }))
      .toThrowError(/unknown subagent `ghost`/);
    expect(() => createAgentRegistry([withCapabilities({ mcpServers: ["whatever"] })], { catalog }))
      .toThrowError(/unknown mcp server `whatever`/);
  });

  /**
   * A subagent runs inside the granting role's process, so a tool it holds is a tool that
   * role effectively holds. §4.6: a subagent grant opens no door the parent lacks.
   */
  it("rejects a subagent whose tools the granting role does not hold", () => {
    expect(() => createAgentRegistry(
      [withCapabilities({ tools: ["Read", "Skill"], skills: ["git"], subagents: ["prober"] })],
      { catalog },
    )).toThrowError(/grants subagent `prober` the ungranted tool `Grep`/);
  });

  it("accepts grants that name catalog entries", () => {
    const registry = createAgentRegistry(
      [withCapabilities({ tools: ["Read", "Grep", "Skill"], skills: ["git"], subagents: ["prober"], mcpServers: ["docs"] })],
      { catalog },
    );
    expect(registry.get("probe").capabilities).toMatchObject({
      skills: ["git"],
      subagents: ["prober"],
      mcpServers: ["docs"],
    });
  });

  /**
   * The catalog is the trust list, and a skill that exists on disk but not in it is not
   * granted to anyone. Drift in either direction is a silent change of scope.
   */
  it("keeps the shipped skill catalog in sync with the skills directory", async () => {
    const entries = await readdir(join(process.cwd(), "skills"), { withFileTypes: true });
    const onDisk = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    expect([...SKILL_CATALOG].sort()).toEqual(onDisk);
  });
});

describe("capability grants — policy snapshot", () => {
  const policyFor = (definition: AgentDefinition<unknown>): ExecutionPolicy => createExecutionPolicy({
    executionId: "exec-capability",
    definition,
    workspace: "/workspace",
    workspaceMode: "read-only",
    createdAt: "2026-09-04T00:00:00.000Z",
    catalog,
  });

  /**
   * Names resolve once, here, and the command that will actually run is recorded in the
   * snapshot — so `policy.json` says what egress an execution was authorized for rather
   * than leaving it to be looked up from mutable machine config afterwards.
   */
  it("resolves each granted name into the snapshot the execution is judged against", () => {
    const policy = policyFor(withCapabilities({
      tools: ["Read", "Grep", "Skill"], skills: ["git"], subagents: ["prober"], mcpServers: ["docs"],
    }));

    expect(policy.skills).toEqual(["git"]);
    expect(policy.subagents).toEqual([expect.objectContaining({ name: "prober", tools: ["Read", "Grep"] })]);
    expect(policy.mcpServers).toEqual([
      expect.objectContaining({ name: "docs", command: "npx", args: ["-y", "docs-mcp"], egress: "network" }),
    ]);
  });

  it("changes the policy hash when a grant widens", () => {
    const narrow = policyFor(withCapabilities({ tools: ["Read", "Skill"], skills: ["git"] }));
    const wide = policyFor(withCapabilities({ tools: ["Read", "Skill"], skills: ["git", "code-review"] }));

    expect(wide.policyHash).not.toBe(narrow.policyHash);
    expect(wide.definitionHash).not.toBe(narrow.definitionHash);
  });
});

describe("capability grants — policy engine", () => {
  const registry = createAgentRegistry([
    withCapabilities({ tools: ["Read", "Grep", "Skill"], skills: ["git"], subagents: ["prober"], mcpServers: ["docs"] }),
    defineAgent(probe({ id: "bare" })),
  ], { catalog });
  const engine = new PolicyEngine({ registry });

  it.each([
    ["a skill outside the grant", { type: "skill", actor: "probe", skill: "code-review" }, "SKILL_NOT_GRANTED"],
    ["a subagent outside the grant", { type: "subagent", actor: "bare", subagent: "prober" }, "SUBAGENT_NOT_GRANTED"],
    ["an MCP server outside the grant", { type: "mcp", actor: "bare", server: "docs" }, "MCP_SERVER_NOT_GRANTED"],
  ] as const)("denies %s", (_label, request, code) => {
    expect(engine.authorize(request)).toMatchObject({ allowed: false, code });
  });

  /**
   * An MCP tool arrives as `mcp__<server>__<tool>`, which is not in `TOOL_CATALOG` and so
   * fell through to `TOOL_NOT_GRANTED` — a true answer for the wrong reason, and one that
   * would have kept saying "not granted" after the server *was* granted.
   */
  it("routes an MCP tool name to the server grant", () => {
    expect(engine.authorize({ type: "tool", actor: "probe", tool: "mcp__docs__search" }))
      .toEqual({ allowed: true });
    expect(engine.authorize({ type: "tool", actor: "bare", tool: "mcp__docs__search" }))
      .toMatchObject({ allowed: false, code: "MCP_SERVER_NOT_GRANTED" });
  });

  it("allows what the grant names", () => {
    expect(engine.authorize({ type: "skill", actor: "probe", skill: "git" })).toEqual({ allowed: true });
    expect(engine.authorize({ type: "subagent", actor: "probe", subagent: "prober" })).toEqual({ allowed: true });
    expect(engine.authorize({ type: "mcp", actor: "probe", server: "docs" })).toEqual({ allowed: true });
  });
});

function policyFixture(overrides: Partial<ExecutionPolicy> = {}): ExecutionPolicy {
  return {
    executionId: "exec-capability",
    role: "probe",
    workspace: "/workspace",
    workspaceMode: "read-only",
    workspaceAccess: "granted",
    allowedTools: ["Read", "Skill"],
    skills: ["git"],
    subagents: [],
    mcpServers: [],
    memory: { read: ["shared"], write: [] },
    delegatesTo: [],
    createdAt: "2026-09-04T00:00:00.000Z",
    definitionHash: "definition-hash",
    policyHash: "policy-hash",
    ...overrides,
  };
}

describe("capability grants — Claude ACL", () => {
  const permissions = (policy: ExecutionPolicy) => claudePermissions({
    policy,
    memoryRoot: "/memory",
    runtimeDirectory: "/executions/exec-capability/runtime",
    allRoles: ["probe", "bare"],
  });

  it("allows the named skills and nothing else through the Skill tool", () => {
    const rules = permissions(policyFixture());
    expect(rules.allow).toContain("Skill(git)");
    expect(rules.allow).not.toContain("Skill(code-review)");
    expect(rules.deny).not.toContain("Skill");
  });

  /**
   * `Agent` and `Task` are denied for every role that holds no subagent grant. A role that
   * holds one must not inherit that deny — a bare deny removes the tool from the model's
   * context entirely, so the grant would be unusable — but only the named subagent is
   * allowed through.
   */
  it("lifts the class-wide subagent deny only for a role that holds a grant", () => {
    const granted = permissions(policyFixture({
      subagents: [{ name: "prober", description: "d", prompt: "p", tools: ["Read"] }],
    }));
    expect(granted.deny).not.toContain("Agent");
    expect(granted.deny).toContain("Task");
    expect(granted.allow).toContain("Agent(prober)");

    expect(permissions(policyFixture()).deny).toEqual(expect.arrayContaining(["Agent", "Task"]));
  });

  it("allows the tools of a granted MCP server", () => {
    const rules = permissions(policyFixture({
      mcpServers: [{ name: "docs", description: "d", egress: "network", command: "npx", args: ["docs-mcp"] }],
    }));
    expect(rules.allow).toContain("mcp__docs");
  });
});

async function runtimeFixture(policy: ExecutionPolicy): Promise<{ root: string; prepared: PreparedExecution }> {
  const root = await mkdtemp(join(tmpdir(), "alp-capability-"));
  roots.push(root);
  const project = join(root, "project");
  const directory = join(root, "executions", "exec-capability");
  const runtimeDirectory = join(directory, "runtime");
  const contextDirectory = join(directory, "context");
  await mkdir(project, { recursive: true });
  await mkdir(runtimeDirectory, { recursive: true });
  await mkdir(contextDirectory, { recursive: true });
  const resolved = { ...policy, workspace: project };
  return {
    root,
    prepared: {
      capsule: {
        executionId: "exec-capability",
        definitionHash: resolved.definitionHash,
        policyHash: resolved.policyHash,
        role: resolved.role,
        displayName: "Probe",
        instructions: "Probe instructions",
        task: "probe the grant",
        activeWorkspace: project,
        memoryContext: {
          invariantContext: "invariants",
          policyContext: "policy",
          entries: [],
          diagnostics: { characterBudget: 0, charactersUsed: 0, truncated: false, omittedEntryIds: [] },
        },
        workflowState: { workflowId: "probe-workflow", currentState: "REPORT", status: "running", repairAttempts: 0 },
        allowedTools: resolved.allowedTools,
        outputContract: { name: "probe-output", schema: {} },
      },
      policy: resolved,
      state: {
        executionId: "exec-capability",
        status: "prepared",
        workflow: { workflowId: "probe-workflow", currentState: "REPORT", status: "running", repairAttempts: 0 },
        policyHash: resolved.policyHash,
        createdAt: resolved.createdAt,
      },
      artifacts: {
        directory,
        stateFile: join(directory, "state.json"),
        policyFile: join(directory, "policy.json"),
        runtimeDirectory,
        contextDirectory,
        checkpointFile: join(contextDirectory, "checkpoint.json"),
        continuityFile: join(contextDirectory, "continuity.md"),
        compactEventsFile: join(contextDirectory, "compact-events.jsonl"),
      },
    },
  };
}

describe("capability grants — runtime translation", () => {
  const mcpGrant = { name: "docs", description: "d", egress: "network" as const, command: "npx", args: ["-y", "docs-mcp"] };

  /**
   * The fail-closed half of the MCP grant, and the reason it is worth having: without
   * `--strict-mcp-config`, a delegated execution inherits every MCP server configured on
   * the machine — egress the policy never authorized and the Authority table never named.
   */
  it("hands Claude exactly the granted MCP servers and no machine config", async () => {
    const { root, prepared } = await runtimeFixture(policyFixture({ mcpServers: [mcpGrant] }));
    const adapter = new ClaudeRuntimeAdapter({ platform: "linux", env: { HOME: root, ALP_REPO_ROOT: root } });
    const launch = await adapter.prepare({ execution: prepared, model: "claude-test", reasoningEffort: "high", interactive: false });

    expect(launch.args).toContain("--strict-mcp-config");
    const configFile = launch.args[launch.args.indexOf("--mcp-config") + 1];
    expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual({
      mcpServers: { docs: { type: "stdio", command: "npx", args: ["-y", "docs-mcp"] } },
    });
  });

  it("still passes strict MCP when nothing is granted", async () => {
    const { root, prepared } = await runtimeFixture(policyFixture());
    const adapter = new ClaudeRuntimeAdapter({ platform: "linux", env: { HOME: root, ALP_REPO_ROOT: root } });
    const launch = await adapter.prepare({ execution: prepared, model: "claude-test", reasoningEffort: "high", interactive: false });

    expect(launch.args).toContain("--strict-mcp-config");
    const configFile = launch.args[launch.args.indexOf("--mcp-config") + 1];
    expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual({ mcpServers: {} });
    expect(launch.args).not.toContain("--agents");
  });

  it("declares a granted subagent to Claude and to nobody else", async () => {
    const subagent = { name: "prober", description: "Reads files.", prompt: "Read only.", tools: ["Read"] as const };
    const { root, prepared } = await runtimeFixture(policyFixture({ subagents: [subagent] }));
    const claude = new ClaudeRuntimeAdapter({ platform: "linux", env: { HOME: root, ALP_REPO_ROOT: root } });
    const launch = await claude.prepare({ execution: prepared, model: "claude-test", reasoningEffort: "high", interactive: false });

    expect(JSON.parse(launch.args[launch.args.indexOf("--agents") + 1])).toEqual({
      prober: { description: "Reads files.", prompt: "Read only.", tools: ["Read"] },
    });

    // Codex has no in-process subagent: the grant is an optimisation there, not a condition.
    const codex = new CodexRuntimeAdapter({ platform: "linux", env: { HOME: root, ALP_REPO_ROOT: root } });
    const codexLaunch = await codex.prepare({ execution: prepared, model: "codex-test", reasoningEffort: "high", interactive: false });
    expect(codexLaunch.args.join(" ")).not.toContain("prober");
  });

  /**
   * Codex reads `mcp_servers` from config, and ALP's own `codex-config.toml` is not the
   * file it loads — the `-c` overrides on argv are. A server written only into that file
   * would be documentation, not a connection.
   */
  it("passes granted MCP servers to Codex as config overrides on argv", async () => {
    const { root, prepared } = await runtimeFixture(policyFixture({ mcpServers: [mcpGrant] }));
    const adapter = new CodexRuntimeAdapter({ platform: "linux", env: { HOME: root, ALP_REPO_ROOT: root } });
    const launch = await adapter.prepare({ execution: prepared, model: "codex-test", reasoningEffort: "high", interactive: false });

    const override = launch.args.find((arg) => arg.startsWith("mcp_servers."));
    expect(override).toBe(`mcp_servers.docs={ command = "npx", args = ["-y", "docs-mcp"] }`);
  });
});

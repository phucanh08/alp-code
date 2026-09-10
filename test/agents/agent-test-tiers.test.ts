import { access } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentRegistry } from "../../src/agents/registry";
import { renderInstructions } from "../../src/agents/shared/voice";
import { CODE_NATIVE_HOUSE_RULES } from "../../src/agents/shared/house-rules";
import type { AgentId } from "../../src/agents/types";
import { PolicyEngine } from "../../src/policy/policy-engine";
import { cleanupDryRuns, dryRunAgent } from "../support/agent-dry-run";

/**
 * Tiers 2 and 3 of the agent test tooling (vision §10.3), for the eight built-in roles.
 *
 * Tier 2 prepares a role for real and stops before the spawn; tier 3 asserts the exact
 * code a genuine violation is denied with. Both run against the shipped registry, which
 * is the whole point: the unit suites that cover this machinery build their own fake
 * definitions, so a defect that lives in a *shipped* definition — or in how a real grant
 * is resolved — passes every one of them.
 */

const ROLE_IDS = [
  "main",
  "search",
  "librarian",
  "read-thread",
  "review",
  "oracle",
  "compaction",
  "titling",
] as const satisfies readonly AgentId[];

/** Roles that declare no workspace root: they work from memory alone. */
const MEMORY_ONLY = ["read-thread", "compaction", "titling"] as const satisfies readonly AgentId[];

const TASK_POINTER = /^ALP task is in (.+); execute it\.$/;

afterEach(cleanupDryRuns);

describe("agent test tier 2 — dry-run prepare", () => {
  /**
   * The blocker this pins: every code-native role declares `readRoots: ["."]`, and the
   * relative root used to be canonicalized once, at `PolicyEngine` construction, against
   * the launcher's own cwd. `alp delegate review --project ~/code/api` from anywhere else
   * therefore denied the very project it was pointed at, and the three memory-only roles
   * could not be launched at all.
   */
  it.each(ROLE_IDS)("prepares %s against a workspace outside the launcher cwd", async (role) => {
    const run = await dryRunAgent({ role });

    expect(run.workspace).not.toBe(process.cwd());
    expect(run.execution.policy).toMatchObject({ role, workspace: run.workspace, workspaceMode: "read-only" });
    expect(run.execution.capsule.activeWorkspace).toBe(run.workspace);
    for (const runtime of ["claude", "codex"] as const) {
      expect(run.launch[runtime].cwd).toBe(run.workspace);
    }
  });

  /**
   * The Authority table calls itself "the whole of your authority", so it has to print the
   * session-wide grant. `capsule.allowedTools` is narrowed to the opening workflow state and
   * only ever advances at the Stop hook, so main read as tool-less for the whole session.
   */
  it("prints the session-wide tool grant in the authority table", async () => {
    const run = await dryRunAgent({ role: "main" });

    expect(run.execution.capsule.allowedTools).not.toContain("Bash");
    const tools = /\| Tools \| (.+) \|/.exec(run.sessionContext)?.[1] ?? "";
    expect(tools.split(", ").sort()).toEqual([...agentRegistry.get("main").capabilities.tools].sort());
  });

  /**
   * A task delivered as a file path is only a task for a role that may open the path.
   * `titling` holds no tools at all, so the pointer form makes its first move impossible.
   */
  it.each(ROLE_IDS)("delivers the task to %s in a form it can open", async (role) => {
    const task = `Dry-run ${role}`;
    const run = await dryRunAgent({ role, task });

    for (const runtime of ["claude", "codex"] as const) {
      const last = run.launch[runtime].args.at(-1) ?? "";
      if (agentRegistry.get(role).capabilities.tools.includes("Read")) {
        const pointer = TASK_POINTER.exec(last);
        expect(pointer, `${role}/${runtime} should be pointed at its task file`).not.toBeNull();
        await expect(access(pointer![1])).resolves.toBeUndefined();
      } else {
        expect(last).toContain(task);
      }
    }
  });

  /**
   * The declarative ACL is the enforcement, so a role that declares no workspace root must
   * not be handed the workspace directory as an additional read root — that grant is exactly
   * what its own instruction ("do not inspect source workspaces") forbids.
   */
  it.each(ROLE_IDS)("grants %s the workspace directory only if it declares a root", async (role) => {
    const run = await dryRunAgent({ role });
    const directories = run.claudeSettings.permissions.additionalDirectories;

    if ((MEMORY_ONLY as readonly string[]).includes(role)) {
      expect(directories).not.toContain(run.workspace);
    } else {
      expect(directories).toContain(run.workspace);
    }
    // The execution's own runtime files are always readable: that is where the task lives.
    expect(directories).toContain(run.execution.artifacts.runtimeDirectory);
  });


  /**
   * The runtime's own in-process agent tool is not in `TOOL_CATALOG`, so the catalog-driven
   * deny loop never reached it: the ban on launching a subagent was prompt text and nothing
   * else. No role is granted one, so no role may reach it.
   */
  it.each(ROLE_IDS)("keeps the runtime's in-process agent tool off %s's grant", async (role) => {
    const run = await dryRunAgent({ role });

    expect(run.claudeSettings.permissions.deny).toEqual(expect.arrayContaining(["Task", "Agent"]));
  });

  /**
   * A `Skill` tool with no skill named is not a narrow grant — it is every skill root on
   * the machine, reachable by a delegated specialist nobody is watching. Each of the five
   * Skill-holding built-ins now names what it may invoke, and the ACL allows those names.
   */
  it.each(ROLE_IDS)("narrows %s's skill grant to the skills it names", async (role) => {
    const definition = agentRegistry.get(role);
    const run = await dryRunAgent({ role });
    const { allow, deny } = run.claudeSettings.permissions;

    if (definition.capabilities.tools.includes("Skill")) {
      expect(definition.capabilities.skills.length).toBeGreaterThan(0);
      expect(allow).toEqual(expect.arrayContaining(definition.capabilities.skills.map((skill) => `Skill(${skill})`)));
    } else {
      expect(definition.capabilities.skills).toEqual([]);
      expect(deny).toContain("Skill");
    }
    expect(run.execution.policy.skills).toEqual([...definition.capabilities.skills]);
  });

  /**
   * Egress no policy authorized is the failure mode here: without `--strict-mcp-config`
   * every delegated execution picks up whatever MCP servers happen to be configured on
   * the machine. No built-in grants a server, so every one of them runs with none.
   */
  it.each(ROLE_IDS)("gives %s no MCP server it was not granted", async (role) => {
    const run = await dryRunAgent({ role });

    expect(agentRegistry.get(role).capabilities.mcpServers).toEqual([]);
    expect(run.launch.claude.args).toContain("--strict-mcp-config");
    expect(run.mcpConfig).toEqual({ mcpServers: {} });
    expect(run.launch.codex.args.some((arg) => arg.startsWith("mcp_servers."))).toBe(false);
  });

  it("prints the three named grants in the authority table", async () => {
    const run = await dryRunAgent({ role: "review" });
    const row = (label: string): string =>
      new RegExp(`\\| ${label} \\| (.+) \\|`).exec(run.sessionContext)?.[1] ?? "";

    expect(row("Skills").split(", ").sort())
      .toEqual([...agentRegistry.get("review").capabilities.skills].sort());
    expect(row("Subagents")).toBe("—");
    expect(row("MCP servers")).toBe("—");
  });

  /**
   * The rule has to ban the subagents policy withholds, not the whole class: the day a
   * definition declares `capabilities.subagents`, a class-wide ban would contradict its own
   * grant. Herdr and Paseo stay banned outright — no grant can bring a foreign runtime inside
   * policy — so the two live in separate rules that travel together.
   */
  it("bans ungranted subagents rather than the whole class", () => {
    const subagentRule = CODE_NATIVE_HOUSE_RULES.find((rule) => rule.includes("subagent"));
    expect(subagentRule).toMatch(/policy does not grant/);
    expect(CODE_NATIVE_HOUSE_RULES.join("\n")).not.toContain("in-process agents");

    for (const role of ROLE_IDS) {
      const instructions = renderInstructions(agentRegistry.get(role).instructions);
      if (!instructions.includes(CODE_NATIVE_HOUSE_RULES[0])) continue;
      expect(instructions, `${role} carries the house rules`).toContain(subagentRule);
    }
  });
});

describe("agent test tier 3 — deny paths", () => {
  const engine = (): PolicyEngine => new PolicyEngine({ registry: agentRegistry });

  it.each(MEMORY_ONLY)("denies %s a writable workspace", async (role) => {
    await expect(dryRunAgent({ role, workspaceMode: "workspace-write" }))
      .rejects.toThrowError(/workspace authorization failed \(WORKSPACE_NOT_GRANTED\)/);
  });

  it("denies a specialist delegating to another specialist", async () => {
    await expect(dryRunAgent({ role: "review", parent: "search" }))
      .rejects.toThrowError(/delegation authorization failed \(DELEGATION_NOT_ALLOWED\)/);
  });

  it("denies a specialist reporting straight to the principal", async () => {
    await expect(dryRunAgent({ role: "search", parent: "principal" }))
      .rejects.toThrowError(/does not report to principal/);
  });

  it("resolves a relative workspace root against the execution, not the launcher", () => {
    const workspace = join(process.cwd(), "..", "some-other-project");
    const execution = { activeWorkspace: workspace, workspaceMode: "read-only" as const, delegated: true };

    expect(engine().authorize({
      type: "workspace", actor: "review", operation: "read",
      path: join(workspace, "src", "index.ts"), execution,
    })).toEqual({ allowed: true });
  });

  it.each([
    ["outside the active workspace", { actor: "review", operation: "read", path: join(process.cwd(), "..", "elsewhere"), delegated: true }, "WORKSPACE_SCOPE_MISMATCH"],
    ["a write in a read-only execution", { actor: "main", operation: "write", path: process.cwd(), delegated: false }, "WORKSPACE_READ_ONLY"],
  ] as const)("denies %s", (_label, request, code) => {
    expect(engine().authorize({
      type: "workspace",
      actor: request.actor,
      operation: request.operation,
      path: request.path,
      execution: { activeWorkspace: process.cwd(), workspaceMode: "read-only", delegated: request.delegated },
    })).toMatchObject({ allowed: false, code });
  });

  it.each([
    ["another role's private memory", { actor: "main", scope: "private:search" }, "PRIVATE_MEMORY_DENIED"],
    ["a scope the role never asked for", { actor: "titling", scope: "shared" }, "MEMORY_NOT_GRANTED"],
  ] as const)("denies %s", (_label, request, code) => {
    expect(engine().authorize({ type: "memory", actor: request.actor, operation: "read", scope: request.scope }))
      .toMatchObject({ allowed: false, code });
  });

  it.each([
    ["a skill the role never named", { type: "skill", actor: "search", skill: "git" }, "SKILL_NOT_GRANTED"],
    ["an in-process subagent", { type: "subagent", actor: "main", subagent: "explore" }, "SUBAGENT_NOT_GRANTED"],
    ["an MCP server", { type: "mcp", actor: "main", server: "docs" }, "MCP_SERVER_NOT_GRANTED"],
  ] as const)("denies %s", (_label, request, code) => {
    expect(engine().authorize(request)).toMatchObject({ allowed: false, code });
  });

  it.each([
    ["a tool outside the grant", { actor: "titling", tool: "Bash" }, "TOOL_NOT_GRANTED"],
    ["an in-process agent tool", { actor: "main", tool: "mcp__paseo__spawn_agent" }, "RAW_RUNTIME_TOOL_DENIED"],
  ] as const)("denies %s", (_label, request, code) => {
    expect(engine().authorize({ type: "tool", actor: request.actor, tool: request.tool }))
      .toMatchObject({ allowed: false, code });
  });
});

import { chmod, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineAgent } from "../../src/agents/agent-definition";
import { agentRegistry, createAgentRegistry } from "../../src/agents/registry";
import type { AgentDefinition, AgentId } from "../../src/agents/types";
import { createExecutionPolicy, readToolchainWritePaths } from "../../src/execution/execution-policy";
import { ExecutionService } from "../../src/execution/execution-service";
import { FileExecutionStore } from "../../src/execution/execution-store";
import {
  TOOLCHAIN_PRESETS,
  assertToolchainOutsideWorkspace,
  expandHome,
  parseToolchainBlock,
  resolveToolchainWritePaths,
} from "../../src/execution/toolchain";
import type { AuthorizeExecutionInput } from "../../src/execution/types";
import { finalizeExecution } from "../../src/hooks/execution-bridge";
import type { BuiltMemoryContext } from "../../src/memory/types";
import { PolicyEngine } from "../../src/policy/policy-engine";
import { WorkflowRunner } from "../../src/workflow/workflow-runner";
import { removeTemporary } from "../support/temporary-root";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(removeTemporary)));

/**
 * Oracle: GitHub #25 — a `workspace-write` role could not run `flutter test` because the
 * SDK's cache lives in `~/fvm`, outside the workspace, and no setting could open it. The
 * machine now declares such directories once; each is checked to stand outside the
 * workspace and beside ALP's state, rides the ticket into the signed policy, and is what the
 * adapters open. A project may not declare them.
 */
describe("parseToolchainBlock", () => {
  it("is null when the file says nothing, and reads presets and explicit paths", () => {
    expect(parseToolchainBlock({ modes: {} }, "f")).toBeNull();
    expect(parseToolchainBlock({ toolchain: { presets: ["flutter"], writePaths: ["~/fvm"] } }, "f"))
      .toEqual({ presets: ["flutter"], writePaths: ["~/fvm"] });
    expect(parseToolchainBlock({ toolchain: {} }, "f")).toEqual({ presets: [], writePaths: [] });
  });

  it("refuses an unknown preset, a non-list, and an empty entry", () => {
    expect(() => parseToolchainBlock({ toolchain: { presets: ["haskell"] } }, "f")).toThrow(/haskell.*known presets/);
    expect(() => parseToolchainBlock({ toolchain: { writePaths: "~/fvm" } }, "f")).toThrow(/writePaths.*list/);
    expect(() => parseToolchainBlock({ toolchain: { writePaths: [""] } }, "f")).toThrow(/writePaths`\[0\]/);
    expect(() => parseToolchainBlock({ toolchain: ["~/fvm"] }, "f")).toThrow(/`toolchain` must be an object/);
  });

  it("ships presets that are all `~`-relative, so they resolve against any home", () => {
    for (const [name, paths] of Object.entries(TOOLCHAIN_PRESETS)) {
      expect(paths.length, name).toBeGreaterThan(0);
      for (const path of paths) expect(path, `${name}: ${path}`).toMatch(/^~\//);
    }
  });
});

describe("resolveToolchainWritePaths", () => {
  const home = "/home/me";
  const options = (existing: readonly string[]) => ({
    home,
    stateHome: join(home, ".alp"),
    canonical: async (path: string) => (existing.includes(path) ? `${path}` : null),
    file: "settings.json",
  });

  it("expands `~`, keeps only the preset paths that exist, and refuses a typed path that does not", async () => {
    const existing = [join(home, "fvm"), join(home, ".pub-cache")];
    await expect(resolveToolchainWritePaths({ presets: ["flutter"], writePaths: [] }, options(existing)))
      .resolves.toEqual([join(home, ".pub-cache"), join(home, "fvm")]);
    await expect(resolveToolchainWritePaths({ presets: [], writePaths: ["~/fvm", "/home/me/fvm"] }, options(existing)))
      .resolves.toEqual([join(home, "fvm")]);
    await expect(resolveToolchainWritePaths({ presets: [], writePaths: ["~/.gradle"] }, options(existing)))
      .rejects.toThrow(/`~\/\.gradle` does not exist/);
    expect(expandHome("~", home)).toBe(home);
    expect(expandHome("/opt/flutter", home)).toBe("/opt/flutter");
  });

  it("refuses a relative path, the root, the home itself, and anything overlapping ALP's state", async () => {
    const existing = [home, "/", join(home, ".alp"), join(home, ".alp", "executions")];
    const resolveOne = (path: string) => resolveToolchainWritePaths({ presets: [], writePaths: [path] }, options(existing));
    await expect(resolveOne("fvm")).rejects.toThrow(/must be absolute/);
    await expect(resolveOne("/")).rejects.toThrow(/whole filesystem/);
    await expect(resolveOne("~")).rejects.toThrow(/whole home directory/);
    await expect(resolveOne("~/.alp/executions")).rejects.toThrow(/overlaps ALP's state directory/);
    await expect(resolveOne("~/.alp")).rejects.toThrow(/overlaps ALP's state directory/);
  });
});

describe("assertToolchainOutsideWorkspace", () => {
  it("passes a cache beside the project and refuses one that contains it or lies inside it", () => {
    expect(() => assertToolchainOutsideWorkspace(["/home/me/fvm", "/home/me/.gradle"], "/home/me/src/app")).not.toThrow();
    expect(() => assertToolchainOutsideWorkspace(["/home/me/src"], "/home/me/src/app")).toThrow(/contains the workspace/);
    expect(() => assertToolchainOutsideWorkspace(["/home/me/src/app"], "/home/me/src/app")).toThrow(/contains the workspace/);
    expect(() => assertToolchainOutsideWorkspace(["/home/me/src/app/build"], "/home/me/src/app")).toThrow(/lies inside the workspace/);
    // A sibling whose name merely starts the same way is outside.
    expect(() => assertToolchainOutsideWorkspace(["/home/me/src/app-cache"], "/home/me/src/app")).not.toThrow();
  });
});

describe("execution policy — toolchainWritePaths", () => {
  const definition = agentRegistry.get("search");
  const base = { executionId: "exec_tc", thread: null, definition, workspace: "/ws", workspaceMode: "read-only" as const, createdAt: "2026-09-18T00:00:00.000Z" };

  it("is `[]` out loud when none were given, sorted and deduplicated otherwise, and in the hash", () => {
    const none = createExecutionPolicy(base);
    expect(none.toolchainWritePaths).toEqual([]);
    expect("toolchainWritePaths" in none).toBe(true);
    const some = createExecutionPolicy({ ...base, toolchainWritePaths: ["/home/me/fvm", "/home/me/.gradle", "/home/me/fvm"] });
    expect(some.toolchainWritePaths).toEqual(["/home/me/.gradle", "/home/me/fvm"]);
    expect(some.policyHash).not.toBe(none.policyHash);
    expect(createExecutionPolicy({ ...base, toolchainWritePaths: ["/home/me/.gradle", "/home/me/fvm"] }).policyHash).toBe(some.policyHash);
  });

  it("reads a legacy snapshot as `[]` and refuses a malformed one", () => {
    expect(readToolchainWritePaths({ role: "worker" })).toEqual([]);
    expect(readToolchainWritePaths({ toolchainWritePaths: ["/a"] })).toEqual(["/a"]);
    expect(() => readToolchainWritePaths({ toolchainWritePaths: "/a" })).toThrow(/toolchainWritePaths/);
    expect(() => readToolchainWritePaths({ toolchainWritePaths: [""] })).toThrow(/toolchainWritePaths\[0\]/);
  });
});

function agent(id: AgentId): AgentDefinition<unknown> {
  return defineAgent({
    id,
    displayName: id,
    model: { claude: "claude-haiku-4-5", codex: "gpt-5.6-luna" },
    reasoningEffort: { claude: "low", codex: "low" },
    reportsTo: id === "main" ? "principal" : "main",
    delegatesTo: id === "main" ? ["worker"] : [],
    capabilities: {
      tools: ["Read"],
      skills: [],
      subagents: [],
      mcpServers: [],
      memory: { read: ["shared", `private:${id}`], write: [`private:${id}`] },
      workspace: { readRoots: ["."], writeRoots: id === "worker" ? ["."] : [] },
    },
    instructions: { role: id, purpose: `${id} instructions`, rules: [] },
    workflow: { id: `${id}-workflow`, initial: "REPORT", states: { REPORT: { allowedTools: [], transitions: [], terminal: true } } },
    output: { name: `${id}-output`, schema: {}, validate: () => ({ ok: true }) },
  });
}

const memoryContext: BuiltMemoryContext = {
  invariantContext: "invariants",
  policyContext: "policy",
  entries: [],
  diagnostics: { characterBudget: 0, charactersUsed: 0, truncated: false, omittedEntryIds: [] },
};

async function harness(paths: (root: string, workspace: string) => readonly string[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "alp-toolchain-")));
  roots.push(root);
  const workspace = join(root, "workspace");
  const executionsRoot = join(root, "executions");
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(join(root, "fvm"), { recursive: true });
  const toolchainWritePaths = paths(root, workspace);
  const registry = createAgentRegistry([agent("main"), agent("worker")]);
  const service = new ExecutionService({
    registry,
    policy: new PolicyEngine({ registry, protectedRoots: [executionsRoot] }),
    memory: { buildContext: async () => memoryContext },
    workflowRunner: new WorkflowRunner(),
    store: new FileExecutionStore({ root: executionsRoot }),
    toolchainWritePaths,
    now: () => new Date("2026-09-18T10:00:00.000Z"),
  });
  const launch = (overrides: Partial<AuthorizeExecutionInput> = {}): AuthorizeExecutionInput => ({
    executionId: "exec_toolchain",
    parent: "main",
    target: "worker",
    workspace,
    workspaceMode: "workspace-write",
    launch: { root: workspace, project: workspace },
    ...overrides,
  });
  const materialize = { task: "run the tests", thread: null, memoryQueries: [], characterBudget: 0, invariantContext: "i", policyContext: "p" } as const;
  return { root, workspace, executionsRoot, service, launch, materialize };
}

describe("ExecutionService — toolchainWritePaths", () => {
  it("carries the machine's paths from the ticket into the signed policy on disk", async () => {
    const { root, service, launch, materialize, executionsRoot } = await harness((home) => [join(home, "fvm")]);
    const ticket = await service.authorize(launch());
    expect(ticket.toolchainWritePaths).toEqual([join(root, "fvm")]);
    const prepared = await service.materialize(ticket, materialize);
    expect(prepared.policy.toolchainWritePaths).toEqual([join(root, "fvm")]);
    const onDisk = JSON.parse(await readFile(join(executionsRoot, ticket.executionId, "policy.json"), "utf8"));
    expect(onDisk.toolchainWritePaths).toEqual([join(root, "fvm")]);
  });

  it("refuses to launch when a toolchain path would contain the workspace, before anything is on disk", async () => {
    const { service, launch, executionsRoot } = await harness((home) => [home]);
    await expect(service.authorize(launch())).rejects.toThrow(/contains the workspace/);
    await expect(service.authorize(launch({ workspaceMode: "read-only" }))).rejects.toThrow(/contains the workspace/);
    await expect(readFile(join(executionsRoot, "exec_toolchain", "policy.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a toolchain path inside the workspace: that is a scope, not a cache", async () => {
    const { service, launch } = await harness((_home, project) => [join(project, "src")]);
    await expect(service.authorize(launch())).rejects.toThrow(/lies inside the workspace/);
  });
});

describe("hook bridge — toolchainWritePaths", () => {
  /** Same gap as `mode`, `modeProfiles` and `writeScope` before it: left out of the re-derivation, every launch with a toolchain path failed the tamper check. */
  it("finalizes an execution whose policy carries toolchain paths, and refuses one whose paths were edited", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-toolchain-hook-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const definition = agentRegistry.get("search");
    const write = async (executionId: string, toolchainWritePaths: readonly string[], tamper?: readonly string[]) => {
      const directory = join(root, executionId);
      await mkdir(directory);
      const policy = createExecutionPolicy({ executionId, thread: null, definition, workspace, workspaceMode: "read-only", toolchainWritePaths, createdAt: "2026-09-18T00:00:00.000Z" });
      const state = { executionId, status: "prepared", workflow: new WorkflowRunner().initialize(definition.workflow), policyHash: policy.policyHash, createdAt: policy.createdAt };
      await writeFile(join(directory, "policy.json"), JSON.stringify(tamper === undefined ? policy : { ...policy, toolchainWritePaths: tamper }));
      await writeFile(join(directory, "state.json"), JSON.stringify(state));
      await chmod(directory, 0o700);
    };
    await write("exec_tc_ok", [join(root, "fvm")]);
    await expect(finalizeExecution({ executionId: "exec_tc_ok", executionRoot: root, output: "Found it." }))
      .resolves.toMatchObject({ ok: true, status: "completed" });
    await write("exec_tc_edited", [join(root, "fvm")], [join(root, "fvm"), join(root, ".ssh")]);
    await expect(finalizeExecution({ executionId: "exec_tc_edited", executionRoot: root, output: "Found it." }))
      .rejects.toThrow(/invalid or stale/);
  });
});

describe("resolveToolchainWritePaths — through symlinks", () => {
  it("records where writes really land, as the workspace is", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "alp-toolchain-link-")));
    roots.push(root);
    await mkdir(join(root, "real-fvm"));
    await symlink(join(root, "real-fvm"), join(root, "fvm"), "dir");
    const canonical = async (path: string) => { try { return await realpath(path); } catch { return null; } };
    await expect(resolveToolchainWritePaths({ presets: [], writePaths: ["~/fvm"] }, { home: root, stateHome: join(root, ".alp"), canonical, file: "f" }))
      .resolves.toEqual([join(root, "real-fvm")]);
  });
});

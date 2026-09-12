import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionPolicy } from "../../src/execution/types";
import { capabilitiesFor } from "../../src/runtime/capabilities";
import { ClaudeRuntimeAdapter } from "../../src/runtime/claude-adapter";
import { CodexRuntimeAdapter } from "../../src/runtime/codex-adapter";
import {
  absoluteRule,
  claudePermissions,
  codexSandboxLines,
  writeScopeDenyPaths,
} from "../../src/runtime/permission-rules";
import { cleanupExecutionFixtures, policyFixture, runtimeFixture } from "../support/execution-fixture";

afterEach(cleanupExecutionFixtures);

const MEMORY_ROOT = "/home/me/.alp/memory";
const RUNTIME_DIRECTORY = "/home/me/.alp/executions/exec-capability/runtime";

function writer(overrides: Partial<ExecutionPolicy> = {}): ExecutionPolicy {
  return policyFixture({
    role: "worker",
    workspaceMode: "workspace-write",
    allowedTools: ["Read", "Edit", "Write", "Bash"],
    memory: { read: ["shared", "private:worker"], write: ["private:worker"] },
    ...overrides,
  });
}

function input(policy: ExecutionPolicy, extra: Partial<Parameters<typeof codexSandboxLines>[0]> = {}) {
  return { policy, memoryRoot: MEMORY_ROOT, runtimeDirectory: RUNTIME_DIRECTORY, allRoles: ["worker", "main"] as const, ...extra };
}

/** `writable_roots = [...]` as the list it names. */
function writableRoots(lines: readonly string[]): string[] {
  const line = lines.find((entry) => entry.startsWith("writable_roots = "));
  if (line === undefined) throw new Error("no writable_roots line");
  return JSON.parse(line.slice("writable_roots = ".length)) as string[];
}

/**
 * Oracle: P2 spec, "Enforcement" table — Codex: `writable_roots = [...writeScope, memory/private/<role>]`
 * *instead of* the workspace; the private memory root must never fall out of the list (risk
 * table); the executions root must never be in any writable list.
 */
describe("codexSandboxLines — writeScope", () => {
  it("replaces the workspace with the scope and keeps the role's private memory writable", () => {
    const lines = codexSandboxLines(input(writer({ writeScope: ["/workspace/src", "/workspace/docs"] })));
    expect(writableRoots(lines)).toEqual(["/workspace/src", "/workspace/docs", join(MEMORY_ROOT, "private", "worker")]);
  });

  it("keeps the whole workspace writable when unscoped, and nothing when read-only", () => {
    expect(writableRoots(codexSandboxLines(input(writer({ writeScope: null })))))
      .toEqual(["/workspace", join(MEMORY_ROOT, "private", "worker")]);
    expect(writableRoots(codexSandboxLines(input(writer({ workspaceMode: "read-only", writeScope: null }))))).toEqual([]);
  });
});

/**
 * Oracle: `research/claude-sandbox-precedence.md` (measured 2026-09-12, claude 2.1.269):
 * `denyWrite` beats `allowWrite`, so the scope is expressed by denying what stands *beside*
 * it at every level between the workspace and the scope. Existing siblings are refused;
 * a new entry at an ancestor level is not — which is what the `partial` level says.
 */
describe("writeScopeDenyPaths — siblings of the scope, level by level", () => {
  const tree: Record<string, readonly string[]> = {
    "/ws": ["src", "docs", "README.md", ".alp"],
    "/ws/src": ["lib", "cli", "index.ts"],
    "/ws/src/lib": ["parser.ts"],
    "/ws/.alp": ["memory"],
    "/ws/.alp/memory": ["private", "shared"],
    "/ws/.alp/memory/private": ["worker", "main"],
  };
  const list = async (directory: string) => tree[directory] ?? [];

  it("denies every entry beside the scope on the way down, and nothing inside it", async () => {
    expect(await writeScopeDenyPaths("/ws", ["/ws/src/lib"], list)).toEqual([
      "/ws/.alp", "/ws/README.md", "/ws/docs", "/ws/src/cli", "/ws/src/index.ts",
    ]);
  });

  it("keeps a second writable root and its ancestors out of the deny list", async () => {
    // The role's private memory happens to live inside the workspace: its ancestors are
    // walked like the scope's, and its own siblings are denied.
    expect(await writeScopeDenyPaths("/ws", ["/ws/src/lib", "/ws/.alp/memory/private/worker"], list)).toEqual([
      "/ws/.alp/memory/private/main", "/ws/.alp/memory/shared", "/ws/README.md", "/ws/docs", "/ws/src/cli", "/ws/src/index.ts",
    ]);
  });

  it("denies nothing when the scope is the workspace itself, and ignores roots outside it", async () => {
    expect(await writeScopeDenyPaths("/ws", ["/ws"], list)).toEqual([]);
    expect(await writeScopeDenyPaths("/ws", ["/ws/src", "/home/me/.alp/memory/private/worker"], list)).toEqual([
      "/ws/.alp", "/ws/README.md", "/ws/docs",
    ]);
  });
});

describe("claudePermissions — writeScope", () => {
  it("denies `Edit` on every path beside the scope, so the tool refuses what the sandbox refuses", () => {
    const rules = claudePermissions(input(writer({ writeScope: ["/workspace/src"] }), { writeScopeDenyPaths: ["/workspace/docs", "/workspace/README.md"] }));
    expect(rules.deny).toContain(absoluteRule("Edit", "/workspace/docs"));
    expect(rules.deny).toContain(absoluteRule("Edit", "/workspace/README.md"));
    expect(rules.deny).not.toContain(absoluteRule("Edit", "/workspace/src"));
    // Reading beside the scope stays allowed: the scope is about writing.
    expect(rules.deny.some((rule) => rule.startsWith("Read(//") && rule.includes("workspace/docs"))).toBe(false);
  });
});

/**
 * Oracle: same research note. On darwin/linux the scoped launch gets both halves — sandbox
 * `denyWrite` on the siblings and `Edit` deny rules; on win32 only the rules, because Claude
 * activates no sandbox there. The executions root is never in a writable list.
 */
describe("runtime adapters — a scoped workspace-write launch", () => {
  async function scopedFixture() {
    const value = await runtimeFixture(writer({ writeScope: [] }));
    const project = join(value.root, "project");
    await mkdir(join(project, "src", "lib"), { recursive: true });
    await mkdir(join(project, "docs"), { recursive: true });
    await writeFile(join(project, "README.md"), "# readme\n");
    const scope = [join(project, "src", "lib")];
    const prepared = { ...value.prepared, policy: { ...value.prepared.policy, writeScope: scope } };
    const env = { HOME: value.root, ALP_REPO_ROOT: value.root };
    return { root: value.root, project, scope, prepared, env, executionsRoot: join(value.root, "executions") };
  }

  it("Claude on darwin: sandbox denies the siblings and the rules deny `Edit` on them", async () => {
    const { project, prepared, env, executionsRoot } = await scopedFixture();
    const launch = await new ClaudeRuntimeAdapter({ platform: "darwin", env }).prepare({ execution: prepared, model: "claude-test", reasoningEffort: "high", interactive: false });
    const settings = JSON.parse(await readFile(launch.temporaryFiles.find((file) => file.endsWith("claude-settings.json"))!, "utf8"));
    // Beside `src/lib` on the way down: `README.md` and `docs` at the workspace level, nothing inside `src`.
    const siblings = [join(project, "README.md"), join(project, "docs")];
    expect(settings.sandbox).toEqual({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyWrite: siblings },
    });
    for (const sibling of siblings) expect(settings.permissions.deny).toContain(absoluteRule("Edit", sibling));
    expect(settings.permissions.deny).not.toContain(absoluteRule("Edit", join(project, "src")));
    expect(settings.sandbox.filesystem).not.toHaveProperty("allowWrite");
    // The runtime directory under the executions root is *read* (task, capsule); nothing
    // there is ever granted for writing, by rule or by sandbox.
    expect(settings.permissions.allow.filter((rule: string) => rule.startsWith("Edit(") && rule.includes(executionsRoot))).toEqual([]);
  });

  it("Claude on win32: the rules alone, and no sandbox block", async () => {
    const { project, prepared, env } = await scopedFixture();
    const launch = await new ClaudeRuntimeAdapter({ platform: "win32", env }).prepare({ execution: prepared, model: "claude-test", reasoningEffort: "high", interactive: false });
    const settings = JSON.parse(await readFile(launch.temporaryFiles.find((file) => file.endsWith("claude-settings.json"))!, "utf8"));
    expect(settings).not.toHaveProperty("sandbox");
    expect(settings.permissions.deny).toContain(absoluteRule("Edit", join(project, "docs")));
  });

  it("Claude unscoped workspace-write: no sandbox block and no sibling rules, as before", async () => {
    const { project, prepared, env } = await scopedFixture();
    const unscoped = { ...prepared, policy: { ...prepared.policy, writeScope: null } };
    const launch = await new ClaudeRuntimeAdapter({ platform: "darwin", env }).prepare({ execution: unscoped, model: "claude-test", reasoningEffort: "high", interactive: false });
    const settings = JSON.parse(await readFile(launch.temporaryFiles.find((file) => file.endsWith("claude-settings.json"))!, "utf8"));
    expect(settings).not.toHaveProperty("sandbox");
    expect(settings.permissions.deny.some((rule: string) => rule.includes(project))).toBe(false);
  });

  it("Codex: `writable_roots` is the scope plus private memory, never the executions root", async () => {
    const { prepared, env, scope, executionsRoot, root } = await scopedFixture();
    const launch = await new CodexRuntimeAdapter({ platform: "linux", env }).prepare({ execution: prepared, model: "gpt-test", reasoningEffort: "high", interactive: false });
    const config = await readFile(launch.temporaryFiles.find((file) => file.endsWith("codex-config.toml"))!, "utf8");
    const roots = writableRoots(config.split("\n"));
    expect(roots).toEqual([...scope, join(root, ".alp", "memory", "private", "worker")]);
    for (const entry of roots) expect(executionsRoot.startsWith(entry)).toBe(false);
  });
});

/**
 * Oracle: the research note's conclusion — Claude posix `writeScope` is measured `partial`;
 * win32 stays `declared-only` (rules, no sandbox); Codex stays `enforced`.
 */
describe("capabilities — writeScope after P2's measurement", () => {
  it("reports `partial` for Claude on darwin/linux", () => {
    for (const platform of ["darwin", "linux"] as const) expect(capabilitiesFor("claude", platform).writeScope).toBe("partial");
    expect(capabilitiesFor("claude", "win32").writeScope).toBe("declared-only");
    expect(capabilitiesFor("codex", "darwin").writeScope).toBe("enforced");
  });
});

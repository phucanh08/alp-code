import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentRegistry } from "../../src/agents/registry";
import { createExecutionPolicy, readExcludeScope, readWriteScope } from "../../src/execution/execution-policy";
import { finalizeExecution } from "../../src/hooks/execution-bridge";
import { WorkflowRunner } from "../../src/workflow/workflow-runner";
import { removeTemporary } from "../support/temporary-root";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(removeTemporary)));

/**
 * Oracle: P2 spec — `writeScope` is hashed in `policy.json`, `null` when the whole workspace
 * is writable; the cutover reader accepts a snapshot that predates the field and refuses one
 * that carries a malformed value rather than reading it as "everything".
 */
describe("readWriteScope — a policy.json read from disk", () => {
  it("reads `null` from a snapshot that predates the field, and from an explicit null", () => {
    expect(readWriteScope({ role: "worker", policyHash: "abc" })).toBeNull();
    expect(readWriteScope({ writeScope: null })).toBeNull();
  });

  it("reads back the list a policy carries, frozen", () => {
    const value = readWriteScope({ writeScope: JSON.parse(JSON.stringify(["/ws/src", "/ws/docs"])) });
    expect(value).toEqual(["/ws/src", "/ws/docs"]);
    expect(Object.isFrozen(value)).toBe(true);
  });

  it("refuses a scope that is not a list of non-empty strings", () => {
    expect(() => readWriteScope({ writeScope: "/ws/src" })).toThrowError(/writeScope/);
    expect(() => readWriteScope({ writeScope: ["/ws/src", ""] })).toThrowError(/writeScope\[1\]/);
    expect(() => readWriteScope({ writeScope: [42] })).toThrowError(/writeScope\[0\]/);
    // An empty list is not "everything" and not "nothing we can name": it is refused.
    expect(() => readWriteScope({ writeScope: [] })).toThrowError(/writeScope/);
  });
});

/**
 * Oracle: master plan 2b — `excludeScope` is hashed beside `writeScope`, and is absent (not
 * `null`) from a snapshot with nothing excluded so that every policy written before 2b still
 * hashes the same.
 */
describe("readExcludeScope — a policy.json read from disk", () => {
  it("reads `null` from a snapshot that predates the field, and from an explicit null", () => {
    expect(readExcludeScope({ role: "worker", policyHash: "abc" })).toBeNull();
    expect(readExcludeScope({ excludeScope: null })).toBeNull();
  });

  it("reads back the list a policy carries, and refuses anything else", () => {
    expect(readExcludeScope({ excludeScope: ["/ws/src/parser"] })).toEqual(["/ws/src/parser"]);
    expect(() => readExcludeScope({ excludeScope: "/ws/src" })).toThrowError(/excludeScope/);
    expect(() => readExcludeScope({ excludeScope: [] })).toThrowError(/excludeScope/);
    expect(() => readExcludeScope({ excludeScope: ["/ws/src", ""] })).toThrowError(/excludeScope\[1\]/);
  });

  it("leaves the key out of the snapshot when nothing is excluded, so old snapshots keep their hash", () => {
    const definition = agentRegistry.get("worker");
    const base = { executionId: "exec_x", thread: null, definition, workspace: "/ws", workspaceMode: "workspace-write" as const, writeScope: ["/ws/src"], createdAt: "2026-09-12T10:00:00.000Z" };
    const before = createExecutionPolicy(base);
    expect(before).not.toHaveProperty("excludeScope");
    expect(createExecutionPolicy({ ...base, excludeScope: null }).policyHash).toBe(before.policyHash);
    const excluded = createExecutionPolicy({ ...base, excludeScope: ["/ws/src/parser", "/ws/src/lexer", "/ws/src/parser"] });
    expect(excluded.excludeScope).toEqual(["/ws/src/lexer", "/ws/src/parser"]);
    expect(excluded.policyHash).not.toBe(before.policyHash);
  });
});

describe("the hook bridge carries writeScope through its tamper check", () => {
  async function executionOnDisk(writeScope: readonly string[] | null, excludeScope: readonly string[] | null = null) {
    const root = await mkdtemp(join(tmpdir(), "alp-write-scope-bridge-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, "src"), { recursive: true });
    const executionId = "exec_scoped";
    const directory = join(root, executionId);
    await mkdir(directory);
    const definition = agentRegistry.get("worker");
    const policy = createExecutionPolicy({
      executionId, thread: null, definition, workspace, workspaceMode: "workspace-write", writeScope, excludeScope, createdAt: "2026-09-12T10:00:00.000Z",
    });
    const state = { executionId, status: "prepared", workflow: new WorkflowRunner().initialize(definition.workflow), policyHash: policy.policyHash, createdAt: policy.createdAt };
    await writeFile(join(directory, "policy.json"), JSON.stringify(policy));
    await writeFile(join(directory, "state.json"), JSON.stringify(state));
    await chmod(directory, 0o700);
    return { root, executionId, directory, policy, workspace };
  }

  it("finalizes an execution that ran under a scope", async () => {
    const value = await executionOnDisk([join("/ws", "src")]);
    await expect(finalizeExecution({ executionId: value.executionId, executionRoot: value.root, output: "done" }))
      .resolves.toMatchObject({ ok: true, status: "completed" });
  });

  it("finalizes an execution that ran under an exclusion, and refuses one whose exclusion was dropped", async () => {
    const value = await executionOnDisk([join("/ws", "src")], [join("/ws", "src", "parser")]);
    await expect(finalizeExecution({ executionId: value.executionId, executionRoot: value.root, output: "done" }))
      .resolves.toMatchObject({ ok: true, status: "completed" });
    const { excludeScope: _dropped, ...tampered } = value.policy;
    await writeFile(join(value.directory, "policy.json"), JSON.stringify(tampered));
    await expect(finalizeExecution({ executionId: value.executionId, executionRoot: value.root, output: "done" }))
      .rejects.toThrow(/policy snapshot is invalid or stale/);
  });

  it("refuses an execution whose scope was widened after the fact", async () => {
    const value = await executionOnDisk([join("/ws", "src")]);
    // Same hash, scope dropped: the scope the execution ran under is what the hash signs.
    const tampered = { ...value.policy, writeScope: null };
    await writeFile(join(value.directory, "policy.json"), JSON.stringify(tampered));
    await expect(finalizeExecution({ executionId: value.executionId, executionRoot: value.root, output: "done" }))
      .rejects.toThrow(/policy snapshot is invalid or stale/);
  });
});

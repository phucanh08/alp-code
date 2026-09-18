import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentRegistry } from "../../src/agents/registry";
import { FileSessionApprovals, readApprovals, type ApprovalRecordV1 } from "../../src/execution/approvals";
import { createExecutionPolicy } from "../../src/execution/execution-policy";
import { finalizeExecution } from "../../src/hooks/execution-bridge";
import { WorkflowRunner } from "../../src/workflow/workflow-runner";
import { removeTemporary } from "../support/temporary-root";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(removeTemporary)));

const APPROVAL: ApprovalRecordV1 = {
  version: 1,
  rule: "workspace-outside-grant-inside-project",
  subject: "/project/web",
  scope: "session",
  decidedBy: "principal",
  decidedAt: "2026-09-12T10:00:00.000Z",
};

/**
 * Oracle: phase-1 spec — `approvals` is hashed in `policy.json`, `[]` when nothing was asked;
 * the cutover reader accepts a snapshot that predates the field and refuses one that carries
 * a malformed record. A record that half-parses is worse than one that refuses.
 */
describe("readApprovals — a policy.json read from disk", () => {
  it("reads an empty list from a snapshot that predates the field", () => {
    expect(readApprovals({ role: "search", policyHash: "abc" })).toEqual([]);
  });

  it("reads back the records a policy carries", () => {
    expect(readApprovals({ approvals: JSON.parse(JSON.stringify([APPROVAL])) })).toEqual([APPROVAL]);
  });

  it("refuses a record of another version, an unknown rule, or a foreign decider", () => {
    expect(() => readApprovals({ approvals: [{ ...APPROVAL, version: 2 }] })).toThrowError(/approvals\[0\]/);
    expect(() => readApprovals({ approvals: [{ ...APPROVAL, rule: "anything-goes" }] })).toThrowError(/rule/);
    expect(() => readApprovals({ approvals: [{ ...APPROVAL, decidedBy: "worker" }] })).toThrowError(/principal/);
    expect(() => readApprovals({ approvals: [{ ...APPROVAL, subject: "" }] })).toThrowError(/subject/);
    expect(() => readApprovals({ approvals: { rule: APPROVAL.rule } })).toThrowError(/list/);
  });
});

describe("the hook bridge carries approvals through its tamper check", () => {
  async function executionOnDisk(approvals: readonly ApprovalRecordV1[]) {
    const root = await mkdtemp(join(tmpdir(), "alp-approval-bridge-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const executionId = "exec_approved";
    const directory = join(root, executionId);
    await mkdir(directory);
    const definition = agentRegistry.get("search");
    const policy = createExecutionPolicy({
      executionId, thread: null, definition, workspace, workspaceMode: "read-only", approvals, createdAt: "2026-09-12T10:00:00.000Z",
    });
    const state = { executionId, status: "prepared", workflow: new WorkflowRunner().initialize(definition.workflow), policyHash: policy.policyHash, createdAt: policy.createdAt };
    await writeFile(join(directory, "policy.json"), JSON.stringify(policy));
    await writeFile(join(directory, "state.json"), JSON.stringify(state));
    await chmod(directory, 0o700);
    return { root, executionId, directory, policy };
  }

  it("finalizes an execution that ran with an approval on record", async () => {
    const value = await executionOnDisk([APPROVAL]);
    await expect(finalizeExecution({ executionId: value.executionId, executionRoot: value.root, output: "done" }))
      .resolves.toMatchObject({ ok: true, status: "completed" });
  });

  it("refuses an execution whose approvals were edited after the fact", async () => {
    const value = await executionOnDisk([APPROVAL]);
    // Same hash, one record dropped: the answer the execution ran under is what the hash signs.
    const tampered = { ...value.policy, approvals: [] };
    await writeFile(join(value.directory, "policy.json"), JSON.stringify(tampered));
    await expect(finalizeExecution({ executionId: value.executionId, executionRoot: value.root, output: "done" }))
      .rejects.toThrow(/policy snapshot is invalid or stale/);
  });
});

describe("FileSessionApprovals — <root execution>/context/approvals.json", () => {
  it("is empty before anything was recorded, and survives a re-read", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-approvals-file-"));
    roots.push(root);
    const file = join(root, "exec_root", "context", "approvals.json");
    const store = new FileSessionApprovals(file);
    expect(await store.list()).toEqual([]);
    await store.record(APPROVAL);
    expect(await new FileSessionApprovals(file).list()).toEqual([APPROVAL]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([APPROVAL]);
  });

  it("refuses a file that is not a list of records rather than reading it as empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-approvals-file-"));
    roots.push(root);
    const file = join(root, "approvals.json");
    await writeFile(file, JSON.stringify({ approved: true }));
    await expect(new FileSessionApprovals(file).list()).rejects.toThrow(/not a list/);
    await writeFile(file, JSON.stringify([{ ...APPROVAL, decidedBy: "main" }]));
    await expect(new FileSessionApprovals(file).list()).rejects.toThrow(/principal/);
  });
});

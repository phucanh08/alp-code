import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAgent } from "../../src/agents/agent-definition";
import type { MemoryEntry } from "../../src/memory/types";
import { createExecutionPolicy } from "../../src/execution/execution-policy";
import { createIdentityCapsule } from "../../src/execution/identity-capsule";
import { defineOutputContract } from "../../src/workflow/output-validator";
import { WorkflowRunner } from "../../src/workflow/workflow-runner";

function memoryEntry(id: string, content: string): MemoryEntry {
  return {
    id,
    scope: id.startsWith("private:") ? "private" : "shared",
    ...(id.startsWith("private:") ? { ownerRole: id.split(":")[1] } : {}),
    kind: "fact",
    content,
    version: 1,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
  };
}

describe("identity capsules", () => {
  it("contains the resolved identity and only granted logical memory context", () => {
    const definition = defineAgent({
      id: "search",
      displayName: "Search",
      model: { claude: "claude-search", codex: "codex-search" },
      reasoningEffort: { claude: "low", codex: "low" },
      reportsTo: "main",
      delegatesTo: [],
      capabilities: {
        tools: ["Read", "Grep"],
        memory: {
          read: ["shared", "private:search"],
          write: ["private:search"],
        },
        workspace: { readRoots: ["/workspace"], writeRoots: [] },
      },
      instructions: () => "Search the workspace",
      workflow: {
        id: "search-workflow",
        initial: "RETRIEVE",
        states: {
          RETRIEVE: { allowedTools: ["Read", "Grep"], transitions: ["REPORT"] },
          REPORT: { allowedTools: [], transitions: [], terminal: true },
        },
      },
      output: defineOutputContract(
        "search-output",
        z.object({ evidence: z.array(z.string()) }).strict(),
      ),
    });
    const policy = createExecutionPolicy({
      executionId: "exec-capsule",
      definition,
      workspace: "/workspace",
      workspaceMode: "read-only",
      createdAt: "2026-08-26T00:00:00.000Z",
    });
    const shared = memoryEntry("shared:voice", "direct");
    const ownPrivate = memoryEntry("private:search:notes", "retrieval notes");
    const foreignPrivate = {
      ...memoryEntry("private:review:secret", "must not leak"),
      path: "/raw/memory/private/review/secret.md",
    } as MemoryEntry;
    const workflowState = new WorkflowRunner().initialize(definition.workflow);

    const capsule = createIdentityCapsule({
      definition,
      policy,
      task: "find the entrypoint",
      memoryContext: {
        invariantContext: "immutable invariants",
        policyContext: "immutable policy",
        entries: [shared, ownPrivate, foreignPrivate],
        diagnostics: {
          characterBudget: 100,
          charactersUsed: 21,
          truncated: true,
          omittedEntryIds: ["private:review:omitted"],
        },
      },
      workflowState,
    });

    expect(capsule).toMatchObject({
      executionId: "exec-capsule",
      definitionHash: policy.definitionHash,
      policyHash: policy.policyHash,
      role: "search",
      task: "find the entrypoint",
      activeWorkspace: "/workspace",
      workflowState,
      allowedTools: ["Read", "Grep"],
      outputContract: { name: "search-output", schema: expect.objectContaining({ type: "object" }) },
    });
    // Instructions are static role identity now — the task travels in `capsule.task`
    // and the prompt, so the same text can be rendered once into `.alp/agents/<role>.md`.
    expect(capsule.instructions).not.toContain("find the entrypoint");
    expect(capsule.memoryContext.entries.map(({ id }) => id)).toEqual([
      "shared:voice",
      "private:search:notes",
    ]);
    expect(JSON.stringify(capsule)).not.toContain("private:review");
    expect(JSON.stringify(capsule)).not.toContain("/raw/memory");
    expect(Object.isFrozen(capsule)).toBe(true);
    expect(Object.isFrozen(capsule.memoryContext.entries)).toBe(true);
  });

  it("produces deterministic definition hashes that change with grants", () => {
    const base = defineAgent({
      id: "main",
      displayName: "Main",
      model: { claude: "claude-main", codex: "codex-main" },
      reasoningEffort: { claude: "low", codex: "low" },
      reportsTo: "principal",
      delegatesTo: [],
      capabilities: {
        tools: ["Read"],
        memory: { read: ["shared"], write: [] },
        workspace: { readRoots: ["/workspace"], writeRoots: [] },
      },
      instructions: () => "main",
      workflow: {
        id: "main-workflow",
        initial: "REPORT",
        states: { REPORT: { allowedTools: [], transitions: [], terminal: true } },
      },
      output: defineOutputContract("main-output", z.object({ summary: z.string() })),
    });
    const changed = defineAgent({
      ...base,
      capabilities: { ...base.capabilities, tools: ["Read", "Grep"] },
    });
    const input = {
      executionId: "exec-hash",
      workspace: "/workspace",
      workspaceMode: "read-only" as const,
      createdAt: "2026-08-26T00:00:00.000Z",
    };

    const first = createExecutionPolicy({ ...input, definition: base });
    const repeated = createExecutionPolicy({ ...input, definition: base });
    const different = createExecutionPolicy({ ...input, definition: changed });

    expect(first.definitionHash).toBe(repeated.definitionHash);
    expect(first.definitionHash).not.toBe(different.definitionHash);
    expect(first.policyHash).toBe(repeated.policyHash);
  });
});

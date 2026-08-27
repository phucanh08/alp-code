import { describe, expect, it } from "vitest";
import { defineAgent } from "../../src/agents/agent-definition";
import { createAgentRegistry } from "../../src/agents/registry";
import type { AgentDefinition, AgentId } from "../../src/agents/types";
import {
  MemoryVersionConflictError,
  UnauthorizedMemoryAccessError,
} from "../../src/memory/errors";
import { MemoryService, parseMemoryId } from "../../src/memory/memory-service";
import type {
  CreateMemoryInput,
  MemoryAuditEvent,
  MemoryEntry,
  MemoryQuery,
  UpdateMemoryInput,
} from "../../src/memory/types";
import type { MemoryStore } from "../../src/memory/memory-store";
import { PolicyEngine } from "../../src/policy/policy-engine";

class InMemoryStore implements MemoryStore {
  readonly calls: string[] = [];
  readonly entries = new Map<string, MemoryEntry>();

  async search(query: MemoryQuery): Promise<readonly MemoryEntry[]> {
    this.calls.push(`search:${query.scope}`);
    return [...this.entries.values()].filter((entry) =>
      entry.id.startsWith(`${query.scope}:`) &&
      (!query.text || entry.content.includes(query.text)),
    );
  }

  async get(id: string): Promise<MemoryEntry | null> {
    this.calls.push(`get:${id}`);
    return this.entries.get(id) ?? null;
  }

  async create(input: CreateMemoryInput): Promise<MemoryEntry> {
    this.calls.push(`create:${input.id}`);
    const now = "2026-08-26T00:00:00.000Z";
    const parsed = parseMemoryId(input.id);
    const entry: MemoryEntry = {
      ...input,
      scope: parsed.scope,
      ...(parsed.ownerRole === undefined ? {} : { ownerRole: parsed.ownerRole }),
      ...(parsed.projectId === undefined ? {} : { projectId: parsed.projectId }),
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.entries.set(entry.id, entry);
    return entry;
  }

  async update(id: string, input: UpdateMemoryInput): Promise<MemoryEntry> {
    this.calls.push(`update:${id}`);
    const current = this.entries.get(id);
    if (!current) throw new Error(`missing ${id}`);
    if (current.version !== input.expectedVersion) {
      throw new MemoryVersionConflictError(id, input.expectedVersion, current.version);
    }
    const entry = {
      ...current,
      ...(input.content === undefined ? {} : { content: input.content }),
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      version: current.version + 1,
      updatedAt: "2026-08-26T00:00:01.000Z",
    };
    this.entries.set(id, entry);
    return entry;
  }

  async delete(id: string, expectedVersion: number): Promise<void> {
    this.calls.push(`delete:${id}`);
    const current = this.entries.get(id);
    if (!current) throw new Error(`missing ${id}`);
    if (current.version !== expectedVersion) {
      throw new MemoryVersionConflictError(id, expectedVersion, current.version);
    }
    this.entries.delete(id);
  }
}

function agent(
  id: AgentId,
  memory: AgentDefinition<unknown>["capabilities"]["memory"],
): AgentDefinition<unknown> {
  return defineAgent({
    id,
    displayName: id,
    model: { claude: `claude-${id}`, codex: `codex-${id}` },
    reasoningEffort: { claude: "low", codex: "low" },
    reportsTo: id === "main" ? "principal" : "main",
    delegatesTo: [],
    capabilities: {
      tools: ["Read"],
      memory,
      workspace: { readRoots: ["/workspace"], writeRoots: [] },
    },
    instructions: () => id,
    workflow: {
      id: `${id}-workflow`,
      initial: "REPORT",
      states: {
        REPORT: { allowedTools: [], transitions: [], terminal: true },
      },
    },
    output: { name: `${id}-output`, schema: {}, validate: () => ({ ok: true }) },
  });
}

function fixture() {
  const store = new InMemoryStore();
  const audit: MemoryAuditEvent[] = [];
  const registry = createAgentRegistry([
    agent("main", {
      read: ["shared", "project:alp", "private:main"],
      write: ["shared", "project:alp", "private:main"],
    }),
    agent("search", {
      read: ["shared", "project:alp", "private:search"],
      write: ["private:search"],
    }),
  ]);
  const service = new MemoryService({
    store,
    policy: new PolicyEngine({ registry }),
    audit: { record: (event) => { audit.push(event); } },
  });
  return { audit, service, store };
}

describe("MemoryService", () => {
  it("keeps private entries visible only to their owner", async () => {
    const { service, store } = fixture();
    await service.create("search", {
      id: "private:search:notes",
      kind: "draft",
      content: "search-only",
    });

    await expect(service.get("main", "private:search:notes")).rejects.toBeInstanceOf(
      UnauthorizedMemoryAccessError,
    );
    expect(store.calls.filter((call) => call === "get:private:search:notes")).toHaveLength(0);
    await expect(service.get("search", "private:search:notes")).resolves.toMatchObject({
      content: "search-only",
    });
  });

  it("obeys shared and project grants", async () => {
    const { service } = fixture();
    await service.create("main", { id: "shared:voice", kind: "fact", content: "direct" });
    await service.create("main", {
      id: "project:alp:decision",
      kind: "decision",
      content: "code-native",
    });

    await expect(service.get("search", "shared:voice")).resolves.toMatchObject({ id: "shared:voice" });
    await expect(service.search("search", { scope: "project:alp", text: "native" })).resolves.toHaveLength(1);
    await expect(
      service.search("search", { scope: "project:other" }),
    ).rejects.toBeInstanceOf(UnauthorizedMemoryAccessError);
  });

  it("does not call the store for an unauthorized write", async () => {
    const { service, store } = fixture();

    await expect(
      service.create("search", { id: "shared:forbidden", kind: "fact", content: "no" }),
    ).rejects.toBeInstanceOf(UnauthorizedMemoryAccessError);
    expect(store.calls).toEqual([]);
  });

  it("preserves typed version conflicts", async () => {
    const { service } = fixture();
    await service.create("main", { id: "shared:versioned", kind: "fact", content: "v1" });

    await expect(
      service.update("main", "shared:versioned", { expectedVersion: 0, content: "stale" }),
    ).rejects.toMatchObject({
      name: "MemoryVersionConflictError",
      id: "shared:versioned",
      expectedVersion: 0,
      actualVersion: 1,
    });
  });

  it("builds ranked context within budget without mixing invariant context", async () => {
    const { service } = fixture();
    await service.create("main", { id: "shared:a", kind: "fact", content: "12345" });
    await service.create("main", { id: "shared:b", kind: "fact", content: "67890" });

    const result = await service.buildContext({
      actor: "main",
      queries: [{ scope: "shared" }],
      characterBudget: 5,
      invariantContext: "IMMUTABLE-INVARIANTS",
      policyContext: "IMMUTABLE-POLICY",
    });

    expect(result.invariantContext).toBe("IMMUTABLE-INVARIANTS");
    expect(result.policyContext).toBe("IMMUTABLE-POLICY");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].content.length).toBeLessThanOrEqual(5);
    expect(result.diagnostics).toMatchObject({
      characterBudget: 5,
      charactersUsed: 5,
      truncated: true,
      omittedEntryIds: ["shared:b"],
    });
  });

  it("audits actor, operation, logical ID, and result", async () => {
    const { audit, service } = fixture();
    await service.create("main", { id: "shared:audit", kind: "log", content: "created" });
    await expect(service.get("search", "private:main:hidden")).rejects.toBeInstanceOf(
      UnauthorizedMemoryAccessError,
    );

    expect(audit).toEqual([
      expect.objectContaining({ actor: "main", operation: "create", logicalId: "shared:audit", result: "allowed" }),
      expect.objectContaining({ actor: "search", operation: "get", logicalId: "private:main:hidden", result: "denied" }),
    ]);
  });
});

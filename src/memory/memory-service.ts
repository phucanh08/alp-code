import type { AgentId, MemoryScopeGrant } from "../agents/types";
import { memoryGrantCovers } from "../agents/memory-grant";
import type { Authorization, AuthorizationRequest } from "../policy/types";
import { DeterministicContextRanker, type ContextRanker } from "./context-ranker";
import { InvalidMemoryIdError, UnauthorizedMemoryAccessError } from "./errors";
import type { MemoryStore } from "./memory-store";
import type {
  BuildMemoryContextInput,
  BuiltMemoryContext,
  CreateMemoryInput,
  MemoryAuditEvent,
  MemoryEntry,
  MemoryOperation,
  MemoryQuery,
  ParsedMemoryId,
  UpdateMemoryInput,
} from "./types";

export interface MemoryAuthorizer {
  authorize(request: AuthorizationRequest): Authorization;
}

export interface MemoryAuditSink {
  record(event: MemoryAuditEvent): void | Promise<void>;
}

export interface MemoryServiceOptions {
  readonly store: MemoryStore;
  readonly policy: MemoryAuthorizer;
  readonly audit: MemoryAuditSink;
  readonly ranker?: ContextRanker;
  readonly now?: () => Date;
}

function validSegment(segment: string): boolean {
  return segment.length > 0 && segment !== "." && segment !== ".." && !segment.includes("/") && !segment.includes("\\");
}

export function parseMemoryId(id: string): ParsedMemoryId {
  const segments = id.split(":");
  if (segments[0] === "shared" && segments.length >= 2 && segments.slice(1).every(validSegment)) {
    const pathSegments = Object.freeze(segments.slice(1));
    return { id, scope: "shared", grant: id as MemoryScopeGrant, name: pathSegments.join(":"), pathSegments };
  }
  if (
    segments[0] === "project" &&
    segments.length >= 3 &&
    segments.slice(1).every(validSegment)
  ) {
    const pathSegments = Object.freeze(segments.slice(2));
    return {
      id,
      scope: "project",
      grant: id as MemoryScopeGrant,
      projectId: segments[1],
      name: pathSegments.join(":"),
      pathSegments,
    };
  }
  if (
    segments[0] === "private" &&
    segments.length >= 3 &&
    segments.slice(1).every(validSegment)
  ) {
    const pathSegments = Object.freeze(segments.slice(2));
    return {
      id,
      scope: "private",
      grant: id as MemoryScopeGrant,
      ownerRole: segments[1],
      name: pathSegments.join(":"),
      pathSegments,
    };
  }
  throw new InvalidMemoryIdError(id);
}

export class MemoryService {
  private readonly store: MemoryStore;
  private readonly policy: MemoryAuthorizer;
  private readonly audit: MemoryAuditSink;
  private readonly ranker: ContextRanker;
  private readonly now: () => Date;

  constructor(options: MemoryServiceOptions) {
    this.store = options.store;
    this.policy = options.policy;
    this.audit = options.audit;
    this.ranker = options.ranker ?? new DeterministicContextRanker();
    this.now = options.now ?? (() => new Date());
  }

  private async record(
    actor: AgentId,
    operation: MemoryOperation,
    logicalId: string,
    result: MemoryAuditEvent["result"],
    detail?: string,
  ): Promise<void> {
    await this.audit.record({
      actor,
      operation,
      logicalId,
      result,
      timestamp: this.now().toISOString(),
      ...(detail === undefined ? {} : { detail }),
    });
  }

  private async authorize(
    actor: AgentId,
    operation: MemoryOperation,
    access: "read" | "write",
    scope: MemoryScopeGrant,
    logicalId: string,
  ): Promise<void> {
    const authorization = this.policy.authorize({ type: "memory", actor, operation: access, scope });
    if (!authorization.allowed) {
      await this.record(actor, operation, logicalId, "denied", authorization.code);
      throw new UnauthorizedMemoryAccessError(actor, access, scope, authorization.code);
    }
  }

  private async call<T>(
    actor: AgentId,
    operation: MemoryOperation,
    logicalId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await action();
      await this.record(actor, operation, logicalId, "allowed");
      return result;
    } catch (error) {
      const detail = error instanceof Error ? error.name : String(error);
      await this.record(actor, operation, logicalId, "error", detail);
      throw error;
    }
  }

  async search(actor: AgentId, query: MemoryQuery): Promise<readonly MemoryEntry[]> {
    await this.authorize(actor, "search", "read", query.scope, query.scope);
    return this.call(actor, "search", query.scope, async () => {
      const entries = await this.store.search(query);
      return entries.filter((entry) =>
        memoryGrantCovers(query.scope, entry.id as MemoryScopeGrant),
      );
    });
  }

  async get(actor: AgentId, id: string): Promise<MemoryEntry | null> {
    const parsed = parseMemoryId(id);
    await this.authorize(actor, "get", "read", parsed.grant, id);
    return this.call(actor, "get", id, () => this.store.get(id));
  }

  async create(actor: AgentId, input: CreateMemoryInput): Promise<MemoryEntry> {
    const parsed = parseMemoryId(input.id);
    await this.authorize(actor, "create", "write", parsed.grant, input.id);
    return this.call(actor, "create", input.id, () => this.store.create(input));
  }

  async update(actor: AgentId, id: string, input: UpdateMemoryInput): Promise<MemoryEntry> {
    const parsed = parseMemoryId(id);
    await this.authorize(actor, "update", "write", parsed.grant, id);
    return this.call(actor, "update", id, () => this.store.update(id, input));
  }

  async delete(actor: AgentId, id: string, expectedVersion: number): Promise<void> {
    const parsed = parseMemoryId(id);
    await this.authorize(actor, "delete", "write", parsed.grant, id);
    return this.call(actor, "delete", id, () => this.store.delete(id, expectedVersion));
  }

  async buildContext(input: BuildMemoryContextInput): Promise<BuiltMemoryContext> {
    if (!Number.isInteger(input.characterBudget) || input.characterBudget < 0) {
      throw new RangeError("characterBudget must be a non-negative integer");
    }

    const byId = new Map<string, MemoryEntry>();
    for (const query of input.queries) {
      for (const entry of await this.search(input.actor, query)) byId.set(entry.id, entry);
    }
    const ranked = this.ranker.rank([...byId.values()], input.queries);
    const entries: MemoryEntry[] = [];
    const omittedEntryIds: string[] = [];
    let charactersUsed = 0;
    for (const entry of ranked) {
      if (charactersUsed + entry.content.length <= input.characterBudget) {
        entries.push(entry);
        charactersUsed += entry.content.length;
      } else {
        omittedEntryIds.push(entry.id);
      }
    }

    return Object.freeze({
      invariantContext: input.invariantContext,
      policyContext: input.policyContext,
      entries: Object.freeze(entries),
      diagnostics: Object.freeze({
        characterBudget: input.characterBudget,
        charactersUsed,
        truncated: omittedEntryIds.length > 0,
        omittedEntryIds: Object.freeze(omittedEntryIds),
      }),
    });
  }
}

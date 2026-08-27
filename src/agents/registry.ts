import { isAbsolute, relative, resolve } from "node:path";
import { defineAgent } from "./agent-definition";
import { AgentRegistryError } from "./errors";
import { memoryGrantCovers } from "./memory-grant";
import type {
  AgentDefinition,
  AgentId,
  AgentRegistry,
  MemoryScopeGrant,
} from "./types";
import { TOOL_CATALOG } from "./types";

const KNOWN_TOOLS = new Set<string>(TOOL_CATALOG);
const REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);

function assertNonEmpty(value: string, label: string, agentId: AgentId): void {
  if (!value.trim()) {
    throw new AgentRegistryError(
      "INVALID_AGENT",
      `agent \`${agentId}\` has an empty ${label}`,
    );
  }
}

function pathIsWithin(root: string, target: string): boolean {
  const relation = relative(resolve(root), resolve(target));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function assertWorkspaceWriteSubset(
  agentId: AgentId,
  writes: readonly string[],
  reads: readonly string[],
): void {
  for (const write of writes) {
    if (!reads.some((read) => pathIsWithin(read, write))) {
      throw new AgentRegistryError(
        "INVALID_WORKSPACE_GRANT",
        `agent \`${agentId}\` workspace write root \`${write}\` is not readable`,
      );
    }
  }
}

function assertMemoryWriteSubset(
  agentId: AgentId,
  writes: readonly MemoryScopeGrant[],
  reads: readonly MemoryScopeGrant[],
): void {
  for (const write of writes) {
    if (!reads.some((read) => memoryGrantCovers(read, write))) {
      throw new AgentRegistryError(
        "INVALID_MEMORY_GRANT",
        `agent \`${agentId}\` memory write grant \`${write}\` is not readable`,
      );
    }
  }
}

function privateOwner(grant: MemoryScopeGrant): AgentId | null {
  return grant.startsWith("private:") ? grant.slice("private:".length) : null;
}

function assertDefinitionInvariants(
  definition: AgentDefinition<unknown>,
): void {
  assertNonEmpty(definition.id, "id", definition.id);
  assertNonEmpty(definition.displayName, "displayName", definition.id);
  if (!definition.model.claude.trim()) {
    throw new AgentRegistryError(
      "INVALID_AGENT",
      `agent \`${definition.id}\` is missing Claude runtime model`,
    );
  }
  if (!definition.model.codex.trim()) {
    throw new AgentRegistryError(
      "INVALID_AGENT",
      `agent \`${definition.id}\` is missing Codex runtime model`,
    );
  }
  for (const runtime of ["claude", "codex"] as const) {
    if (!REASONING_EFFORTS.has(definition.reasoningEffort[runtime])) {
      throw new AgentRegistryError(
        "INVALID_AGENT",
        `agent \`${definition.id}\` has invalid ${runtime} reasoning effort`,
      );
    }
  }
  assertNonEmpty(definition.workflow.id, "workflow id", definition.id);
  assertNonEmpty(definition.output.name, "output contract name", definition.id);

  assertWorkspaceWriteSubset(
    definition.id,
    definition.capabilities.workspace.writeRoots,
    definition.capabilities.workspace.readRoots,
  );
  assertMemoryWriteSubset(
    definition.id,
    definition.capabilities.memory.write,
    definition.capabilities.memory.read,
  );

  for (const tool of definition.capabilities.tools) {
    if (!KNOWN_TOOLS.has(tool)) {
      throw new AgentRegistryError(
        "UNKNOWN_TOOL",
        `agent \`${definition.id}\` has unknown tool \`${tool}\``,
      );
    }
  }

  for (const grant of [
    ...definition.capabilities.memory.read,
    ...definition.capabilities.memory.write,
  ]) {
    const owner = privateOwner(grant);
    if (owner !== null && owner !== definition.id) {
      throw new AgentRegistryError(
        "INVALID_MEMORY_GRANT",
        `agent \`${definition.id}\` cannot access private memory for \`${owner}\``,
      );
    }
  }
}

function assertRelations(
  definitions: readonly AgentDefinition<unknown>[],
  known: ReadonlySet<AgentId>,
): void {
  for (const definition of definitions) {
    if (definition.reportsTo !== "principal" && !known.has(definition.reportsTo)) {
      throw new AgentRegistryError(
        "UNKNOWN_RELATION",
        `agent \`${definition.id}\` has unknown reportsTo \`${definition.reportsTo}\``,
      );
    }

    for (const target of definition.delegatesTo) {
      if (target === definition.id) {
        throw new AgentRegistryError(
          "INVALID_DELEGATION",
          `agent \`${definition.id}\` cannot delegate to itself`,
        );
      }
      if (!known.has(target)) {
        throw new AgentRegistryError(
          "UNKNOWN_RELATION",
          `agent \`${definition.id}\` has unknown delegation target \`${target}\``,
        );
      }
    }
  }
}

function assertNoDelegationCycles(
  definitions: readonly AgentDefinition<unknown>[],
  byId: ReadonlyMap<AgentId, AgentDefinition<unknown>>,
): void {
  const state = new Map<AgentId, "visiting" | "visited">();
  const trail: AgentId[] = [];

  const visit = (id: AgentId): void => {
    if (state.get(id) === "visited") return;
    if (state.get(id) === "visiting") {
      const cycleStart = trail.indexOf(id);
      const cycle = [...trail.slice(cycleStart), id];
      throw new AgentRegistryError(
        "INVALID_DELEGATION",
        `delegation cycle: ${cycle.join(" -> ")}`,
      );
    }

    state.set(id, "visiting");
    trail.push(id);
    for (const target of byId.get(id)?.delegatesTo ?? []) visit(target);
    trail.pop();
    state.set(id, "visited");
  };

  for (const definition of definitions) visit(definition.id);
}

export function createAgentRegistry(
  input: readonly AgentDefinition<unknown>[],
): AgentRegistry {
  const definitions: AgentDefinition<unknown>[] = [];
  const byId = new Map<AgentId, AgentDefinition<unknown>>();

  for (const candidate of input) {
    const definition = defineAgent(candidate);
    if (byId.has(definition.id)) {
      throw new AgentRegistryError(
        "DUPLICATE_AGENT",
        `duplicate agent \`${definition.id}\``,
      );
    }
    assertDefinitionInvariants(definition);
    definitions.push(definition);
    byId.set(definition.id, definition);
  }

  assertRelations(definitions, new Set(byId.keys()));
  assertNoDelegationCycles(definitions, byId);
  const list = Object.freeze(definitions.slice());

  return Object.freeze({
    get(id: AgentId): AgentDefinition<unknown> {
      const definition = byId.get(id);
      if (!definition) {
        throw new AgentRegistryError("UNKNOWN_AGENT", `unknown agent \`${id}\``);
      }
      return definition;
    },
    has(id: AgentId): boolean {
      return byId.has(id);
    },
    list(): readonly AgentDefinition<unknown>[] {
      return list;
    },
  });
}

import { mainAgent } from "./main";
import { searchAgent } from "./search";
import { librarianAgent } from "./librarian";
import { readThreadAgent } from "./read-thread";
import { reviewAgent } from "./review";
import { oracleAgent } from "./oracle";
import { compactionAgent } from "./compaction";
import { titlingAgent } from "./titling";

export const AGENT_DEFINITIONS = Object.freeze([
  mainAgent,
  searchAgent,
  librarianAgent,
  readThreadAgent,
  reviewAgent,
  oracleAgent,
  compactionAgent,
  titlingAgent,
]);

export const agentRegistry = createAgentRegistry(AGENT_DEFINITIONS);

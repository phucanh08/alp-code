import { isAbsolute, relative, resolve } from "node:path";
import { defineAgent } from "./agent-definition";
import { capabilityCatalog, type CapabilityCatalog } from "./capability-catalog";
import { AgentRegistryError } from "./errors";
import { memoryGrantCovers } from "./memory-grant";
import { MODEL_CONTEXT_WINDOWS } from "./model-context";
import type {
  AgentDefinition,
  AgentId,
  AgentRegistry,
  MemoryScopeGrant,
} from "./types";
import { RUNTIME_IDS, TOOL_CATALOG } from "./types";

const KNOWN_TOOLS = new Set<string>(TOOL_CATALOG);
/** Claude's documented `autoCompactWindow` bounds; Codex publishes none, so it shares them. */
const AUTO_COMPACT_MIN_TOKENS = 100_000;
const AUTO_COMPACT_MAX_TOKENS = 1_000_000;
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

function assertNoDuplicates(
  agentId: AgentId,
  label: string,
  names: readonly string[],
): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      throw new AgentRegistryError(
        "DUPLICATE_GRANT",
        `agent \`${agentId}\` names ${label} \`${name}\` twice`,
      );
    }
    seen.add(name);
  }
}

/**
 * The three name-declared grants of §5.3, checked against the catalog the principal keeps.
 *
 * A name that resolves to nothing is refused rather than ignored: a definition asking for
 * `mcpServers: ["github"]` on a machine that never trusted `github` is stating an intent
 * the execution cannot honour, and the quiet reading of that — no server, run anyway — is
 * how a role ends up reporting failure for a reason nobody can see.
 */
function assertCapabilityGrants(
  definition: AgentDefinition<unknown>,
  catalog: CapabilityCatalog,
): void {
  const { skills, subagents, mcpServers, tools } = definition.capabilities;
  assertNoDuplicates(definition.id, "skill", skills);
  assertNoDuplicates(definition.id, "subagent", subagents);
  assertNoDuplicates(definition.id, "mcp server", mcpServers);

  // A project-scoped grant carries its own resolved path, so the catalog — which describes
  // the shipped tree — is the wrong question for it. Everything else still has to be a name
  // the machine can resolve.
  const bound = new Set((definition.capabilities.skillBindings ?? []).map((binding) => binding.name));
  const known = new Set(catalog.skills);
  for (const skill of skills) {
    if (!known.has(skill) && !bound.has(skill)) {
      throw new AgentRegistryError(
        "UNKNOWN_SKILL",
        `agent \`${definition.id}\` has unknown skill \`${skill}\``,
      );
    }
  }
  for (const subagent of subagents) {
    if (!Object.hasOwn(catalog.subagents, subagent)) {
      throw new AgentRegistryError(
        "UNKNOWN_SUBAGENT",
        `agent \`${definition.id}\` has unknown subagent \`${subagent}\``,
      );
    }
  }
  for (const server of mcpServers) {
    if (!Object.hasOwn(catalog.mcpServers, server)) {
      throw new AgentRegistryError(
        "UNKNOWN_MCP_SERVER",
        `agent \`${definition.id}\` has unknown mcp server \`${server}\``,
      );
    }
  }

  // A subagent runs inside this role's own process. Handing it a tool the role does not
  // hold would make the grant a way around the role's limits — the thing the house rule
  // says it is not.
  for (const subagent of subagents) {
    for (const tool of catalog.subagents[subagent]?.tools ?? []) {
      if (!definition.capabilities.tools.includes(tool)) {
        throw new AgentRegistryError(
          "UNKNOWN_TOOL",
          `agent \`${definition.id}\` grants subagent \`${subagent}\` the ungranted tool \`${tool}\``,
        );
      }
    }
  }

  // Names are what policy answers with; bindings are where those names resolve. A binding
  // for a name the role does not hold would be a grant no rule mentions, and a root with no
  // binding is a directory whose contents nobody enumerated.
  const bindings = definition.capabilities.skillBindings ?? [];
  for (const binding of bindings) {
    if (!skills.includes(binding.name)) {
      throw new AgentRegistryError(
        "INVALID_SKILL_GRANT",
        `agent \`${definition.id}\` binds skill \`${binding.name}\` without naming it`,
      );
    }
  }
  if (bindings.length > 0 && (definition.capabilities.skillRoots ?? []).length === 0) {
    throw new AgentRegistryError(
      "INVALID_SKILL_GRANT",
      `agent \`${definition.id}\` binds skills but declares no skill root`,
    );
  }

  const holdsSkillTool = tools.includes("Skill");
  if (holdsSkillTool && skills.length === 0) {
    throw new AgentRegistryError(
      "INVALID_SKILL_GRANT",
      `agent \`${definition.id}\` grants the \`Skill\` tool but names no skill`,
    );
  }
  if (!holdsSkillTool && skills.length > 0) {
    throw new AgentRegistryError(
      "INVALID_SKILL_GRANT",
      `agent \`${definition.id}\` names skills but has no \`Skill\` tool to invoke them`,
    );
  }
}

function assertDefinitionInvariants(
  definition: AgentDefinition<unknown>,
  catalog: CapabilityCatalog,
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
  for (const runtime of RUNTIME_IDS) {
    if (!REASONING_EFFORTS.has(definition.reasoningEffort[runtime])) {
      throw new AgentRegistryError(
        "INVALID_AGENT",
        `agent \`${definition.id}\` has invalid ${runtime} reasoning effort`,
      );
    }
  }
  for (const runtime of RUNTIME_IDS) {
    const autoCompact = definition.autoCompactTokens?.[runtime];
    if (autoCompact === undefined) continue;
    const prefix = `agent \`${definition.id}\` has ${runtime} auto-compact threshold \`${autoCompact}\``;
    if (
      !Number.isInteger(autoCompact)
      || autoCompact < AUTO_COMPACT_MIN_TOKENS
      || autoCompact > AUTO_COMPACT_MAX_TOKENS
    ) {
      throw new AgentRegistryError(
        "INVALID_AUTO_COMPACT_LIMIT",
        `${prefix}, outside ${AUTO_COMPACT_MIN_TOKENS}–${AUTO_COMPACT_MAX_TOKENS} whole tokens`,
      );
    }
    // A threshold above the model's own window is a line the transcript can never cross:
    // the runtime falls back to its hard limit and compacts later than the role asked,
    // while argv still prints a number that says otherwise. Refused here rather than
    // clamped at launch — the number is wrong where it is written, not where it is read.
    const window = MODEL_CONTEXT_WINDOWS[definition.model[runtime]];
    if (window !== undefined && autoCompact > window) {
      throw new AgentRegistryError(
        "INVALID_AUTO_COMPACT_LIMIT",
        `${prefix} above the context window of \`${definition.model[runtime]}\` (${window} tokens)`,
      );
    }
  }
  // Identity is data (`InstructionSpec`), so the registry checks it the way it checks every
  // other declared field. A definition whose prompt renders to a bare template is an agent
  // with no purpose, and it would still hash, load and launch.
  assertNonEmpty(definition.instructions.role, "instruction role", definition.id);
  assertNonEmpty(definition.instructions.purpose, "instruction purpose", definition.id);
  for (const rule of definition.instructions.rules) {
    if (!rule.trim()) {
      throw new AgentRegistryError(
        "INVALID_AGENT",
        `agent \`${definition.id}\` has an empty instruction rule`,
      );
    }
  }
  const audience = definition.instructions.audience;
  if (audience !== undefined && audience !== "principal" && audience !== "machine") {
    throw new AgentRegistryError(
      "INVALID_AGENT",
      `agent \`${definition.id}\` has unknown instruction audience \`${String(audience)}\``,
    );
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

  assertCapabilityGrants(definition, catalog);

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

export interface CreateAgentRegistryOptions {
  /** Defaults to the shipped catalog; tests and future `.alp/` loads supply their own. */
  readonly catalog?: CapabilityCatalog;
}

export function createAgentRegistry(
  input: readonly AgentDefinition<unknown>[],
  options: CreateAgentRegistryOptions = {},
): AgentRegistry {
  const catalog = options.catalog ?? capabilityCatalog;
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
    assertDefinitionInvariants(definition, catalog);
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

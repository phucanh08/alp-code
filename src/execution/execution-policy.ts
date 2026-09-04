import { createHash } from "node:crypto";
import { capabilityCatalog, type CapabilityCatalog } from "../agents/capability-catalog";
import type { AgentDefinition } from "../agents/types";
import {
  deepFreezeExecutionValue,
  type ExecutionId,
  type ExecutionPolicy,
} from "./types";

export interface CreateExecutionPolicyInput {
  readonly executionId: ExecutionId;
  readonly definition: AgentDefinition<unknown>;
  readonly workspace: string;
  readonly workspaceMode: "read-only" | "workspace-write";
  readonly createdAt: string;
  /** Defaults to the shipped catalog — see `capability-catalog.ts`. */
  readonly catalog?: CapabilityCatalog;
}

function canonicalize(value: unknown): unknown {
  if (typeof value === "function") return value.toString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function hashAgentDefinition(
  definition: AgentDefinition<unknown>,
): string {
  return sha256({
    id: definition.id,
    displayName: definition.displayName,
    model: definition.model,
    reasoningEffort: definition.reasoningEffort,
    reportsTo: definition.reportsTo,
    delegatesTo: definition.delegatesTo,
    capabilities: definition.capabilities,
    instructions: definition.instructions,
    workflow: definition.workflow,
    output: {
      name: definition.output.name,
      schema: definition.output.schema,
      validate: definition.output.validate,
    },
  });
}

export function createExecutionPolicy(
  input: CreateExecutionPolicyInput,
): ExecutionPolicy {
  const definitionHash = hashAgentDefinition(input.definition);
  const catalog = input.catalog ?? capabilityCatalog;
  const capabilities = input.definition.capabilities;
  // Names were checked against this catalog at registry load; a miss here would mean the
  // catalog changed underneath a definition, and an execution is not the place to find out.
  const resolve = <TEntry>(
    kind: string,
    names: readonly string[],
    entries: Readonly<Record<string, TEntry>>,
  ): readonly (TEntry & { readonly name: string })[] => names.map((name) => {
    const entry = entries[name];
    if (entry === undefined) {
      throw new Error(`unknown ${kind} \`${name}\` granted to \`${input.definition.id}\``);
    }
    return { name, ...entry };
  });
  const snapshot = {
    executionId: input.executionId,
    role: input.definition.id,
    workspace: input.workspace,
    workspaceMode: input.workspaceMode,
    workspaceAccess: input.definition.capabilities.workspace.readRoots.length > 0
      ? "granted" as const
      : "none" as const,
    allowedTools: [...capabilities.tools],
    skills: [...capabilities.skills],
    subagents: resolve("subagent", capabilities.subagents, catalog.subagents),
    mcpServers: resolve("mcp server", capabilities.mcpServers, catalog.mcpServers),
    memory: {
      read: [...input.definition.capabilities.memory.read],
      write: [...input.definition.capabilities.memory.write],
    },
    delegatesTo: [...input.definition.delegatesTo],
    createdAt: input.createdAt,
    definitionHash,
  };
  return deepFreezeExecutionValue({
    ...snapshot,
    policyHash: sha256(snapshot),
  });
}

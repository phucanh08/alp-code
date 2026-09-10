import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { defineAgent } from "../agent-definition";
import { capabilityCatalog, type CapabilityCatalog } from "../capability-catalog";
import { AGENT_DEFINITIONS, createAgentRegistry } from "../registry";
import { textOutput } from "../shared/voice";
import type {
  AgentDefinition,
  AgentId,
  AgentRegistry,
  MemoryScopeGrant,
} from "../types";
import { defineLinearWorkflow } from "../../workflow/types";
import { enforceCeiling, type CapabilityCeiling } from "./ceiling";
import { parseAgentFile } from "./parse";
import { HOUSE_RULE_SETS, type AgentFile } from "./schema";

export const AGENT_FILE_NAME = "agent.yaml";
/** The coordinator every custom agent reports to (§5.5); not declarable in the file. */
export const CUSTOM_AGENT_PARENT: AgentId = "main";
/**
 * What a file that names no house-rule set gets.
 *
 * `code-native` rather than `none`: the house rules are where the system's invariants live,
 * and silence in a definition is not a request to drop them. Opting out is a written choice.
 */
export const DEFAULT_HOUSE_RULES = "code-native" as const;

export interface LoadedAgent {
  readonly id: AgentId;
  readonly sourcePath: string;
  readonly definition: AgentDefinition<unknown>;
}

export interface AgentLoadFailure {
  readonly id: AgentId;
  readonly sourcePath: string;
  readonly issues: readonly string[];
}

export interface AgentLoadResult {
  readonly agentsDirectory: string;
  readonly loaded: readonly LoadedAgent[];
  readonly failed: readonly AgentLoadFailure[];
  /** Directories that carry no `agent.yaml` — skill overlays for a built-in (§5.7.5). */
  readonly overlays: readonly string[];
}

export interface LoadProjectAgentsOptions {
  readonly projectRoot: string;
  readonly builtins?: readonly AgentDefinition<unknown>[];
  readonly catalog?: CapabilityCatalog;
}

function toDefinition(file: AgentFile): AgentDefinition<unknown> {
  const capabilities = file.capabilities;
  const workspace = capabilities.workspace ?? {};
  const memory = capabilities.memory ?? {};
  const rules = [
    ...HOUSE_RULE_SETS[file.instructions.houseRules ?? DEFAULT_HOUSE_RULES],
    ...(file.instructions.rules ?? []),
  ];

  return defineAgent({
    id: file.id,
    displayName: file.displayName,
    model: file.model,
    reasoningEffort: file.reasoningEffort,
    // Forced, not read: a file that could name its own parent or its own children would be
    // writing the shape of the team it joins (§5.5).
    reportsTo: CUSTOM_AGENT_PARENT,
    delegatesTo: [],
    ...(file.autoCompactTokens ? { autoCompactTokens: file.autoCompactTokens } : {}),
    capabilities: {
      tools: capabilities.tools,
      skills: capabilities.skills ?? [],
      subagents: capabilities.subagents ?? [],
      mcpServers: capabilities.mcpServers ?? [],
      memory: {
        read: (memory.read ?? []) as readonly MemoryScopeGrant[],
        write: (memory.write ?? []) as readonly MemoryScopeGrant[],
      },
      workspace: {
        readRoots: workspace.readRoots ?? [],
        writeRoots: workspace.writeRoots ?? [],
      },
    },
    // Data, not a closure — `definitionHash` has to cover what the model is told, and every
    // custom agent built here shares one code path (see `InstructionSpec`).
    instructions: {
      role: file.instructions.role,
      purpose: file.instructions.purpose,
      rules,
    },
    workflow: defineLinearWorkflow(
      `${file.id}-workflow`,
      file.workflow.map((state) => ({ id: state.id, allowedTools: state.allowedTools })),
    ),
    output: textOutput(`${file.id}-result`),
  });
}

/**
 * Reads `<project>/.alp/agents/<id>/agent.yaml` (§5.7).
 *
 * A **file** `<id>.md` there is a rendered identity document, written by `alp identity sync`;
 * a **directory** is a definition, and a directory with no `agent.yaml` is a skill overlay
 * for a built-in. Nothing is thrown for a bad definition: a failed agent is reported with its
 * issues so the whole set can be seen at once, and a project with one broken file still loads
 * the rest.
 */
export async function loadProjectAgents(
  options: LoadProjectAgentsOptions,
): Promise<AgentLoadResult> {
  const agentsDirectory = join(options.projectRoot, ".alp", "agents");
  const builtins = options.builtins ?? AGENT_DEFINITIONS;
  const coordinator = builtins.find((definition) => definition.id === CUSTOM_AGENT_PARENT);
  if (coordinator === undefined) {
    throw new Error(`no \`${CUSTOM_AGENT_PARENT}\` role to hold the capability ceiling`);
  }
  const ceiling: CapabilityCeiling = {
    coordinator,
    catalog: options.catalog ?? capabilityCatalog,
    builtinIds: new Set(builtins.map((definition) => definition.id)),
  };

  let entries;
  try {
    entries = await readdir(agentsDirectory, { withFileTypes: true });
  } catch {
    return { agentsDirectory, loaded: [], failed: [], overlays: [] };
  }

  const loaded: LoadedAgent[] = [];
  const failed: AgentLoadFailure[] = [];
  const overlays: string[] = [];

  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort()) {
    const sourcePath = join(agentsDirectory, entry.name, AGENT_FILE_NAME);
    let source: string;
    try {
      source = await readFile(sourcePath, "utf8");
    } catch {
      overlays.push(entry.name);
      continue;
    }

    const parsed = parseAgentFile(source);
    if (!parsed.ok) {
      failed.push({ id: entry.name, sourcePath, issues: parsed.issues });
      continue;
    }
    if (parsed.file.id !== entry.name) {
      failed.push({
        id: entry.name,
        sourcePath,
        issues: [`declares id \`${parsed.file.id}\` but lives in directory \`${entry.name}\``],
      });
      continue;
    }

    const issues = enforceCeiling(parsed.file, ceiling);
    if (issues.length > 0) {
      failed.push({ id: parsed.file.id, sourcePath, issues });
      continue;
    }

    try {
      loaded.push({ id: parsed.file.id, sourcePath, definition: toDefinition(parsed.file) });
    } catch (error) {
      failed.push({
        id: parsed.file.id,
        sourcePath,
        issues: [error instanceof Error ? error.message : String(error)],
      });
    }
  }

  return { agentsDirectory, loaded, failed, overlays };
}

/**
 * A registry holding the built-ins plus the candidates, with the coordinator delegating to
 * each candidate.
 *
 * "Candidate", not "member": nothing here is trusted, and this registry is **not** the one
 * `alp delegate` uses. It exists so `alp agent test` can answer the only question worth
 * asking about an untrusted definition — what would happen if it were trusted — and the
 * grant it models is exactly the one §11 decision 3 says trust confers.
 */
export function createCandidateRegistry(
  candidates: readonly LoadedAgent[],
  builtins: readonly AgentDefinition<unknown>[] = AGENT_DEFINITIONS,
): AgentRegistry {
  if (candidates.length === 0) return createAgentRegistry(builtins);
  const ids = candidates.map((candidate) => candidate.id);
  return createAgentRegistry([
    ...builtins.map((definition) => definition.id === CUSTOM_AGENT_PARENT
      ? defineAgent({ ...definition, delegatesTo: [...definition.delegatesTo, ...ids] })
      : definition),
    ...candidates.map((candidate) => candidate.definition),
  ]);
}

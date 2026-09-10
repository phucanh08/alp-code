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
import { scanAgentSkills, type SkillScan } from "./skills";
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
  /**
   * Built-in roles carrying project skills (§5.7.5), as the definition they would run with.
   *
   * A definition rather than a list of names, so an overlay goes through the same hash, the
   * same trust decision and the same registry as anything else: it changes the prompt of a
   * role that was already trusted, and "the same mechanism" is the whole point of §5.7.5.
   */
  readonly overlays: readonly LoadedAgent[];
}

export interface LoadProjectAgentsOptions {
  readonly projectRoot: string;
  readonly builtins?: readonly AgentDefinition<unknown>[];
  readonly catalog?: CapabilityCatalog;
  /**
   * `<assetRoot>/skills` — the shipped tree a project link may legitimately point into.
   * Defaults to the repo's own, which is what a dev clone and a native install both resolve to.
   */
  readonly builtinSkillsRoot?: string;
}

/**
 * A built-in, plus the project skills placed in `.alp/agents/<id>/skills/`.
 *
 * A same-named entry **replaces** the shipped grant rather than joining it: §5.7.1 makes
 * specific beat general, and the role's own root is searched first, so listing the name twice
 * would only describe the shadowed copy as if it were still reachable.
 */
function withOverlay(builtin: AgentDefinition<unknown>, skills: SkillScan): AgentDefinition<unknown> {
  const overlaid = skills.bindings.map((binding) => binding.name);
  return defineAgent({
    ...builtin,
    capabilities: {
      ...builtin.capabilities,
      skills: [...builtin.capabilities.skills.filter((skill) => !overlaid.includes(skill)), ...overlaid],
      skillBindings: skills.bindings,
      skillRoots: [skills.directory],
    },
  });
}

function toDefinition(file: AgentFile, skills: SkillScan): AgentDefinition<unknown> {
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
      // Two grants that cannot express each other: catalog names for the tree ALP ships and
      // replaces on update, directory entries for the tree the project owns. The binding
      // paths ride along so the hash a principal approves covers where each project name
      // resolved, not only that it existed.
      skills: [...(capabilities.skills ?? []), ...skills.bindings.map((binding) => binding.name)],
      ...(skills.bindings.length > 0
        ? { skillBindings: skills.bindings, skillRoots: [skills.directory] }
        : {}),
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
  const builtinSkillsRoot = options.builtinSkillsRoot
    ?? join(process.env.ALP_REPO_ROOT ?? process.cwd(), "skills");
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
  const overlays: LoadedAgent[] = [];

  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort()) {
    const agentDirectory = join(agentsDirectory, entry.name);
    const sourcePath = join(agentDirectory, AGENT_FILE_NAME);
    let source: string;
    try {
      source = await readFile(sourcePath, "utf8");
    } catch {
      // No `agent.yaml`: a directory named after a built-in is that role's skill overlay,
      // and one named after nothing at all is a directory the principal left here.
      const builtin = builtins.find((definition) => definition.id === entry.name);
      if (builtin === undefined) continue;
      const skills = await scanAgentSkills({ agentDirectory, projectRoot: options.projectRoot, builtinSkillsRoot });
      if (skills.bindings.length === 0 && skills.issues.length === 0) continue;
      const issues = [
        ...skills.issues,
        // An overlay adds skills; it cannot hand a role the tool to reach them, because that
        // would be an overlay editing capability — the one thing §5.7.5 says it may not do.
        ...(skills.bindings.length > 0 && !builtin.capabilities.tools.includes("Skill")
          ? [`\`${builtin.id}\` holds no \`Skill\` tool; an overlay cannot grant one`]
          : []),
      ];
      if (issues.length > 0) failed.push({ id: entry.name, sourcePath: skills.directory, issues });
      else overlays.push({ id: entry.name, sourcePath: skills.directory, definition: withOverlay(builtin, skills) });
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

    const skills = await scanAgentSkills({ agentDirectory, projectRoot: options.projectRoot, builtinSkillsRoot });
    const issues = [
      ...skills.issues,
      ...enforceCeiling({ file: parsed.file, skills: skills.bindings.map((binding) => binding.name) }, ceiling),
    ];
    if (issues.length > 0) {
      failed.push({ id: parsed.file.id, sourcePath, issues });
      continue;
    }

    try {
      loaded.push({ id: parsed.file.id, sourcePath, definition: toDefinition(parsed.file, skills) });
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
 * The built-ins plus these agents, with the coordinator delegating to each of them.
 *
 * Trust is a **list**, not a second config field (§11 decision 3): an agent the principal
 * approved is reachable because it is on the list, and asking them to name it again under
 * `delegatesTo` would be two sources of truth for one decision. The good consequence is that
 * the set of reachable agents lands in `main`'s own `policyHash`, so a change in who it may
 * delegate to is visible in the hash rather than only in a file.
 */
function registryWith(
  agents: readonly LoadedAgent[],
  builtins: readonly AgentDefinition<unknown>[],
  overlays: readonly LoadedAgent[] = [],
): AgentRegistry {
  const ids = agents.map((agent) => agent.id);
  const base = builtins.map((definition) =>
    overlays.find((overlay) => overlay.id === definition.id)?.definition ?? definition);
  if (ids.length === 0) return createAgentRegistry(base);
  return createAgentRegistry([
    ...base.map((definition) => definition.id === CUSTOM_AGENT_PARENT
      ? defineAgent({ ...definition, delegatesTo: [...definition.delegatesTo, ...ids] })
      : definition),
    ...agents.map((agent) => agent.definition),
  ]);
}

/**
 * The registry a real session runs against: built-ins plus the agents the principal trusted.
 */
export function createTrustedRegistry(
  trusted: readonly LoadedAgent[],
  builtins: readonly AgentDefinition<unknown>[] = AGENT_DEFINITIONS,
  overlays: readonly LoadedAgent[] = [],
): AgentRegistry {
  return registryWith(trusted, builtins, overlays);
}

/**
 * The same shape, for agents nobody has approved yet.
 *
 * "Candidate", not "member". It exists so `alp agent test` and `alp agent add` can answer the
 * only question worth asking about an untrusted definition — what would happen if it were
 * trusted — without that answer being the thing that makes it reachable.
 */
export function createCandidateRegistry(
  candidates: readonly LoadedAgent[],
  builtins: readonly AgentDefinition<unknown>[] = AGENT_DEFINITIONS,
  overlays: readonly LoadedAgent[] = [],
): AgentRegistry {
  return registryWith(candidates, builtins, overlays);
}

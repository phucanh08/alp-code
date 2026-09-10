import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { CapabilityCatalog } from "../agents/capability-catalog";
import { memoryGrantCovers } from "../agents/memory-grant";
import { MODEL_CONTEXT_WINDOWS, MODEL_RUNTIMES } from "../agents/model-context";
import type { AgentDefinition, AgentRegistry, MemoryScopeGrant } from "../agents/types";
import { RUNTIME_IDS, TOOL_CATALOG } from "../agents/types";
import type { AgentTestCheck } from "./types";

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const AUTO_COMPACT_MIN_TOKENS = 100_000;
const AUTO_COMPACT_MAX_TOKENS = 1_000_000;

export interface Tier1Input {
  readonly definition: AgentDefinition<unknown>;
  readonly registry: AgentRegistry;
  readonly catalog: CapabilityCatalog;
  /** Where `Skill(<name>)` actually resolves — `<assetRoot>/skills` for a real install. */
  readonly skillsRoot: string;
}

function pathIsWithin(root: string, target: string): boolean {
  const relation = relative(resolve(root), resolve(target));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function missing<T>(values: readonly T[], known: ReadonlySet<T>): readonly T[] {
  return values.filter((value) => !known.has(value));
}

/**
 * Tier 1 — everything answerable from the definition and the files it names, with no
 * process spawned and no model called.
 *
 * Deliberately re-checks invariants `createAgentRegistry` already enforces at load. Today
 * that looks redundant, because every definition reaching here came through the registry.
 * It stops looking redundant the day §5 lands: a `.alp/agents/<id>/agent.yaml` is checked
 * *before* it is offered for trust, and "the registry would have refused it" is not an
 * answer a principal can read. The two agree on purpose — one refuses, the other explains.
 */
export function runTier1(input: Tier1Input): readonly AgentTestCheck[] {
  const { definition, registry, catalog, skillsRoot } = input;
  const checks: AgentTestCheck[] = [];
  const add = (id: string, ok: boolean, detail: string): void => {
    checks.push({ tier: 1, id, status: ok ? "pass" : "fail", detail });
  };

  add(
    "identity",
    KEBAB_CASE.test(definition.id) && definition.displayName.trim().length > 0,
    KEBAB_CASE.test(definition.id)
      ? `\`${definition.id}\` is kebab-case, displayed as \`${definition.displayName}\``
      : `id \`${definition.id}\` is not kebab-case`,
  );

  const unroutable = RUNTIME_IDS.filter((runtime) => MODEL_RUNTIMES[definition.model[runtime]] === undefined);
  add(
    "model-runtime",
    unroutable.length === 0,
    unroutable.length === 0
      ? RUNTIME_IDS.map((runtime) => `${runtime}=${definition.model[runtime]}`).join(", ")
      : `no runtime in MODEL_RUNTIMES for ${unroutable.map((runtime) => `\`${definition.model[runtime]}\``).join(", ")}`,
  );

  const autoCompactIssues: string[] = [];
  const autoCompactNotes: string[] = [];
  for (const runtime of RUNTIME_IDS) {
    const model = definition.model[runtime];
    const window = MODEL_CONTEXT_WINDOWS[model];
    const declared = definition.autoCompactTokens?.[runtime];
    if (declared === undefined) {
      autoCompactNotes.push(window === undefined
        ? `${runtime}: undeclared, and \`${model}\` has no published window — the runtime decides`
        : `${runtime}: undeclared → 90% of ${window.toLocaleString("en-US")}`);
      continue;
    }
    if (!Number.isInteger(declared) || declared < AUTO_COMPACT_MIN_TOKENS || declared > AUTO_COMPACT_MAX_TOKENS) {
      autoCompactIssues.push(`${runtime}: ${declared} outside ${AUTO_COMPACT_MIN_TOKENS}–${AUTO_COMPACT_MAX_TOKENS}`);
      continue;
    }
    if (window !== undefined && declared > window) {
      autoCompactIssues.push(`${runtime}: ${declared} above the window of \`${model}\` (${window})`);
      continue;
    }
    autoCompactNotes.push(`${runtime}: ${declared.toLocaleString("en-US")}`);
  }
  add("auto-compact", autoCompactIssues.length === 0, autoCompactIssues.join("; ") || autoCompactNotes.join("; "));

  const unknownTools = missing(definition.capabilities.tools, new Set(TOOL_CATALOG));
  const duplicateTools = definition.capabilities.tools.length !== new Set(definition.capabilities.tools).size;
  add(
    "tool-grant",
    unknownTools.length === 0 && !duplicateTools,
    unknownTools.length > 0
      ? `outside TOOL_CATALOG: ${unknownTools.join(", ")}`
      : duplicateTools
        ? "a tool is named twice"
        : definition.capabilities.tools.join(", ") || "none",
  );

  const { skills, subagents, mcpServers, tools } = definition.capabilities;
  const unknownSkills = missing(skills, new Set(catalog.skills));
  const holdsSkillTool = tools.includes("Skill");
  const skillCoherent = holdsSkillTool === skills.length > 0;
  add(
    "skill-grant",
    unknownSkills.length === 0 && skillCoherent,
    unknownSkills.length > 0
      ? `not in SKILL_CATALOG: ${unknownSkills.join(", ")}`
      : !skillCoherent
        ? holdsSkillTool
          ? "holds the `Skill` tool but names no skill — a grant on every skill root the machine has"
          : "names skills but has no `Skill` tool to invoke them"
        : skills.join(", ") || "none",
  );

  const skillAssetIssues: string[] = [];
  for (const skill of skills) {
    const directory = join(skillsRoot, skill);
    try {
      const real = realpathSync(directory);
      // A skill root is a read grant (§4.4). A symlink that leaves it hands the role a path
      // nobody authorized, and the role would never know it had left.
      if (!pathIsWithin(realpathSync(skillsRoot), real)) {
        skillAssetIssues.push(`\`${skill}\` resolves to \`${real}\`, outside the skill root`);
        continue;
      }
      if (!statSync(join(real, "SKILL.md")).isFile()) {
        skillAssetIssues.push(`\`${skill}\` has no SKILL.md`);
      }
    } catch {
      skillAssetIssues.push(`\`${skill}\` is not present under \`${skillsRoot}\``);
    }
  }
  add(
    "skill-assets",
    skillAssetIssues.length === 0,
    skillAssetIssues.join("; ") || (skills.length === 0 ? "no skill named" : `${skills.length} skill directory resolved under \`${skillsRoot}\``),
  );

  const unknownSubagents = subagents.filter((name) => !Object.hasOwn(catalog.subagents, name));
  const widenedBySubagent = subagents.flatMap((name) =>
    (catalog.subagents[name]?.tools ?? []).filter((tool) => !tools.includes(tool)).map((tool) => `${name}:${tool}`));
  add(
    "subagent-grant",
    unknownSubagents.length === 0 && widenedBySubagent.length === 0,
    unknownSubagents.length > 0
      ? `not in SUBAGENT_CATALOG: ${unknownSubagents.join(", ")}`
      : widenedBySubagent.length > 0
        ? `subagent would hold a tool the role does not: ${widenedBySubagent.join(", ")}`
        : subagents.join(", ") || "none",
  );

  const unknownServers = mcpServers.filter((name) => !Object.hasOwn(catalog.mcpServers, name));
  add(
    "mcp-grant",
    unknownServers.length === 0,
    unknownServers.length > 0
      ? `not in MCP_SERVER_CATALOG: ${unknownServers.join(", ")}`
      : mcpServers.map((name) => `${name} (${catalog.mcpServers[name]?.egress ?? "?"} egress)`).join(", ") || "none",
  );

  const foreignPrivate = [...definition.capabilities.memory.read, ...definition.capabilities.memory.write]
    .filter((grant: MemoryScopeGrant) => grant.startsWith("private:") && grant.slice("private:".length) !== definition.id);
  const unreadableWrites = definition.capabilities.memory.write
    .filter((write) => !definition.capabilities.memory.read.some((read) => memoryGrantCovers(read, write)));
  add(
    "memory-grant",
    foreignPrivate.length === 0 && unreadableWrites.length === 0,
    foreignPrivate.length > 0
      ? `private memory of another role: ${foreignPrivate.join(", ")}`
      : unreadableWrites.length > 0
        ? `write grant that is not readable: ${unreadableWrites.join(", ")}`
        : `read ${definition.capabilities.memory.read.join(", ") || "none"} · write ${definition.capabilities.memory.write.join(", ") || "none"}`,
  );

  const { readRoots, writeRoots } = definition.capabilities.workspace;
  const unreadableWriteRoots = writeRoots.filter((write) => !readRoots.some((read) => pathIsWithin(read, write)));
  add(
    "workspace-grant",
    unreadableWriteRoots.length === 0,
    unreadableWriteRoots.length > 0
      ? `write root that is not readable: ${unreadableWriteRoots.join(", ")}`
      : `read ${readRoots.join(", ") || "none (memory-only)"} · write ${writeRoots.join(", ") || "none"}`,
  );

  const { workflow } = definition;
  const stateIds = Object.keys(workflow.states);
  const workflowIssues: string[] = [];
  if (!Object.hasOwn(workflow.states, workflow.initial)) {
    workflowIssues.push(`initial state \`${workflow.initial}\` is not declared`);
  } else {
    const reached = new Set<string>([workflow.initial]);
    const queue = [workflow.initial];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      for (const next of workflow.states[current]?.transitions ?? []) {
        if (!Object.hasOwn(workflow.states, next)) {
          workflowIssues.push(`\`${current}\` transitions to unknown state \`${next}\``);
          continue;
        }
        if (!reached.has(next)) { reached.add(next); queue.push(next); }
      }
    }
    const unreachable = stateIds.filter((id) => !reached.has(id));
    if (unreachable.length > 0) workflowIssues.push(`unreachable: ${unreachable.join(", ")}`);
    if (!stateIds.some((id) => workflow.states[id]?.terminal)) {
      workflowIssues.push("no terminal state — the workflow cannot complete");
    }
  }
  for (const id of stateIds) {
    const ungranted = missing(workflow.states[id]?.allowedTools ?? [], new Set(tools));
    if (ungranted.length > 0) workflowIssues.push(`\`${id}\` allows ungranted ${ungranted.join(", ")}`);
  }
  add(
    "workflow",
    workflowIssues.length === 0,
    workflowIssues.join("; ") || `${workflow.id}: ${stateIds.join(" → ")}`,
  );

  const relationIssues: string[] = [];
  if (definition.reportsTo !== "principal" && !registry.has(definition.reportsTo)) {
    relationIssues.push(`unknown reportsTo \`${definition.reportsTo}\``);
  }
  for (const target of definition.delegatesTo) {
    if (target === definition.id) relationIssues.push("delegates to itself");
    else if (!registry.has(target)) relationIssues.push(`unknown delegation target \`${target}\``);
  }
  add(
    "relations",
    relationIssues.length === 0,
    relationIssues.join("; ") || `reports to ${definition.reportsTo} · delegates to ${definition.delegatesTo.join(", ") || "nobody"}`,
  );

  const instructions = definition.instructions();
  add(
    "instructions",
    instructions.trim().length > 0,
    instructions.trim().length > 0
      ? `${instructions.length} chars, ${instructions.split("\n").length} lines`
      : "renders empty — the role would boot with no identity",
  );

  const empty = definition.output.validate("");
  const filled = definition.output.validate("a result the caller can read");
  add(
    "output-contract",
    definition.output.name.trim().length > 0 && !empty.ok && filled.ok,
    definition.output.name.trim().length === 0
      ? "output contract has no name"
      : !empty.ok && filled.ok
        ? `\`${definition.output.name}\` accepts prose and rejects empty output`
        : `\`${definition.output.name}\` does not discriminate: empty ${empty.ok ? "accepted" : "rejected"}, prose ${filled.ok ? "accepted" : "rejected"}`,
  );

  return checks;
}

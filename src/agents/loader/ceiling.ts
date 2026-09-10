import { isAbsolute, normalize } from "node:path";
import type { CapabilityCatalog } from "../capability-catalog";
import { MODEL_RUNTIMES } from "../model-context";
import type { AgentDefinition, AgentId } from "../types";
import { MAX_RULES, MAX_RULE_LENGTH, type AgentFile } from "./schema";

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MEMORY_SCOPE = /^(?:shared|shared:.+|project:.+|private:.+)$/;

export interface CapabilityCeiling {
  /** The role a custom agent reports to; its tools are the upper bound on theirs. */
  readonly coordinator: AgentDefinition<unknown>;
  readonly catalog: CapabilityCatalog;
  readonly builtinIds: ReadonlySet<AgentId>;
}

export interface CeilingInput {
  readonly file: AgentFile;
  /** Names resolved from the agent's own `skills/` directory (§5.7). */
  readonly skills: readonly string[];
}

/**
 * §5.5 — the ceiling a custom agent is held to, enforced before `createAgentRegistry`.
 *
 * Every entry here is narrower than what a built-in may declare, and deliberately so: a
 * built-in is code that shipped with the binary and was reviewed as code, while this is a
 * file that arrived in a repo. Where the two could reasonably be treated alike, this picks
 * the narrower reading — widening later is cheaper than taking a grant back.
 *
 * Returns every issue rather than the first: a principal fixing an agent file should see the
 * whole list, not discover the next one on each retry.
 */
export function enforceCeiling(input: CeilingInput, ceiling: CapabilityCeiling): readonly string[] {
  const { file, skills } = input;
  const issues: string[] = [];
  const { coordinator, catalog, builtinIds } = ceiling;

  if (!KEBAB_CASE.test(file.id)) issues.push(`id \`${file.id}\` must be kebab-case`);
  if (builtinIds.has(file.id)) {
    issues.push(`id \`${file.id}\` belongs to a built-in role; an \`agent.yaml\` may not take it over`);
  }

  for (const runtime of ["claude", "codex"] as const) {
    const model = file.model[runtime];
    if (MODEL_RUNTIMES[model] === undefined) {
      issues.push(`model \`${model}\` is not in MODEL_RUNTIMES, so no runtime would launch it`);
    }
  }

  const rules = file.instructions.rules ?? [];
  if (rules.length > MAX_RULES) issues.push(`${rules.length} rules, over the ${MAX_RULES} allowed`);
  for (const rule of rules) {
    if (rule.length > MAX_RULE_LENGTH) {
      issues.push(`a rule is ${rule.length} chars, over the ${MAX_RULE_LENGTH} allowed`);
    }
  }

  const tools = file.capabilities.tools;
  for (const tool of tools) {
    if (!coordinator.capabilities.tools.includes(tool)) {
      issues.push(`tool \`${tool}\` is not held by \`${coordinator.id}\`, so it cannot be delegated onward`);
    }
  }
  if (new Set(tools).size !== tools.length) issues.push("a tool is named twice");

  const named = file.capabilities.skills ?? [];
  const known = new Set(catalog.skills);
  for (const skill of named) {
    if (!known.has(skill)) {
      issues.push(`skill \`${skill}\` is not in the skill catalog; a project skill belongs in \`skills/\`, not here`);
    }
  }
  // The one thing that would put the two grants back in each other's way.
  for (const skill of named) {
    if (skills.includes(skill)) {
      issues.push(`skill \`${skill}\` is granted twice: named here and present in \`skills/\``);
    }
  }

  const holdsSkillTool = tools.includes("Skill");
  const granted = [...named, ...skills];
  if (holdsSkillTool && granted.length === 0) {
    issues.push("holds the `Skill` tool but grants no skill — that is a grant on every skill root the machine has");
  }
  if (!holdsSkillTool && granted.length > 0) {
    issues.push(`grants ${granted.length} skill(s) but has no \`Skill\` tool to invoke them`);
  }

  // Both catalogs ship empty (§5.5), so every name is refused today. Written as a catalog
  // check rather than a flat ban so opening one is a catalog entry, not a code change here.
  for (const subagent of file.capabilities.subagents ?? []) {
    if (!Object.hasOwn(catalog.subagents, subagent)) {
      issues.push(`subagent \`${subagent}\` is not in the subagent catalog`);
    }
  }
  for (const server of file.capabilities.mcpServers ?? []) {
    if (!Object.hasOwn(catalog.mcpServers, server)) {
      issues.push(`MCP server \`${server}\` is not trusted on this machine`);
    }
  }

  const memory = file.capabilities.memory ?? {};
  for (const scope of memory.read ?? []) {
    if (!MEMORY_SCOPE.test(scope)) { issues.push(`memory read scope \`${scope}\` is malformed`); continue; }
    if (scope.startsWith("private:") && scope !== `private:${file.id}`) {
      issues.push(`memory read scope \`${scope}\` is another role's private memory`);
    }
  }
  for (const scope of memory.write ?? []) {
    if (scope !== `private:${file.id}`) {
      issues.push(`memory write scope \`${scope}\` is outside \`private:${file.id}\`, the only writable scope for a custom agent`);
    }
  }

  const workspace = file.capabilities.workspace ?? {};
  for (const root of workspace.readRoots ?? []) {
    // Relative and inside the workspace: an absolute root is a grant on this machine rather
    // than on the project, and `..` is the same grant spelled differently. `"."` — the root
    // every code-native role declares — resolves against the execution's own workspace.
    if (isAbsolute(root) || normalize(root).startsWith("..")) {
      issues.push(`workspace read root \`${root}\` must stay inside the project`);
    }
  }
  if ((workspace.writeRoots ?? []).length > 0) {
    issues.push("workspace write is not available to a custom agent until approval exists (§6)");
  }

  const stateIds = file.workflow.map((state) => state.id);
  if (new Set(stateIds).size !== stateIds.length) issues.push("a workflow state id is used twice");
  for (const state of file.workflow) {
    for (const tool of state.allowedTools) {
      if (!tools.includes(tool)) {
        issues.push(`workflow state \`${state.id}\` allows \`${tool}\`, which this agent does not hold`);
      }
    }
  }

  return issues;
}

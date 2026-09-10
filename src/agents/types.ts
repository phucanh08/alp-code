export type AgentId = string;
export const TOOL_CATALOG = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "WebSearch",
  "WebFetch",
  "Skill",
] as const;
export type ToolId = (typeof TOOL_CATALOG)[number];
export const RUNTIME_IDS = ["claude", "codex"] as const;
export type RuntimeId = (typeof RUNTIME_IDS)[number];
export type RuntimeModelMap = Readonly<Record<RuntimeId, string>>;
/**
 * A token budget per runtime, keyed like `model` — because that is what it is a budget of.
 * Partial: a side left out takes 90% of its own model's context window.
 */
export type RuntimeTokenBudgetMap = Readonly<Partial<Record<RuntimeId, number>>>;
export const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export type RuntimeReasoningMap = Readonly<Record<RuntimeId, ReasoningEffort>>;

export type MemoryScopeGrant =
  | "shared"
  | `shared:${string}`
  | `project:${string}`
  | `private:${AgentId}`;

export interface MemoryGrants {
  readonly read: readonly MemoryScopeGrant[];
  readonly write: readonly MemoryScopeGrant[];
}

export interface WorkspaceGrants {
  readonly readRoots: readonly string[];
  readonly writeRoots: readonly string[];
}

/**
 * Where one granted skill actually lives.
 *
 * Pinned on the definition, so `definitionHash` covers the resolved path and not only the
 * name: §5.7.5 draws the trust boundary at "skill names and resolved realpaths", and a
 * symlink repointed under a name that did not change is exactly the edit a name-only hash
 * would miss.
 */
export interface SkillBinding {
  readonly name: SkillName;
  readonly kind: "directory" | "symlink" | "skillref";
  readonly path: string;
}

export interface AgentCapabilities {
  readonly tools: readonly ToolId[];
  /**
   * Skills this role may invoke, by name (§5.3). Non-empty exactly when `tools` carries
   * `Skill`: the tool without a name is a grant on every skill root the machine happens to
   * have, and a name without the tool is a grant nothing can reach.
   */
  readonly skills: readonly SkillName[];
  /**
   * Project-scoped skill grants, resolved. Absent for a built-in, whose skills are catalog
   * names resolved from the shipped `skills/` tree.
   */
  readonly skillBindings?: readonly SkillBinding[];
  /**
   * Directories this role resolves `Skill(<name>)` from before the machine-wide roots — one
   * per project-scoped grant set, so a name here shadows a built-in of the same name for
   * this role only (§5.7.1).
   */
  readonly skillRoots?: readonly string[];
  /**
   * In-process subagents, by name. A subagent is a grant like any other — not a seat on the
   * team, and never a way around this role's own limits (§0, §4.6). Empty for every built-in.
   */
  readonly subagents: readonly SubagentName[];
  /** MCP servers, by name, from the set the principal has trusted. Egress travels with each. */
  readonly mcpServers: readonly McpServerName[];
  readonly memory: MemoryGrants;
  readonly workspace: WorkspaceGrants;
}

export type OutputValidation<TOutput> =
  | { readonly ok: true; readonly value?: TOutput }
  | { readonly ok: false; readonly issues: readonly string[] };

export interface OutputContract<TOutput> {
  readonly name: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly validate: (value: unknown) => OutputValidation<TOutput>;
}

/**
 * Identity as data, not as a closure.
 *
 * `hashAgentDefinition` canonicalizes a function by its source text, so identity used to
 * reach the hash only because each built-in spelled its own literal. A loader building
 * definitions from `.alp/agents/<id>/agent.yaml` (§5.3) would hand every custom agent the
 * *same* closure over different data — and every one of them would hash identically, which
 * means a hash trusted for one prompt would validate any other. Storing the three fields
 * makes `definitionHash` cover what the model is actually told.
 */
export interface InstructionSpec {
  /** Who the role is: `"Search, the local code retrieval specialist"`. */
  readonly role: string;
  /** What one execution of it is for. */
  readonly purpose: string;
  readonly rules: readonly string[];
  /**
   * `principal` (the default) adds the address-and-language line and the report-first rule;
   * `machine` adds neither, for a role whose output is read by another program.
   */
  readonly audience?: "principal" | "machine";
}

export interface AgentDefinition<TOutput> {
  readonly id: AgentId;
  readonly displayName: string;
  readonly model: RuntimeModelMap;
  readonly reasoningEffort: RuntimeReasoningMap;
  readonly reportsTo: AgentId | "principal";
  readonly delegatesTo: readonly AgentId[];
  readonly capabilities: AgentCapabilities;
  /**
   * Token count at which each runtime may compact its own transcript. A side left out takes
   * 90% of that model's context window (`defaultAutoCompactTokens`) — ALP's default rather
   * than the runtime's own, so a role remembers the same share wherever it runs.
   *
   * Declared on the role because it is the role that knows how much of its own history is
   * load-bearing: the seat holding the whole picture keeps everything the model can hold,
   * while a one-shot specialist that grows this far has gone wrong and is better off
   * compacted than ballooning.
   *
   * Declared **per runtime** because the budget belongs to the model, not to the role alone:
   * the same 500 000 is an early compaction on a 1M window and a line that never fires on a
   * 272k one, where the runtime silently falls back to its own hard limit instead. Each side
   * is checked against its own model's window at registry load, so that fallback cannot
   * happen quietly. Range is Claude's documented 100k–1M (`autoCompactWindow`); Codex
   * publishes no bounds for `model_auto_compact_token_limit` and shares it.
   */
  readonly autoCompactTokens?: RuntimeTokenBudgetMap;
  /** Static identity — no per-execution context. Rendered by `renderInstructions`. */
  readonly instructions: InstructionSpec;
  readonly workflow: WorkflowDefinition;
  readonly output: OutputContract<TOutput>;
}

export interface AgentRegistry {
  get(id: AgentId): AgentDefinition<unknown>;
  has(id: AgentId): boolean;
  list(): readonly AgentDefinition<unknown>[];
}
import type { McpServerName, SkillName, SubagentName } from "./capability-catalog";
import type { WorkflowDefinition } from "../workflow/types";

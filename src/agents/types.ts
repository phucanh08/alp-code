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
export type RuntimeId = "claude" | "codex";
export type RuntimeModelMap = Readonly<Record<RuntimeId, string>>;
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
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

export interface AgentCapabilities {
  readonly tools: readonly ToolId[];
  /**
   * Skills this role may invoke, by name (§5.3). Non-empty exactly when `tools` carries
   * `Skill`: the tool without a name is a grant on every skill root the machine happens to
   * have, and a name without the tool is a grant nothing can reach.
   */
  readonly skills: readonly SkillName[];
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

export interface AgentDefinition<TOutput> {
  readonly id: AgentId;
  readonly displayName: string;
  readonly model: RuntimeModelMap;
  readonly reasoningEffort: RuntimeReasoningMap;
  readonly reportsTo: AgentId | "principal";
  readonly delegatesTo: readonly AgentId[];
  readonly capabilities: AgentCapabilities;
  /**
   * Token count at which the runtime may compact its own transcript, or `undefined` to
   * leave that to the window the runtime tunes per model.
   *
   * Declared on the role because it is the role that knows how much of its own history is
   * load-bearing: the seat holding the whole picture keeps everything the model can hold,
   * while a one-shot specialist that grows this far has gone wrong and is better off
   * compacted than ballooning. Range is Claude's documented 100k–1M (`autoCompactWindow`);
   * Codex publishes no bounds for `model_auto_compact_token_limit`, and sharing the range
   * is what keeps one declared number meaningful on both runtimes.
   */
  readonly autoCompactTokens?: number;
  /** Static identity text — no per-execution context. See `renderInstructions`. */
  readonly instructions: () => string;
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

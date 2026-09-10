import { z } from "zod";
import { CODE_CRAFT_RULES, CODE_NATIVE_HOUSE_RULES } from "../shared/house-rules";
import { TOOL_CATALOG } from "../types";

/** The one version this build reads. §4.12 commits to bumping it rarely. */
export const AGENT_FILE_SCHEMA_VERSION = 1;

/**
 * House rules are chosen from a built set, never written out (§5.3).
 *
 * They are where the system's own invariants live: a definition free to write its own would
 * be free to leave out "never launch raw Herdr or Paseo" and still look like every other
 * agent file. A principal's own rules go in `rules`, which is budgeted and printed.
 */
export const HOUSE_RULE_SETS = Object.freeze({
  "none": Object.freeze([] as readonly string[]),
  "code-native": CODE_NATIVE_HOUSE_RULES,
  "code-native+craft": Object.freeze([...CODE_NATIVE_HOUSE_RULES, ...CODE_CRAFT_RULES]),
});

export type HouseRuleSet = keyof typeof HOUSE_RULE_SETS;

/** §5.3 — a definition may not quietly eat a share of the context window. */
export const MAX_RULES = 20;
export const MAX_RULE_LENGTH = 240;

const toolName = z.enum(TOOL_CATALOG);
const effort = z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]);
const name = z.string().min(1).max(200);

/**
 * Every object is strict: an unrecognised key is refused, not dropped.
 *
 * A silently ignored `capabilties:` typo would leave the role with no tools and no message
 * saying so, and a silently ignored key the schema does not know yet is a field from a
 * future version being read by a build that cannot honour it. Both are the quiet failure
 * this file exists to prevent.
 */
export const agentFileSchema = z.strictObject({
  schemaVersion: z.literal(AGENT_FILE_SCHEMA_VERSION),
  id: z.string().min(1).max(64),
  displayName: z.string().min(1).max(64),
  model: z.strictObject({ claude: name, codex: name }),
  reasoningEffort: z.strictObject({ claude: effort, codex: effort }),
  autoCompactTokens: z.strictObject({
    claude: z.number().int().optional(),
    codex: z.number().int().optional(),
  }).optional(),
  instructions: z.strictObject({
    role: z.string().min(1).max(MAX_RULE_LENGTH),
    purpose: z.string().min(1).max(1000),
    houseRules: z.enum(["none", "code-native", "code-native+craft"]).optional(),
    rules: z.array(z.string().min(1).max(MAX_RULE_LENGTH)).max(MAX_RULES).optional(),
  }),
  capabilities: z.strictObject({
    tools: z.array(toolName),
    /**
     * Shipped skills, by catalog name. **Project** skills are not declared here — the agent's
     * own `skills/` directory is that grant list (§5.7), and the two never name the same thing.
     *
     * §5.7 asks for no `skills:` field at all, on the good ground that two places to grant one
     * thing will disagree. It does not survive contact with where the shipped skills live: a
     * native install keeps them under `~/.alp-code/versions/<tag>/skills`, so the relative
     * link §5.7 would use to reach `git` names a directory that `alp update` replaces. A
     * checked-in file cannot point at a path that moves. So the two grants are split by what
     * they can express — a name for the tree ALP owns, a directory entry for the tree the
     * project owns — and neither can say what the other says.
     */
    skills: z.array(name).optional(),
    subagents: z.array(name).optional(),
    mcpServers: z.array(name).optional(),
    memory: z.strictObject({
      read: z.array(name).optional(),
      write: z.array(name).optional(),
    }).optional(),
    workspace: z.strictObject({
      readRoots: z.array(z.string().min(1)).optional(),
      writeRoots: z.array(z.string().min(1)).optional(),
    }).optional(),
  }),
  workflow: z.array(z.strictObject({
    id: z.string().min(1).max(64),
    allowedTools: z.array(toolName),
  })).min(1).max(12),
  // §5.4: `text` is the only contract at v1, and it stays the only one until a consumer
  // reads a named field out of an agent's output.
  output: z.strictObject({ kind: z.literal("text") }),
});

export type AgentFile = z.infer<typeof agentFileSchema>;

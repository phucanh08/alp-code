import { z } from "zod";
import { defineAgent } from "./agent-definition";
import { CODE_NATIVE_HOUSE_RULES } from "./shared/house-rules";
import { renderInstructions } from "./shared/voice";
import { defineOutputContract } from "../workflow/output-validator";
import { defineLinearWorkflow } from "../workflow/types";

export const compactionAgent = defineAgent({
  id: "compaction",
  displayName: "Compaction 🗜️",
  model: { claude: "claude-opus-5", codex: "gpt-5.6-sol" },
  reasoningEffort: { claude: "medium", codex: "medium" },
  reportsTo: "main",
  delegatesTo: [],
  capabilities: {
    tools: ["Read", "Glob", "Grep"],
    memory: {
      read: ["shared", "project:*", "private:compaction"],
      write: ["private:compaction"],
    },
    workspace: { readRoots: [], writeRoots: [] },
  },
  instructions: (context) => renderInstructions(
    "Compaction, the continuation-context specialist",
    "Produce a continuation-ready handoff preserving objectives, constraints, decisions, state, open items, next actions, and exact anchors.",
    [...CODE_NATIVE_HOUSE_RULES, "Do not continue the underlying task, research missing facts, or communicate directly with the principal."],
    context,
  ),
  workflow: defineLinearWorkflow("compact-context", [
    { id: "EXTRACT", allowedTools: ["Read", "Glob", "Grep"] },
    { id: "SEPARATE_FACTS", allowedTools: ["Read", "Glob", "Grep"] },
    { id: "PRESERVE_ANCHORS", allowedTools: ["Read", "Glob", "Grep"] },
    { id: "HANDOFF", allowedTools: [] },
  ]),
  output: defineOutputContract(
    "context-handoff",
    z.object({
      status: z.enum(["ready", "blocked"]),
      objective: z.string().min(1),
      constraints: z.array(z.string().min(1)),
      decisions: z.array(z.string().min(1)),
      currentState: z.string().min(1),
      openItems: z.array(z.string().min(1)),
      nextActions: z.array(z.string().min(1)),
      anchors: z.array(z.string().min(1)),
    }).strict(),
  ),
});

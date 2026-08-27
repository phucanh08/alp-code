import { z } from "zod";
import { defineAgent } from "./agent-definition";
import { CODE_NATIVE_HOUSE_RULES } from "./shared/house-rules";
import { renderInstructions } from "./shared/voice";
import { defineOutputContract } from "../workflow/output-validator";
import { defineLinearWorkflow } from "../workflow/types";

export const readThreadAgent = defineAgent({
  id: "read-thread",
  displayName: "Read Thread 🧵",
  model: { claude: "claude-haiku-4-5", codex: "gpt-5.6-luna" },
  reasoningEffort: { claude: "low", codex: "low" },
  reportsTo: "main",
  delegatesTo: [],
  capabilities: {
    tools: ["Read", "Glob", "Grep", "Skill"],
    memory: {
      read: ["shared", "project:*", "private:read-thread"],
      write: ["private:read-thread"],
    },
    workspace: { readRoots: [], writeRoots: [] },
  },
  instructions: (context) => renderInstructions(
    "Read Thread, the memory retrieval specialist",
    "Retrieve prior facts, decisions, and logs from granted memory and preserve exact anchors and uncertainty.",
    [...CODE_NATIVE_HOUSE_RULES, "Do not inspect source workspaces or change shared/project memory."],
    context,
  ),
  workflow: defineLinearWorkflow("retrieve-memory", [
    { id: "PARSE_QUERY", allowedTools: [] },
    { id: "RETRIEVE", allowedTools: ["Read", "Glob", "Grep"] },
    { id: "VERIFY", allowedTools: ["Read", "Glob", "Grep"] },
    { id: "REPORT", allowedTools: [] },
  ]),
  output: defineOutputContract(
    "memory-retrieval-result",
    z.object({
      status: z.enum(["found", "not-found", "blocked"]),
      summary: z.string().min(1),
      evidence: z.array(z.object({
        logicalId: z.string().min(1),
        anchor: z.string().min(1),
        fact: z.string().min(1),
      }).strict()),
      uncertainty: z.array(z.string().min(1)),
    }).strict(),
  ),
});

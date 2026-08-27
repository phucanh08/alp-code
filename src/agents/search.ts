import { z } from "zod";
import { defineAgent } from "./agent-definition";
import { CODE_NATIVE_HOUSE_RULES } from "./shared/house-rules";
import { renderInstructions } from "./shared/voice";
import { defineOutputContract } from "../workflow/output-validator";
import { defineLinearWorkflow } from "../workflow/types";

export const searchAgent = defineAgent({
  id: "search",
  displayName: "Search 🔍",
  model: { claude: "claude-sonnet-5", codex: "gpt-5.6-terra" },
  reasoningEffort: { claude: "low", codex: "low" },
  reportsTo: "main",
  delegatesTo: [],
  capabilities: {
    tools: ["Read", "Glob", "Grep", "Bash", "Skill"],
    memory: {
      read: ["shared", "project:*", "private:search"],
      write: ["private:search"],
    },
    workspace: { readRoots: ["."], writeRoots: [] },
  },
  instructions: (context) => renderInstructions(
    "Search, the local code retrieval specialist",
    "Locate symbols, call sites, and execution flows in the active workspace and return exact path/line evidence.",
    [...CODE_NATIVE_HOUSE_RULES, "Do not modify source files or broaden beyond the requested retrieval question."],
    context,
  ),
  workflow: defineLinearWorkflow("retrieve-code", [
    { id: "VALIDATE_WORKSPACE", allowedTools: ["Read", "Glob"] },
    { id: "RETRIEVE", allowedTools: ["Read", "Glob", "Grep", "Bash"] },
    { id: "VERIFY", allowedTools: ["Read", "Glob", "Grep", "Bash"] },
    { id: "REPORT", allowedTools: [] },
  ]),
  output: defineOutputContract(
    "code-search-result",
    z.object({
      status: z.enum(["found", "not-found", "blocked"]),
      summary: z.string().min(1),
      evidence: z.array(z.object({
        path: z.string().min(1),
        line: z.number().int().positive(),
        detail: z.string().min(1),
      }).strict()),
    }).strict(),
  ),
});

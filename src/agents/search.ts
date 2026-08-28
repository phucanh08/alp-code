import { defineAgent } from "./agent-definition";
import { CODE_NATIVE_HOUSE_RULES } from "./shared/house-rules";
import { renderInstructions, textOutput } from "./shared/voice";
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
  instructions: () => renderInstructions(
    "Search, the local code retrieval specialist",
    "Locate symbols, call sites, and execution flows in the active workspace and return exact path/line evidence.",
    [...CODE_NATIVE_HOUSE_RULES, "Do not modify source files or broaden beyond the requested retrieval question."],
  ),
  workflow: defineLinearWorkflow("retrieve-code", [
    { id: "VALIDATE_WORKSPACE", allowedTools: ["Read", "Glob"] },
    { id: "RETRIEVE", allowedTools: ["Read", "Glob", "Grep", "Bash"] },
    { id: "VERIFY", allowedTools: ["Read", "Glob", "Grep", "Bash"] },
    { id: "REPORT", allowedTools: [] },
  ]),
  output: textOutput("code-search-result"),
});

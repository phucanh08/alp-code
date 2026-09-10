import { defineAgent } from "./agent-definition";
import { CODE_NATIVE_HOUSE_RULES } from "./shared/house-rules";
import { textOutput } from "./shared/voice";
import { defineLinearWorkflow } from "../workflow/types";

export const searchAgent = defineAgent({
  id: "search",
  displayName: "Search 🔍",
  model: { claude: "claude-sonnet-5", codex: "gpt-5.6-terra" },
  reasoningEffort: { claude: "low", codex: "low" },
  reportsTo: "main",
  delegatesTo: [],
  // Một cuộc tìm phình tới đây là đã hỏng; nén là cách hỏng rẻ hơn. Bằng nhau hai phía:
  // trần này nói về việc tìm kiếm, không về model.
  autoCompactTokens: { claude: 150_000, codex: 150_000 },
  capabilities: {
    tools: ["Read", "Glob", "Grep", "Bash", "Skill"],
    skills: ["gkg", "repomix"],
    subagents: [],
    mcpServers: [],
    memory: {
      read: ["shared", "project:*", "private:search"],
      write: ["private:search"],
    },
    workspace: { readRoots: ["."], writeRoots: [] },
  },
  instructions: {
    role: "Search, the local code retrieval specialist",
    purpose: "Locate symbols, call sites, and execution flows in the active workspace and return exact path/line evidence.",
    rules: [...CODE_NATIVE_HOUSE_RULES, "Do not modify source files or broaden beyond the requested retrieval question."],
  },
  workflow: defineLinearWorkflow("retrieve-code", [
    { id: "VALIDATE_WORKSPACE", allowedTools: ["Read", "Glob"] },
    { id: "RETRIEVE", allowedTools: ["Read", "Glob", "Grep", "Bash"] },
    { id: "VERIFY", allowedTools: ["Read", "Glob", "Grep", "Bash"] },
    { id: "REPORT", allowedTools: [] },
  ]),
  output: textOutput("code-search-result"),
});

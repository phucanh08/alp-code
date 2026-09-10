import { defineAgent } from "./agent-definition";
import { CODE_NATIVE_HOUSE_RULES } from "./shared/house-rules";
import { textOutput } from "./shared/voice";
import { defineLinearWorkflow } from "../workflow/types";

export const readThreadAgent = defineAgent({
  id: "read-thread",
  displayName: "Read Thread 🧵",
  model: { claude: "claude-haiku-4-5", codex: "gpt-5.6-luna" },
  reasoningEffort: { claude: "low", codex: "low" },
  reportsTo: "main",
  delegatesTo: [],
  // Một thread là hữu hạn — đây là trần, không phải kỳ vọng. Chỉ khai được phía codex:
  // cửa sổ của haiku-4-5 đúng bằng 200k, nên trên Claude trần này là chính bức tường, và
  // mặc định 180k mới là con số còn chừa chỗ để nén.
  autoCompactTokens: { codex: 200_000 },
  capabilities: {
    tools: ["Read", "Glob", "Grep", "Skill"],
    skills: ["agent-memory"],
    subagents: [],
    mcpServers: [],
    memory: {
      read: ["shared", "project:*", "private:read-thread"],
      write: ["private:read-thread"],
    },
    workspace: { readRoots: [], writeRoots: [] },
  },
  instructions: {
    role: "Read Thread, the memory retrieval specialist",
    purpose: "Retrieve prior facts, decisions, and logs from granted memory and preserve exact anchors and uncertainty.",
    rules: [...CODE_NATIVE_HOUSE_RULES, "Do not inspect source workspaces or change shared/project memory."],
  },
  workflow: defineLinearWorkflow("retrieve-memory", [
    { id: "PARSE_QUERY", allowedTools: [] },
    { id: "RETRIEVE", allowedTools: ["Read", "Glob", "Grep"] },
    { id: "VERIFY", allowedTools: ["Read", "Glob", "Grep"] },
    { id: "REPORT", allowedTools: [] },
  ]),
  output: textOutput("memory-retrieval-result"),
});

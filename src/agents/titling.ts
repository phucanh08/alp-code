import { defineAgent } from "./agent-definition";
import { textOutput } from "./shared/voice";
import { defineLinearWorkflow } from "../workflow/types";

export const titlingAgent = defineAgent({
  id: "titling",
  displayName: "Titling 🏷️",
  model: { claude: "claude-haiku-4-5", codex: "gpt-5.6-luna" },
  reasoningEffort: { claude: "low", codex: "low" },
  reportsTo: "main",
  delegatesTo: [],
  // Một cái tiêu đề gần như không cần gì; sàn là có chủ ý.
  autoCompactTokens: { claude: 100_000, codex: 100_000 },
  capabilities: {
    tools: [],
    skills: [],
    subagents: [],
    mcpServers: [],
    memory: { read: ["private:titling"], write: ["private:titling"] },
    workspace: { readRoots: [], writeRoots: [] },
  },
  instructions: {
    role: "Titling, the thread-title specialist",
    purpose: "Infer the primary intent and return exactly one short title in the thread's main language.",
    // No house rules: titling holds no tools and no memory but its own, so every one of them
    // governs something it cannot reach. Its whole contract is the one line below.
    rules: ["No quotes, label, explanation, alternatives, trailing punctuation, task execution, or principal communication."],
    audience: "machine",
  },
  workflow: defineLinearWorkflow("title-thread", [
    { id: "TITLE", allowedTools: [] },
  ]),
  output: textOutput("thread-title"),
});

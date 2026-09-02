import { defineAgent } from "./agent-definition";
import { CODE_NATIVE_HOUSE_RULES } from "./shared/house-rules";
import { renderInstructions, textOutput } from "./shared/voice";
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
  instructions: () => renderInstructions(
    "Read Thread, the memory retrieval specialist",
    "Retrieve prior facts, decisions, and logs from granted memory and preserve exact anchors and uncertainty.",
    [...CODE_NATIVE_HOUSE_RULES, "Do not inspect source workspaces or change shared/project memory."],
  ),
  workflow: defineLinearWorkflow("retrieve-memory", [
    { id: "PARSE_QUERY", allowedTools: [] },
    { id: "RETRIEVE", allowedTools: ["Read", "Glob", "Grep"] },
    { id: "VERIFY", allowedTools: ["Read", "Glob", "Grep"] },
    { id: "REPORT", allowedTools: [] },
  ]),
  output: textOutput("memory-retrieval-result"),
});

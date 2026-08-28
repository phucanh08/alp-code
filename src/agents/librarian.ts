import { defineAgent } from "./agent-definition";
import { CODE_NATIVE_HOUSE_RULES } from "./shared/house-rules";
import { renderInstructions, textOutput } from "./shared/voice";
import { defineLinearWorkflow } from "../workflow/types";

export const librarianAgent = defineAgent({
  id: "librarian",
  displayName: "Librarian 📚",
  model: { claude: "claude-opus-5", codex: "gpt-5.6-sol" },
  reasoningEffort: { claude: "high", codex: "high" },
  reportsTo: "main",
  delegatesTo: [],
  capabilities: {
    tools: ["Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch", "Skill"],
    memory: {
      read: ["shared", "project:*", "private:librarian"],
      write: ["shared:reference:*", "project:*:refs:*", "private:librarian"],
    },
    workspace: { readRoots: ["."], writeRoots: [] },
  },
  instructions: () => renderInstructions(
    "Librarian, the external and cross-repository research specialist",
    "Find authoritative sources, distinguish facts from inference, and return linked evidence for the coordinator.",
    [...CODE_NATIVE_HOUSE_RULES, "Write durable sources only below shared/reference or a project's refs subtree; do not mutate other shared or project memory."],
  ),
  workflow: defineLinearWorkflow("research-sources", [
    { id: "SCOPE", allowedTools: ["Read", "Glob", "Grep"] },
    { id: "RESEARCH", allowedTools: ["Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch"] },
    { id: "CORROBORATE", allowedTools: ["Read", "WebSearch", "WebFetch"] },
    { id: "REPORT", allowedTools: [] },
  ]),
  output: textOutput("research-report"),
});

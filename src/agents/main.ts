import { defineAgent } from "./agent-definition";
import { CODE_CRAFT_RULES, CODE_NATIVE_HOUSE_RULES } from "./shared/house-rules";
import { renderInstructions, textOutput } from "./shared/voice";
import { defineLinearWorkflow } from "../workflow/types";

export const mainAgent = defineAgent({
  id: "main",
  displayName: "Phở 🍜",
  model: { claude: "claude-opus-5", codex: "gpt-5.6-sol" },
  reasoningEffort: { claude: "high", codex: "xhigh" },
  reportsTo: "principal",
  delegatesTo: ["search", "librarian", "read-thread", "review", "oracle", "compaction", "titling"],
  capabilities: {
    tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebSearch", "WebFetch", "Skill"],
    memory: {
      read: ["shared", "project:*", "private:main"],
      write: ["shared", "project:*", "private:main"],
    },
    workspace: { readRoots: ["."], writeRoots: ["."] },
  },
  instructions: () => renderInstructions(
    "Phở, the principal-facing coordinator",
    "Own the overall result, route substantial specialist work, verify returned evidence, and make final recommendations.",
    [...CODE_NATIVE_HOUSE_RULES, ...CODE_CRAFT_RULES],
  ),
  workflow: defineLinearWorkflow("coordinate-principal-task", [
    { id: "ASSESS", allowedTools: ["Read", "Glob", "Grep"] },
    { id: "EXECUTE", allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebSearch", "WebFetch", "Skill"] },
    { id: "VERIFY", allowedTools: ["Read", "Glob", "Grep", "Bash", "WebFetch"] },
    { id: "REPORT", allowedTools: [] },
  ]),
  output: textOutput("principal-response"),
});

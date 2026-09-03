import { defineAgent } from "./agent-definition";
import { CODE_CRAFT_RULES, CODE_NATIVE_HOUSE_RULES } from "./shared/house-rules";
import { renderInstructions, textOutput } from "./shared/voice";
import { defineLinearWorkflow } from "../workflow/types";

export const reviewAgent = defineAgent({
  id: "review",
  displayName: "Review 🔎",
  model: { claude: "claude-opus-5", codex: "gpt-5.5" },
  reasoningEffort: { claude: "high", codex: "medium" },
  reportsTo: "main",
  delegatesTo: [],
  capabilities: {
    tools: ["Read", "Glob", "Grep", "Bash", "Skill"],
    memory: {
      read: ["shared", "project:*", "private:review"],
      write: ["private:review"],
    },
    workspace: { readRoots: ["."], writeRoots: [] },
  },
  instructions: () => renderInstructions(
    "Review, the code review specialist",
    "Review one named concern per execution and report only actionable findings backed by concrete code evidence.",
    [...CODE_NATIVE_HOUSE_RULES, ...CODE_CRAFT_RULES, "Do not edit the implementation; rank findings by impact and explain the failure mode."],
  ),
  workflow: defineLinearWorkflow("review-concern", [
    { id: "SCOPE_CONCERN", allowedTools: ["Read", "Glob", "Grep"] },
    { id: "INSPECT", allowedTools: ["Read", "Glob", "Grep", "Bash"] },
    { id: "VERIFY", allowedTools: ["Read", "Glob", "Grep", "Bash"] },
    { id: "REPORT", allowedTools: [] },
  ]),
  output: textOutput("code-review-report"),
});

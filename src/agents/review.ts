import { defineAgent } from "./agent-definition";
import { CODE_CRAFT_RULES, CODE_NATIVE_HOUSE_RULES } from "./shared/house-rules";
import { textOutput } from "./shared/voice";
import { defineLinearWorkflow } from "../workflow/types";

export const reviewAgent = defineAgent({
  id: "review",
  displayName: "Review 🔎",
  model: { claude: "claude-opus-5", codex: "gpt-5.6-terra" },
  reasoningEffort: { claude: "high", codex: "medium" },
  reportsTo: "main",
  delegatesTo: [],
  // Một diff cộng code quanh nó, và mối nghi phải sống tới lúc ra phán quyết. Phía codex
  // bỏ trống vì mặc định 90% của 272k đã thấp hơn trần này.
  autoCompactTokens: { claude: 300_000 },
  capabilities: {
    tools: ["Read", "Glob", "Grep", "Bash", "Skill"],
    skills: ["code-review", "alp-scenario", "security-scan", "test-quality-guard"],
    subagents: [],
    mcpServers: [],
    memory: {
      read: ["shared", "project:*", "private:review"],
      write: ["private:review"],
    },
    workspace: { readRoots: ["."], writeRoots: [] },
  },
  instructions: {
    role: "Review, the code review specialist",
    purpose: "Review one named concern per execution and report only actionable findings backed by concrete code evidence.",
    rules: [...CODE_NATIVE_HOUSE_RULES, ...CODE_CRAFT_RULES, "Do not edit the implementation; rank findings by impact and explain the failure mode."],
  },
  workflow: defineLinearWorkflow("review-concern", [
    { id: "SCOPE_CONCERN", allowedTools: ["Read", "Glob", "Grep"] },
    { id: "INSPECT", allowedTools: ["Read", "Glob", "Grep", "Bash"] },
    { id: "VERIFY", allowedTools: ["Read", "Glob", "Grep", "Bash"] },
    { id: "REPORT", allowedTools: [] },
  ]),
  output: textOutput("code-review-report"),
});

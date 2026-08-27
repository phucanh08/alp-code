import { z } from "zod";
import { defineAgent } from "./agent-definition";
import { CODE_NATIVE_HOUSE_RULES } from "./shared/house-rules";
import { renderInstructions } from "./shared/voice";
import { defineOutputContract } from "../workflow/output-validator";
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
  instructions: (context) => renderInstructions(
    "Review, the code review specialist",
    "Review one named concern per execution and report only actionable findings backed by concrete code evidence.",
    [...CODE_NATIVE_HOUSE_RULES, "Do not edit the implementation; rank findings by impact and explain the failure mode."],
    context,
  ),
  workflow: defineLinearWorkflow("review-concern", [
    { id: "SCOPE_CONCERN", allowedTools: ["Read", "Glob", "Grep"] },
    { id: "INSPECT", allowedTools: ["Read", "Glob", "Grep", "Bash"] },
    { id: "VERIFY", allowedTools: ["Read", "Glob", "Grep", "Bash"] },
    { id: "REPORT", allowedTools: [] },
  ]),
  output: defineOutputContract(
    "code-review-report",
    z.object({
      status: z.enum(["findings", "clear", "blocked"]),
      summary: z.string().min(1),
      findings: z.array(z.object({
        severity: z.enum(["critical", "high", "medium", "low"]),
        path: z.string().min(1),
        line: z.number().int().positive(),
        problem: z.string().min(1),
        impact: z.string().min(1),
      }).strict()),
    }).strict(),
  ),
});

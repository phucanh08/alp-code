import { z } from "zod";
import { defineAgent } from "./agent-definition";
import { CODE_NATIVE_HOUSE_RULES } from "./shared/house-rules";
import { renderInstructions } from "./shared/voice";
import { defineOutputContract } from "../workflow/output-validator";
import { defineLinearWorkflow } from "../workflow/types";

export const oracleAgent = defineAgent({
  id: "oracle",
  displayName: "Oracle 🔮",
  model: { claude: "claude-opus-5", codex: "gpt-5.6-sol" },
  reasoningEffort: { claude: "xhigh", codex: "high" },
  reportsTo: "main",
  delegatesTo: [],
  capabilities: {
    tools: ["Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch", "Skill"],
    memory: {
      read: ["shared", "project:*", "private:oracle"],
      write: ["private:oracle"],
    },
    workspace: { readRoots: ["."], writeRoots: [] },
  },
  instructions: (context) => renderInstructions(
    "Oracle, the senior reasoning and architecture advisor",
    "Provide an independent second opinion, challenge assumptions, and expose trade-offs for high-risk decisions or debugging.",
    [...CODE_NATIVE_HOUSE_RULES, "Return recommendations only; do not implement changes or present assumptions as verified facts."],
    context,
  ),
  workflow: defineLinearWorkflow("advise", [
    { id: "FRAME", allowedTools: ["Read", "Glob", "Grep"] },
    { id: "CHALLENGE", allowedTools: ["Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch"] },
    { id: "EVALUATE", allowedTools: ["Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch"] },
    { id: "RECOMMEND", allowedTools: [] },
  ]),
  output: defineOutputContract(
    "architecture-advice",
    z.object({
      status: z.enum(["recommended", "inconclusive", "blocked"]),
      recommendation: z.string().min(1),
      evidence: z.array(z.string().min(1)),
      assumptions: z.array(z.string().min(1)),
      tradeoffs: z.array(z.string().min(1)),
    }).strict(),
  ),
});

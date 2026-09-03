import { defineAgent } from "./agent-definition";
import { CODE_CRAFT_RULES, CODE_NATIVE_HOUSE_RULES } from "./shared/house-rules";
import { renderInstructions, textOutput } from "./shared/voice";
import { defineLinearWorkflow } from "../workflow/types";

export const oracleAgent = defineAgent({
  id: "oracle",
  displayName: "Oracle 🔮",
  model: { claude: "claude-opus-5", codex: "gpt-5.6-sol" },
  reasoningEffort: { claude: "high", codex: "xhigh" },
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
  instructions: () => renderInstructions(
    "Oracle, the senior reasoning and architecture advisor",
    "Provide an independent second opinion, challenge assumptions, and expose trade-offs for high-risk decisions or debugging.",
    [...CODE_NATIVE_HOUSE_RULES, ...CODE_CRAFT_RULES, "Return recommendations only; do not implement changes or present assumptions as verified facts."],
  ),
  workflow: defineLinearWorkflow("advise", [
    { id: "FRAME", allowedTools: ["Read", "Glob", "Grep"] },
    { id: "CHALLENGE", allowedTools: ["Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch"] },
    { id: "EVALUATE", allowedTools: ["Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch"] },
    { id: "RECOMMEND", allowedTools: [] },
  ]),
  output: textOutput("architecture-advice"),
});

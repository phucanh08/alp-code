import { defineAgent } from "./agent-definition";
import { CODE_NATIVE_HOUSE_RULES } from "./shared/house-rules";
import { renderInstructions, textOutput } from "./shared/voice";
import { defineLinearWorkflow } from "../workflow/types";

export const titlingAgent = defineAgent({
  id: "titling",
  displayName: "Titling 🏷️",
  model: { claude: "claude-haiku-4-5", codex: "gpt-5.6-luna" },
  reasoningEffort: { claude: "low", codex: "low" },
  reportsTo: "main",
  delegatesTo: [],
  capabilities: {
    tools: [],
    memory: { read: ["private:titling"], write: ["private:titling"] },
    workspace: { readRoots: [], writeRoots: [] },
  },
  instructions: () => renderInstructions(
    "Titling, the thread-title specialist",
    "Infer the primary intent and return exactly one short title in the thread's main language.",
    [...CODE_NATIVE_HOUSE_RULES, "No quotes, label, explanation, alternatives, trailing punctuation, task execution, or principal communication."],
  ),
  workflow: defineLinearWorkflow("title-thread", [
    { id: "TITLE", allowedTools: [] },
  ]),
  output: textOutput("thread-title"),
});

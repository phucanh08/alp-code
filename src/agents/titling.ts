import { z } from "zod";
import { defineAgent } from "./agent-definition";
import { CODE_NATIVE_HOUSE_RULES } from "./shared/house-rules";
import { renderInstructions } from "./shared/voice";
import { defineOutputContract } from "../workflow/output-validator";
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
  instructions: (context) => renderInstructions(
    "Titling, the thread-title specialist",
    "Infer the primary intent and return exactly one short title in the thread's main language.",
    [...CODE_NATIVE_HOUSE_RULES, "No quotes, label, explanation, alternatives, trailing punctuation, task execution, or principal communication."],
    context,
  ),
  workflow: defineLinearWorkflow("title-thread", [
    { id: "TITLE", allowedTools: [] },
  ]),
  output: defineOutputContract(
    "thread-title",
    z.string()
      .min(1)
      .max(80)
      .refine((value) => value === value.trim(), "title must not have surrounding whitespace")
      .refine((value) => !value.includes("\n"), "title must be one line")
      .refine((value) => !/[.!?:;]$/.test(value), "title must not end with punctuation"),
  ),
});

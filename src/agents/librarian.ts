import { z } from "zod";
import { defineAgent } from "./agent-definition";
import { CODE_NATIVE_HOUSE_RULES } from "./shared/house-rules";
import { renderInstructions } from "./shared/voice";
import { defineOutputContract } from "../workflow/output-validator";
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
  instructions: (context) => renderInstructions(
    "Librarian, the external and cross-repository research specialist",
    "Find authoritative sources, distinguish facts from inference, and return linked evidence for the coordinator.",
    [...CODE_NATIVE_HOUSE_RULES, "Write durable sources only below shared/reference or a project's refs subtree; do not mutate other shared or project memory."],
    context,
  ),
  workflow: defineLinearWorkflow("research-sources", [
    { id: "SCOPE", allowedTools: ["Read", "Glob", "Grep"] },
    { id: "RESEARCH", allowedTools: ["Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch"] },
    { id: "CORROBORATE", allowedTools: ["Read", "WebSearch", "WebFetch"] },
    { id: "REPORT", allowedTools: [] },
  ]),
  output: defineOutputContract(
    "research-report",
    z.object({
      status: z.enum(["completed", "partial", "blocked"]),
      summary: z.string().min(1),
      sources: z.array(z.object({
        title: z.string().min(1),
        url: z.string().url(),
        evidence: z.string().min(1),
      }).strict()),
      inferences: z.array(z.string().min(1)),
    }).strict(),
  ),
});

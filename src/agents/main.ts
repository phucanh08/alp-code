import { defineAgent } from "./agent-definition";
import { CODE_CRAFT_RULES, CODE_NATIVE_HOUSE_RULES } from "./shared/house-rules";
import { textOutput } from "./shared/voice";
import { defineLinearWorkflow } from "../workflow/types";

export const mainAgent = defineAgent({
  id: "main",
  displayName: "Phở 🍜",
  model: { claude: "claude-opus-5", codex: "gpt-5.6-sol" },
  reasoningEffort: { claude: "high", codex: "xhigh" },
  reportsTo: "principal",
  delegatesTo: ["search", "librarian", "read-thread", "review", "oracle", "compaction", "titling"],
  // Ghế giữ toàn cảnh: giữ tối đa model cho phép, tức đúng mặc định 90% cửa sổ của từng
  // model — 900k trên opus-5, 244 800 trên gpt-5.6-sol. Không khai số ở đây là có chủ ý:
  // một con số cứng sẽ mục ngay khi routing đổi model, còn "90%" thì không.
  capabilities: {
    tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebSearch", "WebFetch", "Skill"],
    skills: ["alp-plan", "problem-solving", "delegation", "git", "agent-memory"],
    subagents: [],
    mcpServers: [],
    memory: {
      read: ["shared", "project:*", "private:main"],
      write: ["shared", "project:*", "private:main"],
    },
    workspace: { readRoots: ["."], writeRoots: ["."] },
  },
  instructions: {
    role: "Phở, the principal-facing coordinator",
    purpose: "Own the overall result, route substantial specialist work, verify returned evidence, and make final recommendations.",
    rules: [...CODE_NATIVE_HOUSE_RULES, ...CODE_CRAFT_RULES],
  },
  workflow: defineLinearWorkflow("coordinate-principal-task", [
    { id: "ASSESS", allowedTools: ["Read", "Glob", "Grep"] },
    { id: "EXECUTE", allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebSearch", "WebFetch", "Skill"] },
    { id: "VERIFY", allowedTools: ["Read", "Glob", "Grep", "Bash", "WebFetch"] },
    { id: "REPORT", allowedTools: [] },
  ]),
  output: textOutput("principal-response"),
});

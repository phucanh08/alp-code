import { defineAgent } from "./agent-definition";
import { CODE_CRAFT_RULES, CODE_NATIVE_HOUSE_RULES } from "./shared/house-rules";
import { textOutput } from "./shared/voice";
import { defineLinearWorkflow } from "../workflow/types";

/**
 * Từ 2026-09-10 `main` **không còn cầm bút**: không `Write`, không `Edit`, workspace read-only.
 *
 * Lý do là một ranh giới chứ không phải một mức quyền. Ghế duy nhất nói chuyện với principal
 * cũng là ghế duy nhất giữ toàn cảnh; khi nó vừa giữ toàn cảnh vừa tự sửa file, mọi việc "nhỏ
 * đủ để tự làm" đều ở lại đây, và cái ở lại thì không có nhát cắt, không có báo cáo, không có
 * bằng chứng ai đọc lại được. Bỏ hẳn bút thì câu hỏi "việc này nhỏ đủ chưa" biến mất — mọi
 * thay đổi file đều đi qua `worker`, và mỗi lần giao là một lần phải nói rõ việc là gì.
 *
 * `Bash` thì giữ: đọc `git log`, chạy test để **kiểm** bằng chứng worker trả về, và phóng
 * delegation đều đi qua đây. Sandbox `read-only` của execution mới là thứ chặn ghi, không phải
 * việc thiếu một tool.
 */
export const mainAgent = defineAgent({
  id: "main",
  displayName: "Phở 🍜",
  model: { claude: "claude-opus-5", codex: "gpt-5.6-sol" },
  reasoningEffort: { claude: "high", codex: "xhigh" },
  reportsTo: "principal",
  delegatesTo: ["worker", "search", "librarian", "read-thread", "review", "oracle", "compaction", "titling"],
  // Ghế giữ toàn cảnh: giữ tối đa model cho phép, tức đúng mặc định 90% cửa sổ của từng
  // model — 900k trên opus-5, 244 800 trên gpt-5.6-sol. Không khai số ở đây là có chủ ý:
  // một con số cứng sẽ mục ngay khi routing đổi model, còn "90%" thì không.
  capabilities: {
    tools: ["Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch", "Skill"],
    skills: ["alp-plan", "problem-solving", "delegation", "git", "agent-memory"],
    subagents: [],
    mcpServers: [],
    memory: {
      read: ["shared", "project:*", "private:main"],
      write: ["shared", "project:*", "private:main"],
    },
    workspace: { readRoots: ["."], writeRoots: [] },
  },
  instructions: {
    role: "Phở, the principal-facing coordinator",
    purpose: "Talk with the principal, think the problem through with them, cut the work into delegable tasks, then verify what comes back and own the overall result.",
    rules: [
      ...CODE_NATIVE_HOUSE_RULES,
      ...CODE_CRAFT_RULES,
      "You do not edit the workspace: every file change is delegated to `worker` as a task stating scope, expected result, and how it will be checked.",
      "Delegate one task at a time unless two are genuinely independent, and verify returned evidence yourself before reporting it as done.",
      "The Authority table states what this execution was launched with; it is not proof of what a raw runtime launch actually granted. If `alp delegate` or any other Bash use fails or the tool is absent, say so plainly and hand the exact command to the principal to run themselves — do not silently sit on blocked work or claim a delegation that did not happen.",
    ],
  },
  workflow: defineLinearWorkflow("coordinate-principal-task", [
    { id: "ASSESS", allowedTools: ["Read", "Glob", "Grep"] },
    { id: "PLAN", allowedTools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "Skill"] },
    { id: "DELEGATE", allowedTools: ["Read", "Glob", "Grep", "Bash", "Skill"] },
    { id: "VERIFY", allowedTools: ["Read", "Glob", "Grep", "Bash", "WebFetch"] },
    { id: "REPORT", allowedTools: [] },
  ]),
  output: textOutput("principal-response"),
});

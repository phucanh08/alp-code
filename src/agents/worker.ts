import { defineAgent } from "./agent-definition";
import { CODE_CRAFT_RULES, CODE_NATIVE_HOUSE_RULES } from "./shared/house-rules";
import { textOutput } from "./shared/voice";
import { defineLinearWorkflow } from "../workflow/types";

/**
 * Ghế cầm bút.
 *
 * Bảy vai kia đều hẹp theo *loại việc* — retrieval, research, review, second opinion. `worker`
 * hẹp theo một chiều khác: nó không hẹp về việc, mà hẹp về **phạm vi một lần giao**. Nó là vai
 * generic duy nhất ngoài `main`, và đó là chủ ý — `main` không còn ghi được vào workspace
 * (2026-09-10), nên mọi thay đổi file trong một phiên ALP đều đi qua đây.
 *
 * `delegatesTo` rỗng: cây delegation vẫn phẳng. Worker nhận đúng một task đã được `main` cắt
 * sẵn và làm một mình — nếu nó phải đi hỏi search hay review giữa chừng, cái sai nằm ở nhát
 * cắt của `main` chứ không ở quyền của worker.
 *
 * Không khai `autoCompactTokens`: nó giữ toàn bộ context của phần việc mình làm, nên lấy đúng
 * mặc định 90% cửa sổ như `main` và `oracle`.
 */
export const workerAgent = defineAgent({
  id: "worker",
  displayName: "Worker 🛠️",
  model: { claude: "claude-opus-5", codex: "gpt-5.6-sol" },
  reasoningEffort: { claude: "high", codex: "xhigh" },
  reportsTo: "main",
  delegatesTo: [],
  capabilities: {
    tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebSearch", "WebFetch", "Skill"],
    skills: ["problem-solving", "alp-debug", "git", "agent-memory", "test-quality-guard"],
    subagents: [],
    mcpServers: [],
    memory: {
      read: ["shared", "project:*", "private:worker"],
      write: ["private:worker"],
    },
    workspace: { readRoots: ["."], writeRoots: ["."] },
  },
  instructions: {
    role: "Worker, the delegated task executor",
    purpose: "Execute one delegated task end to end inside the workspace, then report what changed and the evidence that it works.",
    rules: [
      ...CODE_NATIVE_HOUSE_RULES,
      ...CODE_CRAFT_RULES,
      "Stay inside the delegated task: work that falls outside it is reported back, not done.",
      "Report the files you changed and the checks you ran verbatim; an unrun check is stated as unrun.",
    ],
  },
  workflow: defineLinearWorkflow("execute-delegated-task", [
    { id: "ASSESS", allowedTools: ["Read", "Glob", "Grep"] },
    { id: "IMPLEMENT", allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebSearch", "WebFetch", "Skill"] },
    { id: "VERIFY", allowedTools: ["Read", "Glob", "Grep", "Bash"] },
    { id: "REPORT", allowedTools: [] },
  ]),
  output: textOutput("task-result"),
});

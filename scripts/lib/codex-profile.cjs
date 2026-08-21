// codex-profile.cjs — loadout.yaml → `$CODEX_HOME/<role>.config.toml`.
//
// `codex exec -p <role>` LỚP file này lên trên config gốc của người dùng (không phải
// `[profiles.x]` — đo trên codex-cli 0.149.0). Nhờ vậy model, effort, sandbox, approval,
// web_search và hook đi cùng DANH TÍNH, không phụ thuộc chỗ đứng.
//
// BỐN ĐIỀU ĐÃ ĐO, đừng đoán lại:
//
//   1. Khoá sự kiện hook là PascalCase (`SessionStart`), mỗi nhóm là array-of-tables và
//      hook thật nằm trong array con `hooks`. Wire format vào/ra trùng Claude Code:
//      `tool_name`/`tool_input` vào, `hookSpecificOutput`/`additionalContext` ra.
//      `systemMessage` KHÔNG bị từ chối — không cần adapter.
//   2. `command` chạy qua shell ⇒ nhét được `ALP_ROLE=<role>` làm tiền tố. Codex không có
//      khối `env` như Claude settings, đây là đường duy nhất đưa danh tính tới hook.
//   3. Hook bị TRUST-GATE: profile chưa được duyệt thì hook bị BỎ QUA IM LẶNG trong phiên
//      headless — không lỗi, không cảnh báo. `run-role --exec` phải kèm
//      `--dangerously-bypass-hook-trust`, xem run-role.cjs.
//   4. `sandbox_mode` phải nằm TRONG profile: mặc định của `codex exec` là
//      `workspace-write`. Và profile THIẾU thì `-p` im lặng bỏ qua, rơi về mặc định đó.
//
// Ở đây mọi vai — kể cả `main` — đều `read-only`. Quyền ghi là chuyện của TỪNG LẦN CHẠY
// (phụ thuộc cwd), không phải của danh tính: `run-role` nâng bằng `-s workspace-write` khi
// và chỉ khi cwd nằm trong `workspaces.write`. Pin read-only ở đây = hỏng thì hỏng đóng.

const path = require("path");

/** Vai duy nhất được cấp web search — thay cho cờ `--search` cũ. */
const WEB_SEARCH_ROLES = new Set(["librarian"]);

const HOOKS = [
  ["SessionStart", "session-start.cjs"],
  ["PreToolUse", "acl-guard.cjs"],
];

/** Đường dẫn profile của một vai trong CODEX_HOME. */
function profilePath(codexHome, role) {
  return path.join(codexHome, `${role}.config.toml`);
}

/** `$CODEX_HOME` nếu có, mặc định `~/.codex`. */
function codexHome(env = process.env) {
  return env.CODEX_HOME || path.join(env.HOME || require("os").homedir(), ".codex");
}

/** Model dùng cho Codex. `model:` là model của runtime CHÍNH — main khai model Claude. */
const codexModel = (loadout) => loadout.codex_model || loadout.model;

/**
 * `opts.sandboxMode` — CHỈ dùng cho `<project>/.codex/config.toml` do `alp init` sinh:
 * ở đó không có launcher nào nâng quyền theo từng lần chạy, mà project đã nằm trong
 * `workspaces.write` nên `workspace-write` là mức đúng. Profile trong `$CODEX_HOME` giữ
 * mặc định `read-only` — xem điều 4 ở đầu file.
 * `opts.header` — hai dòng comment đầu file, để nói đúng ai sinh ra file này.
 */
function buildProfile(loadout, role, repoRoot, opts = {}) {
  const lines = [
    ...(opts.header || [
      `# GENERATED bởi scripts/compile-acl.sh từ identity/${role}/loadout.yaml — KHÔNG SỬA TAY.`,
      `# Sửa loadout.yaml rồi chạy: scripts/compile-acl.sh`,
    ]),
    "",
    `model = ${str(codexModel(loadout))}`,
  ];
  if (loadout.reasoning_effort)
    lines.push(`model_reasoning_effort = ${str(loadout.reasoning_effort)}`);
  lines.push(`approval_policy = "never"`);
  // Xem đầu file, điều 4: đây là mức nền an toàn, không phải mức quyền thật.
  lines.push(`sandbox_mode = ${str(opts.sandboxMode || "read-only")}`);

  lines.push("", "[tools]", `web_search = ${WEB_SEARCH_ROLES.has(role)}`);

  for (const [event, file] of HOOKS) {
    const cmd = `ALP_ROLE=${role} node ${shellQuote(path.join(repoRoot, "hooks", file))}`;
    lines.push(
      "",
      `[[hooks.${event}]]`,
      "",
      `[[hooks.${event}.hooks]]`,
      `type = "command"`,
      `command = ${str(cmd)}`
    );
  }

  return lines.join("\n") + "\n";
}

/** Chuỗi TOML basic — escape đúng thứ tự, backslash trước. */
function str(value) {
  return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/** Bọc path cho shell: nháy đơn, và `'` trong path thành `'\''`. */
function shellQuote(p) {
  return "'" + p.replace(/'/g, "'\\''") + "'";
}

module.exports = { buildProfile, profilePath, codexHome, codexModel, WEB_SEARCH_ROLES };

// Vai chạy được qua launcher Codex.
// `main` có mặt ở đây nhưng Codex chỉ là ĐƯỜNG PHỤ (tiết kiệm quota): Codex không nạp
// được `alp:plan`/`alp:cook` — đó là marketplace của Claude Code. Runtime chính của main
// vẫn là Claude.
const ALLOWED_ROLES = new Set([
  "main",
  "search",
  "librarian",
  "read-thread",
  "review",
  "oracle",
  "compaction",
  "titling",
]);

const isAllowedRole = (role) => ALLOWED_ROLES.has(role);

module.exports = { ALLOWED_ROLES, isAllowedRole };

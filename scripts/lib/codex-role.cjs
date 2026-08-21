const ALLOWED_ROLES = new Set([
  "search",
  "librarian",
  "read-thread",
  "review",
  "oracle",
  "compaction",
  "titling",
]);

const isAllowedRole = (role) => ALLOWED_ROLES.has(role);
const reasoningArgs = (loadout) => loadout.reasoning_effort
  ? ["-c", `model_reasoning_effort="${loadout.reasoning_effort}"`]
  : [];

module.exports = { ALLOWED_ROLES, isAllowedRole, reasoningArgs };

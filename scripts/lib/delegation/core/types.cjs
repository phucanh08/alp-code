const crypto = require("crypto");
const { InvalidConfiguration } = require("./errors.cjs");

const DELEGATION_STATUSES = Object.freeze([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

function createId(prefix) {
  const random = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replaceAll("-", "")
    : crypto.randomBytes(16).toString("hex");
  return `${prefix}_${random.slice(0, 20)}`;
}

function createDelegationRequest(input) {
  if (!input || typeof input !== "object")
    throw new InvalidConfiguration("DelegationRequest phải là object");
  for (const key of ["parentRole", "targetRole", "task"]) {
    if (typeof input[key] !== "string" || !input[key].trim())
      throw new InvalidConfiguration(`DelegationRequest thiếu \`${key}\``);
  }
  if (input.requestId !== undefined && (typeof input.requestId !== "string" || !input.requestId.trim()))
    throw new InvalidConfiguration("DelegationRequest `requestId` phải là chuỗi không rỗng");
  if (input.workspace !== undefined && input.workspace !== null && typeof input.workspace !== "string")
    throw new InvalidConfiguration("DelegationRequest `workspace` phải là path string");
  if (input.parentExecutionId !== undefined && input.parentExecutionId !== null &&
      (typeof input.parentExecutionId !== "string" || !input.parentExecutionId.trim()))
    throw new InvalidConfiguration("DelegationRequest `parentExecutionId` phải là chuỗi không rỗng");
  const timeoutMs = input.executionOptions?.timeoutMs;
  if (timeoutMs !== undefined && timeoutMs !== null &&
      (!Number.isFinite(timeoutMs) || timeoutMs <= 0))
    throw new InvalidConfiguration("DelegationRequest `timeoutMs` phải là số dương");

  return {
    requestId: input.requestId?.trim() || createId("req"),
    parentRole: input.parentRole.trim(),
    parentExecutionId: input.parentExecutionId?.trim() || null,
    targetRole: input.targetRole.trim(),
    task: input.task.trim(),
    workspace: input.workspace || null,
    context: input.context || null,
    metadata: { ...(input.metadata || {}) },
    executionOptions: {
      background: Boolean(input.executionOptions?.background),
      interactive: Boolean(input.executionOptions?.interactive),
      timeoutMs: input.executionOptions?.timeoutMs ?? null,
      reuseSession: Boolean(input.executionOptions?.reuseSession),
      runtime: input.executionOptions?.runtime || null,
    },
  };
}

function createExecutionId() {
  return createId("exec");
}

function result(executionId, status, fields = {}) {
  if (!DELEGATION_STATUSES.includes(status))
    throw new InvalidConfiguration(`DelegationResult status không hợp lệ: ${status}`);
  return {
    executionId,
    status,
    ...(fields.output !== undefined ? { output: fields.output } : {}),
    ...(fields.artifacts?.length ? { artifacts: fields.artifacts } : {}),
    ...(fields.error ? { error: fields.error } : {}),
    ...(fields.metadata && Object.keys(fields.metadata).length ? { metadata: fields.metadata } : {}),
  };
}

module.exports = {
  DELEGATION_STATUSES,
  TERMINAL_STATUSES,
  createId,
  createExecutionId,
  createDelegationRequest,
  result,
};

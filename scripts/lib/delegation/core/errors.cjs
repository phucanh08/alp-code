class DelegationError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = this.constructor.name;
    this.code = code;
    this.details = options.details || null;
  }
}

class UnauthorizedDelegation extends DelegationError {
  constructor(message, options) { super("UnauthorizedDelegation", message, options); }
}
class UnknownRole extends DelegationError {
  constructor(message, options) { super("UnknownRole", message, options); }
}
class BackendUnavailable extends DelegationError {
  constructor(message, options) { super("BackendUnavailable", message, options); }
}
class SpawnFailed extends DelegationError {
  constructor(message, options) { super("SpawnFailed", message, options); }
}
class ExecutionFailed extends DelegationError {
  constructor(message, options) { super("ExecutionFailed", message, options); }
}
class DelegationTimeout extends DelegationError {
  constructor(message, options) { super("Timeout", message, options); }
}
class CancelFailed extends DelegationError {
  constructor(message, options) { super("CancelFailed", message, options); }
}
class InvalidConfiguration extends DelegationError {
  constructor(message, options) { super("InvalidConfiguration", message, options); }
}

function normalizeError(error, Fallback = ExecutionFailed) {
  if (error instanceof DelegationError) return error;
  return new Fallback(error instanceof Error ? error.message : String(error), { cause: error });
}

function toDelegationError(error) {
  const normalized = normalizeError(error);
  return {
    code: normalized.code,
    message: normalized.message,
    details: normalized.details,
  };
}

module.exports = {
  DelegationError,
  UnauthorizedDelegation,
  UnknownRole,
  BackendUnavailable,
  SpawnFailed,
  ExecutionFailed,
  DelegationTimeout,
  CancelFailed,
  InvalidConfiguration,
  normalizeError,
  toDelegationError,
};

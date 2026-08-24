const {
  createDelegationRequest,
  createExecutionId,
  result,
} = require("./types.cjs");
const {
  BackendUnavailable,
  ExecutionFailed,
  normalizeError,
  toDelegationError,
} = require("./errors.cjs");

class DelegationService {
  constructor(options) {
    this.roleRegistry = options.roleRegistry;
    this.policy = options.policy;
    this.contextBuilder = options.contextBuilder;
    this.backendRegistry = options.backendRegistry;
    this.executionStore = options.executionStore;
    this.config = options.config;
    this.log = options.logger || (() => {});
  }

  prepare(input) {
    const request = createDelegationRequest(input);
    this.log("delegation.requested", ids(request));

    let parent;
    let target;
    try {
      parent = this.roleRegistry.get(request.parentRole);
      target = this.roleRegistry.get(request.targetRole);
      this.policy.assertCanDelegate(parent, target);
    } catch (error) {
      this.log("delegation.denied", { ...ids(request), error: error.code || error.message });
      throw error;
    }

    this.log("delegation.authorized", ids(request));
    const context = this.contextBuilder.build({
      parent,
      target,
      task: request.task,
      workspace: request.workspace,
      inputContext: request.context,
    });
    const backend = this.resolveBackend(request.metadata.backend);

    return { request, parent, target, context, backend };
  }

  delegate(input) {
    const prepared = this.prepare(input);
    const { request, parent, target, context, backend } = prepared;
    const executionId = createExecutionId();
    const now = new Date().toISOString();
    this.executionStore.put({
      executionId,
      requestId: request.requestId,
      parentRole: parent.role,
      parentExecutionId: request.parentExecutionId,
      targetRole: target.role,
      workspace: context.workspace,
      backend: backend.name,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    });

    try {
      const spawned = backend.spawn({
        executionId,
        request: backendRequest(request),
        parent,
        target,
        context,
      });
      this.executionStore.update(executionId, { status: spawned.status });
      this.log("execution.spawned", {
        ...ids(request), execution_id: executionId, workspace: context.workspace, backend: backend.name,
      });
      if (spawned.status === "completed")
        this.log("execution.completed", { execution_id: executionId, backend: backend.name });
      if (spawned.status === "failed")
        this.log("execution.failed", { execution_id: executionId, backend: backend.name });
      return {
        ...spawned,
        metadata: { ...(spawned.metadata || {}), backend: backend.name },
      };
    } catch (error) {
      const normalized = normalizeError(error, ExecutionFailed);
      this.executionStore.update(executionId, { status: "failed", error: toDelegationError(normalized) });
      this.log(
        normalized.code === "BackendUnavailable" ? "backend.unavailable" : "execution.failed",
        { ...ids(request), execution_id: executionId, backend: backend.name, error: normalized.message }
      );
      throw normalized;
    }
  }

  status(executionId) {
    const backend = this.backendForExecution(executionId);
    const current = backend.status(executionId);
    const previous = this.executionStore.get(executionId)?.status;
    this.executionStore.update(executionId, { status: current.status });
    if (current.status !== previous) this.logTerminal(current.status, executionId, backend.name);
    return withBackend(current, backend.name);
  }

  wait(executionId, options = {}) {
    const backend = this.backendForExecution(executionId);
    let waited;
    try {
      waited = backend.wait(executionId, options);
    } catch (error) {
      const normalized = normalizeError(error, ExecutionFailed);
      if (normalized.code === "ExecutionFailed") {
        this.executionStore.update(executionId, {
          status: "failed",
          error: toDelegationError(normalized),
        });
        this.log("execution.failed", {
          execution_id: executionId,
          backend: backend.name,
          error: normalized.message,
        });
      } else if (normalized.code === "BackendUnavailable") {
        this.log("backend.unavailable", {
          execution_id: executionId,
          backend: backend.name,
          error: normalized.message,
        });
      }
      throw normalized;
    }
    this.executionStore.update(executionId, { status: waited.status });
    this.logTerminal(waited.status, executionId, backend.name);
    return withBackend(waited, backend.name);
  }

  cancel(executionId) {
    const backend = this.backendForExecution(executionId);
    backend.cancel(executionId);
    this.executionStore.update(executionId, { status: "cancelled" });
    this.log("execution.cancelled", { execution_id: executionId, backend: backend.name });
    return result(executionId, "cancelled", { metadata: { backend: backend.name } });
  }

  cleanup(executionId, options = {}) {
    const backend = this.backendForExecution(executionId, true, options.backend);
    backend.cleanup(executionId);
    return result(executionId, this.executionStore.get(executionId)?.status || "completed", {
      metadata: { backend: backend.name },
    });
  }

  health(name = this.config.backend) {
    const backend = this.backendRegistry.resolve(name);
    return { backend: backend.name, ...backend.healthCheck() };
  }

  listExecutions() {
    return this.executionStore.list().map(({
      executionId, requestId, parentExecutionId, parentRole, targetRole, workspace, backend, status, createdAt,
    }) => ({
      executionId, requestId, parentExecutionId: parentExecutionId || null,
      parentRole, targetRole, workspace: workspace || null, backend, status, createdAt,
    }));
  }

  resolveBackend(override) {
    const selected = override || this.config.backend;
    const backend = this.backendRegistry.resolve(selected);
    const fallbackName = this.config.fallbackBackend;
    if (!fallbackName || fallbackName === selected) return backend;

    const health = backend.healthCheck();
    if (health.ok) return backend;
    const fallback = this.backendRegistry.resolve(fallbackName);
    const fallbackHealth = fallback.healthCheck();
    if (!fallbackHealth.ok)
      throw new BackendUnavailable(
        `Backend \`${selected}\` unavailable (${health.message}); fallback \`${fallbackName}\` cũng unavailable (${fallbackHealth.message})`
      );
    this.log("backend.fallback", { backend: selected, fallback: fallbackName, reason: health.message });
    return fallback;
  }

  backendForExecution(executionId, allowUntracked = false, untrackedBackend = null) {
    const tracked = this.executionStore.get(executionId);
    if (tracked) return this.backendRegistry.resolve(tracked.backend);
    if (allowUntracked) return this.backendRegistry.resolve(untrackedBackend || this.config.backend);
    throw new ExecutionFailed(`Không có execution \`${executionId}\``);
  }

  logTerminal(status, executionId, backend) {
    const event = status === "completed" ? "execution.completed" :
      status === "failed" ? "execution.failed" :
      status === "cancelled" ? "execution.cancelled" : null;
    if (event) this.log(event, { execution_id: executionId, backend });
  }
}

function ids(request) {
  return {
    request_id: request.requestId,
    parent_execution_id: request.parentExecutionId,
    parent_role: request.parentRole,
    target_role: request.targetRole,
  };
}

function withBackend(value, backend) {
  return { ...value, metadata: { ...(value.metadata || {}), backend } };
}

/** Backend receives only context that ALP has prepared, never the caller's raw context field. */
function backendRequest(request) {
  const { context: _rawContext, ...safe } = request;
  return safe;
}

module.exports = { DelegationService };

const { result } = require("../core/types.cjs");

class FakeDelegationBackend {
  constructor(name = "fake", options = {}) {
    this.name = name;
    this.calls = [];
    this.health = options.health || { ok: true, status: "healthy", message: "fake ready" };
    this.spawnStatus = options.spawnStatus || "running";
    this.waitStatus = options.waitStatus || "completed";
  }

  healthCheck() { this.calls.push({ method: "healthCheck" }); return this.health; }
  spawn(request) {
    this.calls.push({ method: "spawn", request });
    return result(request.executionId, this.spawnStatus);
  }
  status(executionId) {
    this.calls.push({ method: "status", executionId });
    return result(executionId, this.spawnStatus);
  }
  wait(executionId) {
    this.calls.push({ method: "wait", executionId });
    return result(executionId, this.waitStatus, { output: "fake output" });
  }
  cancel(executionId) { this.calls.push({ method: "cancel", executionId }); }
  cleanup(executionId) { this.calls.push({ method: "cleanup", executionId }); }
}

module.exports = { FakeDelegationBackend };

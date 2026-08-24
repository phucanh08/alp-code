const { InvalidConfiguration } = require("./errors.cjs");

const REQUIRED_METHODS = ["healthCheck", "spawn", "status", "wait", "cancel", "cleanup"];

function assertDelegationBackend(backend) {
  if (!backend || typeof backend.name !== "string" || !backend.name.trim())
    throw new InvalidConfiguration("DelegationBackend thiếu `name`");
  for (const method of REQUIRED_METHODS) {
    if (typeof backend[method] !== "function")
      throw new InvalidConfiguration(`DelegationBackend \`${backend.name}\` thiếu \`${method}()`);
  }
  return backend;
}

module.exports = { REQUIRED_METHODS, assertDelegationBackend };

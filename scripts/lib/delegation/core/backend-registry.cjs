const { assertDelegationBackend } = require("./backend.cjs");
const { InvalidConfiguration } = require("./errors.cjs");

class DelegationBackendRegistry {
  constructor() { this.backends = new Map(); }

  register(backend) {
    assertDelegationBackend(backend);
    if (this.backends.has(backend.name))
      throw new InvalidConfiguration(`DelegationBackend \`${backend.name}\` đã được register`);
    this.backends.set(backend.name, backend);
    return this;
  }

  resolve(name) {
    const backend = this.backends.get(name);
    if (!backend)
      throw new InvalidConfiguration(
        `Delegation backend \`${name}\` chưa được register (có: ${this.names().join(", ") || "không có"})`
      );
    return backend;
  }

  names() { return [...this.backends.keys()]; }
}

module.exports = { DelegationBackendRegistry };

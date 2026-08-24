const path = require("path");
const { loadDelegationConfig } = require("./config.cjs");
const { DelegationBackendRegistry } = require("./core/backend-registry.cjs");
const { RoleRegistry } = require("./core/role-registry.cjs");
const { DelegationPolicy } = require("./core/policy.cjs");
const { DelegationContextBuilder } = require("./core/context-builder.cjs");
const { FileExecutionStore } = require("./core/execution-store.cjs");
const { DelegationService } = require("./core/service.cjs");
const { createDelegationLogger } = require("./core/logger.cjs");
const { HerdrBackend } = require("./backends/herdr/backend.cjs");
const { PaseoBackend } = require("./backends/paseo/backend.cjs");
const { buildContextForRole } = require("../../../hooks/session-start.cjs");

/** Composition root duy nhất biết concrete backends. Delegation Core không import chúng. */
function createDelegationService(options = {}) {
  const repoRoot = options.repoRoot;
  const config = options.config || loadDelegationConfig(repoRoot, options.env || process.env);
  const logger = options.logger || createDelegationLogger();
  const backendRegistry = options.backendRegistry || new DelegationBackendRegistry();

  if (!options.backendRegistry) {
    if (config.backends.herdr.enabled) backendRegistry.register(new HerdrBackend({
      repoRoot,
      stateDir: config.stateDir,
      logger,
      ...(options.herdr || {}),
    }));
    if (config.backends.paseo.enabled) backendRegistry.register(new PaseoBackend({
      config: config.backends.paseo,
      stateDir: config.stateDir,
      logger,
      ...(options.paseo || {}),
    }));
  }

  const service = new DelegationService({
    roleRegistry: options.roleRegistry || new RoleRegistry(repoRoot),
    policy: options.policy || new DelegationPolicy(),
    contextBuilder: options.contextBuilder || new DelegationContextBuilder({
      repoRoot,
      buildRoleContext: options.buildRoleContext || buildContextForRole,
    }),
    backendRegistry,
    executionStore: options.executionStore || new FileExecutionStore(path.join(config.stateDir, "executions.json")),
    config,
    logger,
  });

  return { service, config, backendRegistry };
}

module.exports = { createDelegationService };

#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const L = require("./lib/loadout.cjs");
const {
  loadDelegationConfig,
  writeBackendSelection,
  clearBackendSelection,
} = require("./lib/delegation/config.cjs");
const { DelegationBackendRegistry } = require("./lib/delegation/core/backend-registry.cjs");
const { RoleRegistry } = require("./lib/delegation/core/role-registry.cjs");
const { DelegationPolicy } = require("./lib/delegation/core/policy.cjs");
const { DelegationContextBuilder } = require("./lib/delegation/core/context-builder.cjs");
const { DelegationService } = require("./lib/delegation/core/service.cjs");
const { UnauthorizedDelegation, UnknownRole } = require("./lib/delegation/core/errors.cjs");
const { FakeDelegationBackend } = require("./lib/delegation/testing/fake-backend.cjs");

const repoRoot = L.findRepoRoot(__dirname);
const fake = new FakeDelegationBackend();
const registry = new DelegationBackendRegistry().register(fake);
const contexts = [];
const contextBuilder = new DelegationContextBuilder({
  repoRoot,
  buildRoleContext: (_root, role) => `prepared identity + allowed memory for ${role}`,
});
const originalBuild = contextBuilder.build.bind(contextBuilder);
contextBuilder.build = (input) => { const value = originalBuild(input); contexts.push(value); return value; };
const store = memoryStore();
const events = [];
const service = new DelegationService({
  roleRegistry: new RoleRegistry(repoRoot),
  policy: new DelegationPolicy(),
  contextBuilder,
  backendRegistry: registry,
  executionStore: store,
  config: { backend: "fake", fallbackBackend: null },
  logger: (event, fields) => events.push({ event, fields }),
});

// Policy edges from the real loadouts.
const search = service.delegate(input("main", "search"));
assert.strictEqual(search.status, "running");
service.delegate(input("main", "review"));
assert.strictEqual(fake.calls.filter((call) => call.method === "spawn").length, 2);

assert.throws(() => service.delegate(input("search", "review")), UnauthorizedDelegation);
assert.throws(() => service.delegate(input("review", "search")), UnauthorizedDelegation);
assert.throws(() => service.delegate(input("search", "main")), UnauthorizedDelegation);
assert.throws(() => service.delegate(input("main", "unknown-role")), UnknownRole);
assert.strictEqual(
  fake.calls.filter((call) => call.method === "spawn").length,
  2,
  "ACL phải deny trước backend.spawn"
);
assert.strictEqual(
  fake.calls.filter((call) => call.method === "healthCheck").length,
  0,
  "deny không được chạm cả backend health"
);

assert(contexts[0].roleContext.includes("for search"), "context phải build theo target role");
assert(contexts[0].prompt.includes("ALP Delegation API"));
assert(contexts[0].prompt.includes("Không gọi trực tiếp runtime-specific delegation"));
assert(contexts[0].prompt.includes("ALP-prepared test context"));
assert(contexts[0].prompt.includes(`# WORKSPACE CỦA EXECUTION\n\n${repoRoot}`));
assert(contexts[0].prompt.includes("source workspace duy nhất"));
assert(contexts[0].prompt.includes("principal tương tác trực tiếp"));
assert.strictEqual(contexts[0].sandbox, "read-only");
assert.strictEqual(fake.calls.find((call) => call.method === "spawn").request.target.role, "search");
assert.strictEqual(
  Object.hasOwn(fake.calls.find((call) => call.method === "spawn").request.request, "context"),
  false,
  "backend không được nhận raw request context"
);
assert(events.some((entry) => entry.event === "delegation.authorized"));
assert(events.filter((entry) => entry.event === "delegation.denied").length >= 3);

const mainContext = contextBuilder.build({
  parent: { role: "principal", name: "Principal", delegates_to: ["main"] },
  target: new RoleRegistry(repoRoot).get("main"),
  task: "principal task",
  workspace: repoRoot,
});
assert(mainContext.prompt.includes("Trao đổi và trả kết quả trực tiếp cho principal"));
assert(!mainContext.prompt.includes("không giao tiếp trực tiếp với principal"));

const waited = service.wait(search.executionId);
assert.strictEqual(waited.status, "completed");
assert.strictEqual(waited.output, "fake output");
service.cancel(search.executionId);
service.cleanup(search.executionId);

// Registry selection is centralized, not an if/else in business code.
const second = new FakeDelegationBackend("second");
registry.register(second);
service.config.backend = "second";
service.delegate(input("main", "search"));
assert.strictEqual(second.calls.filter((call) => call.method === "spawn").length, 1);

// Explicit fallback is resolved only before spawn. The unhealthy backend never receives
// the request, avoiding duplicate executions after a partial spawn.
const unavailable = new FakeDelegationBackend("unavailable", {
  health: { ok: false, status: "unavailable", message: "offline" },
});
const fallback = new FakeDelegationBackend("fallback");
const fallbackRegistry = new DelegationBackendRegistry().register(unavailable).register(fallback);
const fallbackService = new DelegationService({
  roleRegistry: new RoleRegistry(repoRoot),
  policy: new DelegationPolicy(),
  contextBuilder,
  backendRegistry: fallbackRegistry,
  executionStore: memoryStore(),
  config: { backend: "unavailable", fallbackBackend: "fallback" },
  logger: () => {},
});
fallbackService.delegate(input("main", "search"));
assert.strictEqual(unavailable.calls.filter((call) => call.method === "spawn").length, 0);
assert.strictEqual(fallback.calls.filter((call) => call.method === "spawn").length, 1);

// Config defaults preserve Herdr; nested YAML and env override select Paseo without
// changing core or role configuration.
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "alp-delegation-config-"));
const configFile = path.join(configDir, "alp.config.yaml");
const defaults = loadDelegationConfig(repoRoot, {
  ALP_CONFIG: path.join(configDir, "missing.yaml"),
  HOME: configDir,
});
assert.strictEqual(defaults.backend, "herdr");
fs.writeFileSync(configFile, [
  "delegation:",
  "  backend: paseo",
  "  backends:",
  "    herdr:",
  "      enabled: true",
  "    paseo:",
  "      enabled: true",
  "      host: http://127.0.0.1:6767",
].join("\n"));
const loaded = loadDelegationConfig(repoRoot, { ALP_CONFIG: configFile, HOME: configDir });
assert.strictEqual(loaded.backend, "paseo");
assert.strictEqual(loaded.backends.paseo.host, "http://127.0.0.1:6767");
const overridden = loadDelegationConfig(repoRoot, {
  ALP_CONFIG: configFile,
  ALP_DELEGATION_BACKEND: "herdr",
  HOME: configDir,
});
assert.strictEqual(overridden.backend, "herdr");
writeBackendSelection(overridden.stateDir, "paseo");
const switched = loadDelegationConfig(repoRoot, {
  ALP_CONFIG: configFile,
  ALP_DELEGATION_BACKEND: "herdr",
  HOME: configDir,
});
assert.strictEqual(switched.backend, "paseo", "interactive switch phải thắng session default");
assert.strictEqual(switched.backendSource, "switch");
clearBackendSelection(switched.stateDir);
const reset = loadDelegationConfig(repoRoot, {
  ALP_CONFIG: configFile,
  ALP_DELEGATION_BACKEND: "herdr",
  HOME: configDir,
});
assert.strictEqual(reset.backend, "herdr");
assert.strictEqual(reset.backendSource, "environment");
fs.rmSync(configDir, { recursive: true, force: true });

console.log("OK               delegation core: exact policy · context · registry · FakeBackend");

function input(parentRole, targetRole) {
  return {
    parentRole,
    targetRole,
    task: "probe task",
    context: { source: "ALP-prepared test context" },
    workspace: repoRoot,
    executionOptions: { background: true },
  };
}

function memoryStore() {
  const data = new Map();
  return {
    get: (id) => data.get(id) || null,
    put: (record) => { data.set(record.executionId, { ...record }); return record; },
    update: (id, patch) => {
      const next = { ...(data.get(id) || {}), ...patch, executionId: id };
      data.set(id, next);
      return next;
    },
    list: () => [...data.values()],
  };
}

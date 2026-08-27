#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { DelegationBackendRegistry } = require("./lib/delegation/core/backend-registry.cjs");
const { RoleRegistry } = require("./lib/delegation/core/role-registry.cjs");
const { DelegationPolicy } = require("./lib/delegation/core/policy.cjs");
const { DelegationContextBuilder } = require("./lib/delegation/core/context-builder.cjs");
const { DelegationService } = require("./lib/delegation/core/service.cjs");
const { HerdrBackend } = require("./lib/delegation/backends/herdr/backend.cjs");
const { PaseoBackend } = require("./lib/delegation/backends/paseo/backend.cjs");
const { BackendUnavailable } = require("./lib/delegation/core/errors.cjs");
const TEMP_DIRS = [];
process.on("exit", () => TEMP_DIRS.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

testHerdr();
testHerdrForegroundCompatibility();
testHerdrLegacyOrphanMapping();
testPaseo();
testPaseoClaudeMode();
testPaseoUnsafeConfig();
testPaseoConnectionError();
testPaseoServiceIntegration();
testAlpFacadePreservesCallerWorkspace();
testBackendSwitchCli();
console.log("OK               delegation backends: Herdr + Paseo mapping · mocked integration");

function testHerdr() {
  const calls = [];
  const state = memoryStore();
  state.put({ executionId: "exec_parent_herdr", runtimeId: "w1:p1", status: "running" });
  const runtime = {
    available: () => ({ ok: true, version: "0.8.0" }),
    spawn: (input) => { calls.push(["spawn", input]); return { pane: "w1:p2", label: "search-x" }; },
    status: () => ({ status: "running" }),
    wait: () => ({ status: "completed" }),
    output: () => "herdr result",
    cancel: (id) => calls.push(["cancel", id]),
    cleanup: (id) => calls.push(["cleanup", id]),
    orphans: () => [],
  };
  const backend = new HerdrBackend({
    repoRoot: process.cwd(),
    stateDir: "/unused",
    runtime,
    state,
    logger: () => {},
    launchBuilder: () => ({ runtimeKind: "codex", argv: ["exec", "probe"] }),
  });
  const input = backendInput("exec_herdr");
  input.request.parentExecutionId = "exec_parent_herdr";
  const spawned = backend.spawn(input);
  assert.deepStrictEqual(spawned, { executionId: "exec_herdr", status: "running", metadata: { mode: "background" } });
  assert(!JSON.stringify(spawned).includes("w1:p2"), "public result không lộ pane ID");
  assert.strictEqual(backend.status("exec_herdr").status, "running");
  assert.strictEqual(backend.wait("exec_herdr").output, "herdr result");
  backend.cancel("exec_herdr");
  backend.cleanup("exec_herdr");
  assert(calls.some(([name, id]) => name === "cancel" && id === "w1:p2"));
  assert(calls.some(([name, id]) => name === "cleanup" && id === "w1:p2"));
  assert.strictEqual(calls[0][1].env.ALP_DELEGATED_ROLE, "search");
  assert.strictEqual(calls[0][1].env.ALP_DELEGATION_WORKSPACE, process.cwd());
  assert.strictEqual(calls[0][1].env.ALP_READONLY_DIRS, process.cwd());
  assert.strictEqual(calls[0][1].anchor, "w1:p1", "parent ALP execution phải map sang anchor pane trong adapter");

  const claudeLaunch = backend.buildLaunch(
    { role: "search" },
    { ...backendInput("exec_launch").context, prompt: "probe" },
    { interactive: false },
    "claude"
  );
  assert.deepStrictEqual(
    claudeLaunch.argv.slice(2, 4),
    ["--permission-mode", "plan"],
    "Herdr/Claude subordinate phải chạy read-only plan mode"
  );
}

function testPaseo() {
  const calls = [];
  const runnerCalls = [];
  const runner = (args, options) => {
    calls.push(args);
    runnerCalls.push({ args, options });
    if (args[0] === "daemon") return response({ localDaemon: "running", connectedDaemon: "reachable" });
    if (args[0] === "run") return response({ agentId: "paseo-agent-raw", status: "running" });
    if (args[0] === "inspect") return response({ Id: "paseo-agent-raw", Status: "running" });
    if (args[0] === "wait") return response({ agentId: "paseo-agent-raw", status: "idle", message: "done" });
    if (args[0] === "logs") return { status: 0, stdout: "paseo result\n", stderr: "", error: null };
    if (args[0] === "stop") return response({ stoppedCount: 1, agentIds: ["paseo-agent-raw"] });
    if (args[0] === "agent") return response({ agentId: "paseo-agent-raw", status: "archived" });
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  const state = memoryStore();
  state.put({ executionId: "exec_parent_paseo", runtimeId: "paseo-parent-raw", status: "running" });
  const backend = new PaseoBackend({
    config: { cli: "paseo", host: null, runtimeToolsDisabled: true, home: tempPaseoHome(false) },
    stateDir: "/unused",
    state,
    runner,
    logger: () => {},
  });
  assert.strictEqual(backend.healthCheck().ok, true);
  assert.strictEqual(
    runnerCalls.find((call) => call.args[0] === "daemon").options.timeoutMs,
    15000,
    "Paseo cold health check cần đủ thời gian đánh thức daemon"
  );
  const input = backendInput("exec_paseo");
  input.request.parentExecutionId = "exec_parent_paseo";
  const spawned = backend.spawn(input);
  assert.strictEqual(spawned.status, "running");
  assert(!JSON.stringify(spawned).includes("paseo-agent-raw"), "public result không lộ Paseo agent ID");
  const run = calls.find((args) => args[0] === "run");
  assert(run.includes("ALP_DELEGATED_ROLE=search"));
  assert(run.includes("alp.execution-id=exec_paseo"));
  assert.strictEqual(run[run.indexOf("--mode") + 1], "auto", "Paseo 0.5.x Codex phải dùng mode hợp lệ");
  assert(run.includes(`ALP_DELEGATION_WORKSPACE=${process.cwd()}`));
  assert(run.includes(`ALP_READONLY_DIRS=${process.cwd()}`));
  assert(run.at(-1).includes("prepared role context"), "Paseo chỉ nhận context ALP đã build");
  const runOptions = runnerCalls.find((call) => call.args[0] === "run").options;
  assert.strictEqual(
    runOptions.env.PASEO_AGENT_ID,
    "paseo-parent-raw",
    "parent ALP execution phải map sang Paseo parent agent chỉ trong adapter"
  );
  assert.strictEqual(backend.status("exec_paseo").status, "running");
  assert.strictEqual(backend.wait("exec_paseo").output, "paseo result");
  backend.cancel("exec_paseo");
  backend.cleanup("exec_paseo");
  assert(calls.some((args) => args[0] === "stop"));
  assert(calls.some((args) => args[0] === "agent" && args[1] === "archive"));
}

function testHerdrForegroundCompatibility() {
  const backend = new HerdrBackend({
    repoRoot: process.cwd(),
    stateDir: "/unused",
    runtime: {
      available: () => ({ ok: false, reason: "fleet absent" }),
      orphans: () => [],
    },
    state: memoryStore(),
    logger: () => {},
    launchBuilder: () => ({ runtimeKind: "codex", argv: ["exec", "probe"] }),
    spawnProcess: (_bin, _args, options) => ({
      status: 0,
      stdout: "foreground result\n",
      stderr: "",
      env: options.env,
    }),
  });
  const input = backendInput("exec_herdr_foreground");
  input.request.executionOptions.background = true;
  const completed = backend.spawn(input);
  assert.strictEqual(completed.status, "completed");
  assert.strictEqual(completed.output, "foreground result");
  assert.strictEqual(completed.metadata.fallback, "foreground");
}

function testHerdrLegacyOrphanMapping() {
  const cleaned = [];
  const backend = new HerdrBackend({
    repoRoot: process.cwd(),
    stateDir: "/unused",
    state: memoryStore(),
    runtime: {
      available: () => ({ ok: true, version: "0.8.0" }),
      orphans: () => [{ pane: "w9:p9", agent: "legacy-search", status: "working" }],
      cleanup: (runtimeId) => cleaned.push(runtimeId),
    },
    logger: () => {},
  });
  const orphans = backend.orphanExecutions();
  assert(orphans[0].executionId.startsWith("exec_legacy_"));
  assert(!JSON.stringify(orphans).includes("w9:p9"), "doctor không được expose legacy pane ID");
  backend.cleanup(orphans[0].executionId);
  assert.deepStrictEqual(cleaned, ["w9:p9"]);
}

function testPaseoUnsafeConfig() {
  const backend = new PaseoBackend({
    config: { cli: "paseo", runtimeToolsDisabled: true, home: tempPaseoHome(true) },
    stateDir: "/unused",
    state: memoryStore(),
    runner: () => { throw new Error("runner must not be called"); },
  });
  assert.strictEqual(backend.healthCheck().status, "unsafe");
  assert.throws(() => backend.spawn(backendInput("exec_unsafe")), BackendUnavailable);
}

function testPaseoClaudeMode() {
  const calls = [];
  const backend = new PaseoBackend({
    config: { cli: "paseo", runtimeToolsDisabled: true, home: tempPaseoHome(false) },
    stateDir: "/unused",
    state: memoryStore(),
    runner: (args) => {
      calls.push(args);
      return response({ agentId: "claude-agent", status: "running" });
    },
    logger: () => {},
  });
  const input = backendInput("exec_claude");
  input.request.executionOptions.runtime = "claude";
  backend.spawn(input);
  const run = calls[0];
  assert.strictEqual(run[run.indexOf("--mode") + 1], "plan", "Claude read-only phải map sang plan");
}

function testPaseoConnectionError() {
  const state = memoryStore();
  state.put({ executionId: "exec_disconnected", runtimeId: "agent-x", status: "running" });
  const backend = new PaseoBackend({
    config: { cli: "paseo", runtimeToolsDisabled: true, home: tempPaseoHome(false) },
    stateDir: "/unused",
    state,
    runner: () => ({
      status: null,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    }),
  });
  assert.throws(() => backend.status("exec_disconnected"), BackendUnavailable);
}

function testPaseoServiceIntegration() {
  const backend = new PaseoBackend({
    config: { cli: "paseo", runtimeToolsDisabled: true, home: tempPaseoHome(false) },
    stateDir: "/unused",
    state: memoryStore(),
    runner: (args) => {
      if (args[0] === "run") return response({ agentId: "integration-agent", status: "running" });
      if (args[0] === "wait") return response({ agentId: "integration-agent", status: "idle", message: "done" });
      if (args[0] === "logs") return { status: 0, stdout: "integrated result\n", stderr: "", error: null };
      throw new Error(`unexpected integration command: ${args.join(" ")}`);
    },
    logger: () => {},
  });
  const service = new DelegationService({
    roleRegistry: new RoleRegistry(process.cwd()),
    policy: new DelegationPolicy(),
    contextBuilder: new DelegationContextBuilder({
      repoRoot: process.cwd(),
      buildRoleContext: (_root, role) => `identity and allowed memory for ${role}`,
    }),
    backendRegistry: new DelegationBackendRegistry().register(backend),
    executionStore: memoryStore(),
    config: { backend: "paseo", fallbackBackend: null },
    logger: () => {},
  });
  const spawned = service.delegate({
    parentRole: "main",
    targetRole: "search",
    task: "integration probe",
    workspace: process.cwd(),
    executionOptions: { background: true, runtime: "codex" },
  });
  assert(spawned.executionId.startsWith("exec_"));
  assert(!JSON.stringify(spawned).includes("integration-agent"));
  const completed = service.wait(spawned.executionId);
  assert.strictEqual(completed.status, "completed");
  assert.strictEqual(completed.output, "integrated result");
}

function testAlpFacadePreservesCallerWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alp-delegate-cwd-"));
  TEMP_DIRS.push(dir);
  const project = path.join(dir, "caller-project");
  const stateDir = path.join(dir, "state");
  const paseoHome = path.join(dir, "paseo-home");
  const capture = path.join(dir, "args.json");
  const fakeCli = path.join(dir, "fake-paseo.cjs");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(paseoHome, { recursive: true });
  fs.writeFileSync(fakeCli, [
    "#!/usr/bin/env node",
    'const fs = require("fs");',
    "const args = process.argv.slice(2);",
    'fs.writeFileSync(process.env.ALP_TEST_PASEO_CAPTURE, JSON.stringify(args));',
    'process.stdout.write(JSON.stringify({ agentId: "fake-agent", status: "running" }));',
  ].join("\n") + "\n");
  fs.chmodSync(fakeCli, 0o755);

  const run = spawnSync(process.execPath, [
    path.join(process.cwd(), "scripts", "alp.cjs"),
    "delegate", "search", "--backend", "paseo", "--background", "--", "cwd probe",
  ], {
    cwd: project,
    encoding: "utf8",
    env: {
      ...process.env,
      PASEO_CLI: fakeCli,
      PASEO_HOME: paseoHome,
      ALP_DELEGATION_STATE_DIR: stateDir,
      ALP_TEST_PASEO_CAPTURE: capture,
    },
  });
  assert.strictEqual(run.status, 0, run.stderr || run.stdout);
  const args = JSON.parse(fs.readFileSync(capture, "utf8"));
  assert.strictEqual(args[args.indexOf("--cwd") + 1], fs.realpathSync(project));
  const promptPointer = args.at(-1).match(/^ALP execution input is in (.+); read it before continuing\.$/);
  assert(promptPointer, "Paseo phải nhận con trỏ prompt runtime ổn định");
  assert(
    fs.readFileSync(promptPointer[1], "utf8").includes(fs.realpathSync(project)),
    "prepared prompt artifact phải pin caller workspace",
  );
}

function testBackendSwitchCli() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alp-backend-switch-"));
  TEMP_DIRS.push(dir);
  const stateDir = path.join(dir, "state");
  const paseoHome = path.join(dir, "paseo-home");
  const fakeCli = path.join(dir, "fake-paseo.cjs");
  fs.mkdirSync(paseoHome, { recursive: true });
  fs.writeFileSync(fakeCli, [
    "#!/usr/bin/env node",
    'process.stdout.write(JSON.stringify({ localDaemon: "running", connectedDaemon: "reachable", daemonVersion: "test" }));',
  ].join("\n") + "\n");
  fs.chmodSync(fakeCli, 0o755);
  const env = {
    ...process.env,
    ALP_DELEGATION_BACKEND: "herdr",
    ALP_DELEGATION_STATE_DIR: stateDir,
    PASEO_CLI: fakeCli,
    PASEO_HOME: paseoHome,
  };
  const alp = (...args) => spawnSync(process.execPath, [
    path.join(process.cwd(), "scripts", "alp.cjs"), "delegation", ...args,
  ], { cwd: dir, env, encoding: "utf8" });

  const switched = alp("switch", "paseo");
  assert.strictEqual(switched.status, 0, switched.stderr || switched.stdout);
  assert.match(switched.stdout, /^backend\s+paseo$/m);
  assert.match(switched.stdout, /^source\s+switch$/m);
  const current = alp("switch");
  assert.match(current.stdout, /^backend\s+paseo$/m);
  const reset = alp("switch", "default");
  assert.strictEqual(reset.status, 0, reset.stderr || reset.stdout);
  assert.match(reset.stdout, /^backend\s+herdr$/m);
  assert.match(reset.stdout, /^source\s+environment$/m);
}

function backendInput(executionId) {
  return {
    executionId,
    request: {
      requestId: "req_test",
      parentRole: "main",
      targetRole: "search",
      task: "probe",
      executionOptions: { background: true, runtime: "codex", timeoutMs: null },
    },
    target: { role: "search", model: "gpt-test", reasoning_effort: "low" },
    context: {
      parentRole: "main",
      targetRole: "search",
      workspace: process.cwd(),
      sandbox: "read-only",
      roleContext: "prepared role context",
      prompt: "prepared task",
    },
  };
}

function response(data) { return { status: 0, stdout: JSON.stringify(data), stderr: "", error: null }; }
function memoryStore() {
  const data = new Map();
  return {
    get: (id) => data.get(id) || null,
    put: (record) => { data.set(record.executionId, { ...record }); return record; },
    update: (id, patch) => { const next = { ...data.get(id), ...patch }; data.set(id, next); return next; },
    list: () => [...data.values()],
  };
}
function tempPaseoHome(unsafe) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alp-paseo-config-"));
  TEMP_DIRS.push(dir);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ daemon: { mcp: { injectIntoAgents: unsafe } } }));
  return dir;
}

#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { PaseoBackend } = require("./lib/delegation/backends/paseo/backend.cjs");
const { resolveWindowsCommand, spawnSyncCommand } = require("./lib/delegation/backends/command-runner.cjs");
const { BackendUnavailable } = require("./lib/delegation/core/errors.cjs");
const TEMP_DIRS = [];
process.on("exit", () => TEMP_DIRS.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

testPaseo();
testPaseoClaudeMode();
testPaseoUnsafeConfig();
testPaseoConnectionError();
testAlpFacadePreservesCallerWorkspace();
testBackendSwitchCli();
testWindowsCommandShim();
console.log("OK               delegation backends: Paseo mapping · command shim · switch CLI");

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
      ALP_SKIP_UPDATE_CHECK: "1",
    },
  });
  assert.strictEqual(run.status, 0, run.stderr || run.stdout);
  const args = JSON.parse(fs.readFileSync(capture, "utf8"));
  // Windows paths compare case-insensitively, and `realpath` can report `%TEMP%` with a
  // different case in the child than in this process — which says nothing about the
  // workspace being preserved, the only thing under test here.
  const samePath = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  assert.strictEqual(samePath(args[args.indexOf("--cwd") + 1]), samePath(fs.realpathSync(project)));
  const taskPointer = args.at(-1).match(/^ALP task is in (.+); execute it\.$/);
  assert(taskPointer, "Paseo phải nhận con trỏ task runtime ổn định");
  // Workspace được pin trong session context, không phải trong task: task chỉ mang việc
  // cần làm, còn agent là ai và được đụng vào đâu thuộc về cả phiên. Paseo nhận đường dẫn
  // đó qua `--env`, nên kiểm luôn được là kênh session context tới được backend này.
  const sessionContextEnv = args.find((value) => value.startsWith("ALP_SESSION_CONTEXT="));
  assert(sessionContextEnv, "Paseo phải nhận ALP_SESSION_CONTEXT");
  assert(
    samePath(fs.readFileSync(sessionContextEnv.slice("ALP_SESSION_CONTEXT=".length), "utf8"))
      .includes(samePath(fs.realpathSync(project))),
    "prepared session context phải pin caller workspace",
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
    ALP_DELEGATION_BACKEND: "local",
    ALP_DELEGATION_STATE_DIR: stateDir,
    PASEO_CLI: fakeCli,
    PASEO_HOME: paseoHome,
    ALP_SKIP_UPDATE_CHECK: "1",
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
  assert.match(reset.stdout, /^backend\s+local$/m);
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

/**
 * `command-runner.cjs` is the only thing standing between an npm-generated Windows shim
 * and Node's refusal to spawn a `.cmd` directly, so it is covered here rather than left
 * behind with the interactive installer that used to own this test.
 */
function testWindowsCommandShim() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alp-windows-command-"));
  TEMP_DIRS.push(root);
  const shim = path.join(root, "fake-tool.cmd");
  const npmBin = path.join(root, "AppData", "Roaming", "npm");
  const globalShim = path.join(npmBin, "global-tool.cmd");
  fs.mkdirSync(npmBin, { recursive: true });
  fs.writeFileSync(shim, [
    "@echo off",
    "SET _prog=node",
    '"%_prog%" "%dp0%\\fake-tool.cjs" %*',
    "",
  ].join("\r\n"));
  fs.writeFileSync(path.join(root, "fake-tool.cjs"), "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  fs.writeFileSync(globalShim, "@echo off\r\necho global-tool %1\r\n");
  const env = { ...process.env, PATH: root, PATHEXT: ".EXE;.CMD" };

  assert.strictEqual(
    resolveWindowsCommand("fake-tool", env).toLowerCase(),
    shim.toLowerCase(),
    "PATHEXT phải tìm ra npm-style .cmd shim",
  );
  // npm's per-user global bin is often missing from an already-open terminal's PATH.
  const isolated = { PATH: root, PATHEXT: ".EXE;.CMD", APPDATA: path.dirname(npmBin) };
  assert.strictEqual(
    resolveWindowsCommand("global-tool", isolated).toLowerCase(),
    globalShim.toLowerCase(),
    "npm global bin phải được dò kể cả khi ngoài PATH",
  );
  if (process.platform !== "win32") return;

  // argv phải qua nguyên vẹn: một shell sẽ diễn giải lại `&`, `%PATH%` và khoảng trắng.
  const args = ["ready & echo not-a-command", "%PATH%", "value with spaces"];
  const result = spawnSyncCommand("fake-tool", args, { env, encoding: "utf8" }, "win32");
  assert.strictEqual(result.status, 0, result.stderr || result.error?.message);
  assert.deepStrictEqual(JSON.parse(result.stdout), args);
}

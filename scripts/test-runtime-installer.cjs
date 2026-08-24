#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PassThrough } = require("stream");
const {
  PASEO_PACKAGE,
  ensureBackendRuntime,
} = require("./lib/delegation/runtime-installer.cjs");
const {
  resolveWindowsCommand,
  spawnSyncCommand,
} = require("./lib/delegation/backends/command-runner.cjs");
const {
  configureInitBackend,
  promptBackend,
  readTerminalLine,
} = require("./lib/delegation/init-backend.cjs");
const {
  readBackendSelection,
} = require("./lib/delegation/config.cjs");

let failed = 0;
main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  testHerdrAlreadyReady();
  testHerdrInstallAndStart();
  testPaseoInstallAndStart();
  testPaseoStatusIgnoresStderrWarning();
  testPaseoWindowsInstallShell();
  testWindowsCommandShim();
  testCustomPaseoCommandFailsClosed();
  await testPrompt();
  testNonBlockingTerminalRead();
  await testInitSelectionPersistence();
  await testNonInteractiveCompatibility();
  if (failed) process.exit(1);
  console.log("OK               delegation runtime installer + alp init backend selection");
}

function testHerdrAlreadyReady() {
  const fake = fakeRuntime({ herdrInstalled: true, herdrServer: true });
  const result = ensureBackendRuntime("herdr", fake.options());
  check("Herdr đã có → không cài lại", () => {
    assert.strictEqual(result.installed, false);
    assert.strictEqual(result.status, "healthy");
    assert(!fake.calls.some(([command, args]) => command === "brew" && args[0] === "install"));
  });
}

function testHerdrInstallAndStart() {
  const fake = fakeRuntime({ herdrInstalled: false, herdrServer: false });
  const result = ensureBackendRuntime("herdr", fake.options());
  check("Herdr thiếu → cài bằng official Homebrew path", () => {
    assert.strictEqual(result.installed, true);
    assert(fake.calls.some(([command, args]) => command === "brew" && args.join(" ") === "install herdr"));
  });
  check("Herdr được start headless sau install", () => {
    assert.strictEqual(result.status, "healthy");
    assert(fake.launches.some(([command, args]) => command === "herdr" && args[0] === "server"));
  });
}

function testPaseoInstallAndStart() {
  const fake = fakeRuntime({ paseoInstalled: false, paseoDaemon: false });
  const result = ensureBackendRuntime("paseo", fake.options({ backendConfig: { cli: "paseo" } }));
  check("Paseo thiếu → npm install package chính thức", () => {
    assert.strictEqual(result.installed, true);
    assert(fake.calls.some(([command, args]) =>
      command === "npm" && args.join(" ") === `install -g ${PASEO_PACKAGE}`));
  });
  check("Paseo daemon start không inject raw MCP tools", () => {
    const start = fake.calls.find(([command, args]) => command === "paseo" && args.slice(0, 2).join(" ") === "daemon start");
    assert(start, "không start Paseo daemon");
    assert(start[1].includes("--no-inject-mcp"));
    assert(start[1].includes("--no-relay"));
    assert.strictEqual(result.status, "healthy");
  });
}

function testPaseoStatusIgnoresStderrWarning() {
  const fake = fakeRuntime({
    paseoInstalled: true,
    paseoDaemon: true,
    paseoStatusStderr: "Warning: Ignoring extra certs from missing.pem\n",
  });
  const result = ensureBackendRuntime("paseo", fake.options({ backendConfig: { cli: "paseo" } }));
  check("Paseo status JSON bỏ qua warning trên stderr", () => {
    assert.strictEqual(result.status, "healthy");
    assert(!fake.calls.some(([, args]) => args.join(" ").startsWith("daemon start")));
  });
}

function testPaseoWindowsInstallShell() {
  const fake = fakeRuntime({ paseoInstalled: false, paseoDaemon: true });
  ensureBackendRuntime("paseo", fake.options({
    platform: "win32",
    env: { PATH: "C:\\node", PATHEXT: ".EXE;.CMD", ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    backendConfig: { cli: "paseo" },
  }));
  check("Windows npm lifecycle dùng cmd thay vì user script-shell", () => {
    const install = fake.calls.find(([command, args]) =>
      command === "npm.cmd" && args.join(" ") === `install -g ${PASEO_PACKAGE}`);
    assert(install, "không gọi npm.cmd install");
    assert.strictEqual(install[2].env.npm_config_script_shell, "C:\\Windows\\System32\\cmd.exe");
  });
}

function testWindowsCommandShim() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alp-windows-command-"));
  const shim = path.join(root, "fake-tool.cmd");
  const shimTarget = path.join(root, "fake-tool.cjs");
  const npmBin = path.join(root, "AppData", "Roaming", "npm");
  const globalShim = path.join(npmBin, "global-tool.cmd");
  fs.mkdirSync(npmBin, { recursive: true });
  fs.writeFileSync(shim, [
    "@echo off",
    "SET _prog=node",
    '"%_prog%" "%dp0%\\fake-tool.cjs" %*',
    "",
  ].join("\r\n"));
  fs.writeFileSync(shimTarget, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  fs.writeFileSync(globalShim, "@echo off\r\necho global-tool %1\r\n");
  const env = { ...process.env, PATH: root, PATHEXT: ".EXE;.CMD" };
  try {
    check("Windows PATHEXT resolve npm-style .cmd shim", () => {
      assert.strictEqual(resolveWindowsCommand("fake-tool", env).toLowerCase(), shim.toLowerCase());
    });
    check("Windows resolve npm-global shim ngoài PATH", () => {
      const isolated = { PATH: root, PATHEXT: ".EXE;.CMD", APPDATA: path.dirname(npmBin) };
      assert.strictEqual(resolveWindowsCommand("global-tool", isolated).toLowerCase(), globalShim.toLowerCase());
    });
    if (process.platform === "win32") {
      const args = ["ready & echo not-a-command", "%PATH%", "value with spaces"];
      const result = spawnSyncCommand("fake-tool", args, { env, encoding: "utf8" }, "win32");
      check("Windows Node chạy được npm-style .cmd shim", () => {
        assert.strictEqual(result.status, 0, result.stderr || result.error?.message);
        assert.deepStrictEqual(JSON.parse(result.stdout), args);
      });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testCustomPaseoCommandFailsClosed() {
  const fake = fakeRuntime({ paseoInstalled: false });
  check("PASEO_CLI custom bị thiếu → không tự cài sang path khác", () => {
    assert.throws(
      () => ensureBackendRuntime("paseo", fake.options({ backendConfig: { cli: "/custom/paseo" } })),
      /trỏ tới lệnh không tồn tại/
    );
    assert(!fake.calls.some(([command, args]) => command === "npm" && args[0] === "install"));
  });
}

async function testPrompt() {
  const answers = ["wat", "2"];
  let output = "";
  const selected = await promptBackend({
    input: {},
    output: { write(value) { output += value; } },
    enabled: ["herdr", "paseo"],
    current: "herdr",
    readLine: () => answers.shift(),
  });
  check("prompt chấp nhận số và retry input sai", () => {
    assert.strictEqual(selected, "paseo");
    assert(output.includes("Không hợp lệ"));
    assert(output.includes("Herdr"));
    assert(output.includes("Paseo"));
  });

  const rawModes = [];
  const keys = ["down", "enter"];
  let arrowOutput = "";
  const arrowSelected = await promptBackend({
    input: {
      fd: 7,
      isTTY: true,
      isRaw: false,
      setRawMode(value) { rawModes.push(value); },
    },
    output: { isTTY: true, write(value) { arrowOutput += value; } },
    enabled: ["herdr", "paseo"],
    current: "herdr",
    readKey: () => keys.shift(),
  });
  check("prompt TTY dùng phím lên/xuống và khôi phục raw mode", () => {
    assert.strictEqual(arrowSelected, "paseo");
    assert.deepStrictEqual(rawModes, [true, false]);
    assert(arrowOutput.includes("↑/↓ chọn"));
    assert(arrowOutput.includes("\x1b[?25h"));
  });

  const streamRawModes = [];
  const streamInput = new PassThrough();
  streamInput.isTTY = true;
  streamInput.isRaw = false;
  streamInput.setRawMode = (value) => {
    streamInput.isRaw = value;
    streamRawModes.push(value);
  };
  let streamOutput = "";
  const streamTerminal = {
    isTTY: true,
    write(value) { streamOutput += value; return true; },
  };
  // Windows Console/ConPTY can deliver Down + Enter in one input chunk. The keypress
  // queue must retain Enter while the menu redraws after Down.
  setImmediate(() => streamInput.write("\x1b[B\r"));
  const streamSelected = await promptBackend({
    input: streamInput,
    output: streamTerminal,
    enabled: ["herdr", "paseo"],
    current: "herdr",
  });
  check("Node keypress decoder nhận Down + Enter cùng chunk kiểu Windows", () => {
    assert.strictEqual(streamSelected, "paseo");
    assert.deepStrictEqual(streamRawModes, [true, false]);
    assert(streamOutput.includes("Paseo"));
    assert.strictEqual(streamInput.listenerCount("data"), 0, "còn sót decoder listener trên stdin");
    assert.strictEqual(streamInput.isPaused(), true, "stdin vẫn flowing làm alp init không thoát prompt");
  });
}

function testNonBlockingTerminalRead() {
  const bytes = ["2", "\n"].map((value) => Buffer.from(value));
  let reads = 0;
  let pauses = 0;
  const line = readTerminalLine({ fd: 7 }, {
    read(_fd, target) {
      reads++;
      if (reads === 1) throw Object.assign(new Error("temporarily unavailable"), { code: "EAGAIN" });
      bytes.shift().copy(target);
      return 1;
    },
    pause() { pauses++; },
  });
  check("TTY non-blocking EAGAIN được chờ rồi đọc tiếp", () => {
    assert.strictEqual(line, "2");
    assert.strictEqual(pauses, 1);
    assert.strictEqual(reads, 3);
  });
}

async function testInitSelectionPersistence() {
  await withConfig(async (fixture) => {
    const ensured = [];
    const result = await configureInitBackend({
      repoRoot: fixture.repo,
      env: fixture.env,
      requested: "paseo",
      interactive: false,
      output: sink(),
      ensureRuntime: (backend) => { ensured.push(backend); return { status: "healthy" }; },
      healthCheck: (backend) => ({ ok: true, status: "healthy", message: `${backend} ready` }),
    });
    check("--backend persist default chỉ sau runtime + adapter health", () => {
      assert.strictEqual(result.backend, "paseo");
      assert.deepStrictEqual(ensured, ["paseo"]);
      assert.strictEqual(readBackendSelection(fixture.state), "paseo");
    });
  });
}

async function testNonInteractiveCompatibility() {
  await withConfig(async (fixture) => {
    let called = false;
    const result = await configureInitBackend({
      repoRoot: fixture.repo,
      env: fixture.env,
      interactive: false,
      output: sink(),
      ensureRuntime: () => { called = true; },
      healthCheck: () => { called = true; },
    });
    check("init non-TTY không âm thầm cài package", () => {
      assert.strictEqual(result.backend, "herdr");
      assert.strictEqual(result.selected, false);
      assert.strictEqual(called, false);
      assert.strictEqual(readBackendSelection(fixture.state), null);
    });
  });
}

function fakeRuntime(initial = {}) {
  const state = { brew: true, npm: true, ...initial };
  const calls = [];
  const launches = [];
  const run = (command, args, options = {}) => {
    calls.push([command, [...args], options]);
    if (command === "brew") {
      if (args[0] === "--version") return ok("Homebrew test\n");
      if (args.join(" ") === "install herdr") { state.herdrInstalled = true; return ok(); }
    }
    if (command === "npm" || command === "npm.cmd") {
      if (args[0] === "--version") return ok("10.0.0\n");
      if (args.join(" ") === `install -g ${PASEO_PACKAGE}`) { state.paseoInstalled = true; return ok(); }
      if (args.join(" ") === "prefix -g") return ok("/fake/npm\n");
    }
    if (command === "herdr") {
      if (!state.herdrInstalled) return missing(command);
      if (args[0] === "--version") return ok("herdr 0.8.0\n");
      if (args.join(" ") === "status server")
        return state.herdrServer ? ok("status: running\n") : fail("status: stopped\n");
    }
    if (command === "paseo") {
      if (!state.paseoInstalled) return missing(command);
      if (args[0] === "--version") return ok("0.5.1\n");
      if (args.join(" ") === "daemon status --json")
        return state.paseoDaemon
          ? ok(JSON.stringify({ localDaemon: "running", connectedDaemon: "reachable" }), state.paseoStatusStderr || "")
          : fail(JSON.stringify({ localDaemon: "stopped", connectedDaemon: "unreachable" }));
      if (args[0] === "daemon" && args[1] === "start") { state.paseoDaemon = true; return ok(); }
    }
    if (command === "/custom/paseo") return missing(command);
    return missing(command);
  };
  const launch = (command, args) => {
    launches.push([command, [...args]]);
    if (command === "herdr" && args[0] === "server") state.herdrServer = true;
    return { error: null };
  };
  return {
    calls,
    launches,
    options(extra = {}) {
      return { env: { HOME: "/fake/home", PATH: "/usr/bin" }, platform: "darwin", run, launch, ...extra };
    },
  };
}

async function withConfig(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alp-init-backend-"));
  const repo = path.join(root, "repo");
  const state = path.join(root, "state");
  const config = path.join(root, "alp.config.yaml");
  fs.mkdirSync(repo);
  fs.writeFileSync(config, [
    "delegation:",
    "  backend: herdr",
    `  state_dir: ${state}`,
    "  backends:",
    "    herdr:",
    "      enabled: true",
    "    paseo:",
    "      enabled: true",
    "      runtime_tools_disabled: true",
  ].join("\n") + "\n");
  try { await fn({ repo, state, env: { ...process.env, ALP_CONFIG: config } }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function sink() { return { write() {} }; }
function ok(stdout = "", stderr = "") { return { status: 0, stdout, stderr, error: null }; }
function fail(stderr = "") { return { status: 1, stdout: "", stderr, error: null }; }
function missing(command) {
  return { status: null, stdout: "", stderr: "", error: Object.assign(new Error(`${command}: not found`), { code: "ENOENT" }) };
}

function check(name, fn) {
  try {
    fn();
    console.log(`PASS             ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL             ${name}\n                 ${error.message.split("\n").join("\n                 ")}`);
  }
}

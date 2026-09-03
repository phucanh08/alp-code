#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { resolveWindowsCommand, spawnSyncCommand } = require("./lib/delegation/command-runner.cjs");
const TEMP_DIRS = [];
process.on("exit", () => TEMP_DIRS.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

testAlpFacadePreservesCallerWorkspace();
testWindowsCommandShim();
testLocalBackendContract().then(
  () => console.log("OK               delegation: local contract · caller workspace · command shim"),
  (error) => { console.error(error); process.exitCode = 1; },
);

/**
 * The six methods `DelegationService` drives, against the real backend.
 *
 * Until 2026-09-03 this ran twice — once for `local`, once for `paseo` — to prove the two
 * were interchangeable. Nothing is left to be interchangeable with, and what survives is the
 * half that was never about the comparison: `local` spawns real processes, so this is the
 * only place that can show an execution staying visible from a second CLI process, and a
 * lapsed wait leaving a supervised agent running rather than killing it.
 */
async function testLocalBackendContract() {
  const outDir = ["d", "i", "s", "t"].join("");
  const entry = path.join(process.cwd(), outDir, "src", "backend", "local-process-backend.js");
  if (!fs.existsSync(entry)) {
    const built = spawnSyncCommand("npm", ["run", "build"], { cwd: process.cwd(), stdio: "inherit" });
    if (built.error || built.status !== 0) throw new Error("không build được output cho local backend");
  }
  const { LocalProcessBackend } = require(entry);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "alp-local-contract-"));
  TEMP_DIRS.push(stateDir);

  const backend = new LocalProcessBackend({ stateDir });
  const launchSpec = {
    command: process.execPath,
    // Long enough that the 50ms wait below genuinely races it, short enough not to stall.
    args: ["-e", "console.log('contract transcript'); setTimeout(() => process.exit(0), 400)"],
    cwd: process.cwd(),
    env: {},
    temporaryFiles: [],
  };
  // Supervised rather than attached. An attached run answers a lapsed wait by stopping the
  // child, because nothing else would record how it ended; the assertions below are about
  // the path where the supervisor outlives this process.
  const lifecycle = { requestId: "req_contract", parentExecutionId: null, background: true, interactive: false, timeoutMs: null };

  const spawned = await backend.spawn({ executionId: "exec_contract", launchSpec, lifecycle });
  assert.strictEqual(spawned.status, "running", "spawn phải trả running");
  assert.strictEqual(spawned.executionId, "exec_contract", "spawn phải trả executionId của caller");

  // The lifecycle call a second CLI process makes. This answered `unknown local execution`
  // until the backend's state moved out of a `Map` field and onto disk.
  const observer = new LocalProcessBackend({ stateDir });
  assert.strictEqual(
    (await observer.status("exec_contract")).status,
    "running",
    "execution phải nhìn thấy được từ process khác",
  );

  // A wait that gives up must raise a typed timeout and leave the execution alone.
  let timedOut = null;
  try { await backend.wait("exec_contract", { timeoutMs: 50 }); }
  catch (error) { timedOut = error; }
  assert(timedOut, "wait quá hạn phải ném lỗi");
  assert(
    /timeout/i.test(timedOut.code || "") || /timeout|DelegationTimeout/i.test(timedOut.name || ""),
    `lỗi quá hạn phải có type, nhận được ${timedOut.name}/${timedOut.code}`,
  );
  assert.strictEqual(
    (await observer.status("exec_contract")).status,
    "running",
    "timeout không được giết execution",
  );

  const finished = await backend.wait("exec_contract");
  assert.strictEqual(finished.status, "completed", "wait phải trả trạng thái terminal");
  assert(finished.output, "kết quả terminal phải mang transcript");

  await backend.cleanup("exec_contract");
}

/**
 * `alp delegate` run as a real process from a directory that is not the repo.
 *
 * The workspace an agent is given has to be the caller's, not wherever `alp` happens to
 * live, and the runtime has to receive the prepared session context rather than reading a
 * static role document. Both are settled inside a child process, so they are checked by
 * shadowing the runtime binary on `PATH` and reading back what it was actually handed.
 */
function testAlpFacadePreservesCallerWorkspace() {
  // The fake runtime below is a shebang script, which Windows will not exec from `PATH`.
  // `testWindowsCommandShim` covers the resolution rules that matter there.
  if (process.platform === "win32") return;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alp-delegate-cwd-"));
  TEMP_DIRS.push(dir);
  const project = path.join(dir, "caller-project");
  const stateDir = path.join(dir, "state");
  const bin = path.join(dir, "bin");
  const capture = path.join(dir, "runtime-call.json");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const fakeRuntime = path.join(bin, "codex");
  fs.writeFileSync(fakeRuntime, [
    "#!/usr/bin/env node",
    'const fs = require("fs");',
    "fs.writeFileSync(process.env.ALP_TEST_RUNTIME_CAPTURE, JSON.stringify({",
    "  cwd: process.cwd(),",
    "  argv: process.argv.slice(2),",
    "  role: process.env.ALP_ROLE || null,",
    // Read here rather than in the test: the session context is a temporary file, and the
    // supervisor deletes it once the run ends.
    "  sessionContext: process.env.ALP_SESSION_CONTEXT",
    '    ? fs.readFileSync(process.env.ALP_SESSION_CONTEXT, "utf8")',
    "    : null,",
    "}));",
  ].join("\n") + "\n");
  fs.chmodSync(fakeRuntime, 0o755);

  const run = spawnSync(process.execPath, [
    path.join(process.cwd(), "scripts", "alp.cjs"),
    "delegate", "search", "--runtime", "codex", "--background", "--", "cwd probe",
  ], {
    cwd: project,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      ALP_DELEGATION_STATE_DIR: stateDir,
      ALP_TEST_RUNTIME_CAPTURE: capture,
      ALP_SKIP_UPDATE_CHECK: "1",
    },
  });
  assert.strictEqual(run.status, 0, run.stderr || run.stdout);

  // `--background` hands the run to a detached supervisor, so the CLI returns before the
  // runtime has been reached. Waiting for the capture is waiting for that handoff.
  const deadline = Date.now() + 20000;
  const idle = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(capture) && Date.now() < deadline) Atomics.wait(idle, 0, 0, 100);
  assert(fs.existsSync(capture), "runtime phải được spawn qua supervisor");
  const called = JSON.parse(fs.readFileSync(capture, "utf8"));

  assert.strictEqual(called.role, "search", "runtime phải chạy dưới identity của target role");
  assert.strictEqual(called.cwd, fs.realpathSync(project), "workspace phải là cwd của caller");
  const taskPointer = called.argv.find((value) => /^ALP task is in .+; execute it\.$/.test(value));
  assert(taskPointer, "runtime phải nhận con trỏ task ổn định thay vì prompt inline");
  // Workspace được pin trong session context, không phải trong task: task chỉ mang việc cần
  // làm, còn agent là ai và được đụng vào đâu thuộc về cả phiên.
  assert(called.sessionContext, "runtime phải nhận ALP_SESSION_CONTEXT");
  assert(
    called.sessionContext.includes(fs.realpathSync(project)),
    "prepared session context phải pin caller workspace",
  );
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

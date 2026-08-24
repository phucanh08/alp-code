#!/usr/bin/env node
// Runtime-neutral ALP Delegation CLI.

const path = require("path");
const L = require("./lib/loadout.cjs");
const { createDelegationService } = require("./lib/delegation/create-service.cjs");
const {
  loadDelegationConfig,
  writeBackendSelection,
  clearBackendSelection,
} = require("./lib/delegation/config.cjs");

const repoRoot = L.findRepoRoot(__dirname);
if (!repoRoot) die("không tìm thấy repo alp-code");
const args = process.argv.slice(2);
const command = args.shift();
if (!command || ["-h", "--help"].includes(command)) usage(command ? 0 : 2);

const { service, config } = createDelegationService({ repoRoot });

try {
  if (command === "delegate") delegate(args);
  else if (command === "status") show(service.status(required(args, 0, "status thiếu execution id")));
  else if (command === "wait") wait(args);
  else if (command === "cancel") show(service.cancel(required(args, 0, "cancel thiếu execution id")));
  else if (command === "cleanup") show(service.cleanup(required(args, 0, "cleanup thiếu execution id")));
  else if (command === "health") show(service.health(args[0] || config.backend));
  else if (command === "list") show(service.listExecutions());
  else if (["switch", "backend"].includes(command)) switchBackend(args);
  else die(`lệnh lạ \`${command}\``);
} catch (error) {
  die(`${error.code || "DelegationError"}: ${error.message}`);
}

function delegate(argv) {
  const targetRole = argv.shift();
  if (!targetRole) die("delegate thiếu target role");
  let parentRole = process.env.ALP_DELEGATED_ROLE || process.env.ALP_ROLE || "main";
  let workspace = process.cwd();
  let backend = null;
  let runtime = null;
  let background = false;
  let timeoutMs = null;
  let json = false;
  const task = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--parent-role")
      die("`--parent-role` không phải public option; caller identity phải đến từ ALP session");
    else if (["--project", "--workspace"].includes(arg)) workspace = path.resolve(required(argv, ++i, `${arg} thiếu path`));
    else if (arg === "--backend") backend = required(argv, ++i, "--backend thiếu tên");
    else if (["--runtime", "--kind"].includes(arg)) runtime = required(argv, ++i, `${arg} thiếu runtime`);
    else if (arg === "--background") background = true;
    else if (arg === "--timeout-ms") timeoutMs = Number(required(argv, ++i, "--timeout-ms thiếu số"));
    else if (arg === "--json") json = true;
    else if (arg !== "--") task.push(arg);
  }
  if (!task.join(" ").trim()) die("delegate thiếu task");

  let value = service.delegate({
    parentRole,
    parentExecutionId: process.env.ALP_DELEGATION_EXECUTION_ID || null,
    targetRole,
    task: task.join(" "),
    workspace,
    metadata: backend ? { backend } : {},
    executionOptions: { background, timeoutMs, runtime },
  });
  if (!background && value.status === "running")
    value = service.wait(value.executionId, { timeoutMs });
  show(value, json);
  process.exit(value.status === "failed" ? 1 : 0);
}

function wait(argv) {
  const executionId = required(argv, 0, "wait thiếu execution id");
  const timeoutIndex = argv.indexOf("--timeout-ms");
  const timeoutMs = timeoutIndex >= 0 ? Number(required(argv, timeoutIndex + 1, "--timeout-ms thiếu số")) : null;
  show(service.wait(executionId, { timeoutMs }));
}

function switchBackend(argv) {
  const requested = argv[0] || null;
  if (!requested) {
    show({ backend: config.backend, source: config.backendSource });
    return;
  }
  if (argv.length > 1) die("switch chỉ nhận một backend");

  if (["default", "reset"].includes(requested)) {
    clearBackendSelection(config.stateDir);
    const restored = loadDelegationConfig(repoRoot);
    show({ backend: restored.backend, source: restored.backendSource, changed: true });
    return;
  }

  if (!config.backends[requested]?.enabled)
    die(`delegation backend \`${requested}\` không tồn tại hoặc đang disabled`);
  const health = service.health(requested);
  if (!health.ok)
    die(`không chuyển sang \`${requested}\`: ${health.message}`);
  writeBackendSelection(config.stateDir, requested);
  show({
    backend: requested,
    source: "switch",
    changed: requested !== config.backend,
    health: health.status || "healthy",
  });
}

function show(value, json = process.argv.includes("--json")) {
  if (json) console.log(JSON.stringify(value, null, 2));
  else if (Array.isArray(value)) {
    for (const row of value) console.log(`${row.executionId} ${row.status} ${row.parentRole}->${row.targetRole} ${row.backend}`);
  } else if (value.executionId) {
    console.log(`EXECUTION ${value.executionId}`);
    console.log(`STATUS    ${value.status}`);
    if (value.metadata?.backend) console.log(`BACKEND   ${value.metadata.backend}`);
    if (value.output) process.stdout.write(value.output.endsWith("\n") ? value.output : value.output + "\n");
  } else {
    for (const [key, item] of Object.entries(value)) console.log(`${key.padEnd(10)} ${item}`);
  }
}

function required(argv, index, message) { if (!argv[index]) die(message); return argv[index]; }
function usage(code) {
  console.log(
    "alp delegate <role> [--project path] [--backend name] [--background] [--] <task>\n" +
    "alp delegation status|wait|cancel|cleanup <execution-id>\n" +
    "alp delegation health [backend]\n" +
    "alp delegation switch [herdr|paseo|default]\n" +
    "alp delegation list"
  );
  process.exit(code);
}
function die(message) { console.error(`ERROR     ${message}`); process.exit(2); }

#!/usr/bin/env node
// Compatibility facade. Policy/context/backend selection belong to DelegationService.

const fs = require("fs");
const path = require("path");
const L = require("./lib/loadout.cjs");
const C = require("./lib/codex-role.cjs");
const P = require("./lib/codex-profile.cjs");
const { createDelegationService } = require("./lib/delegation/create-service.cjs");

const repoRoot = L.findRepoRoot(__dirname);
if (!repoRoot) die("không tìm thấy repo alp-code");
const argv = process.argv.slice(2);
const role = argv.shift();
if (!role || ["-h", "--help"].includes(role)) usage(role ? 0 : 2);
if (!C.isAllowedRole(role)) die(`\`${role}\` không phải vai được launcher hỗ trợ`);

const loadout = L.loadLoadout(repoRoot, role);
if (!loadout) die(`thiếu identity/${role}/loadout.yaml`);

let project = null;
let dryRun = false;
let exec = false;
let background = false;
let runtime = "codex";
let backend = null;
let timeoutMs = null;
let releaseTarget = null;
let ignoredAnchor = null;
const promptParts = [];

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--project") project = requiredValue(argv, ++i, "--project thiếu path");
  else if (arg === "--dry-run") dryRun = true;
  else if (arg === "--exec") exec = true;
  else if (arg === "--pane") background = true; // legacy alias
  else if (arg === "--kind") runtime = requiredValue(argv, ++i, "--kind thiếu runtime");
  else if (arg === "--backend") backend = requiredValue(argv, ++i, "--backend thiếu tên");
  else if (arg === "--timeout-ms") timeoutMs = Number(requiredValue(argv, ++i, "--timeout-ms thiếu số"));
  else if (arg === "--anchor") ignoredAnchor = requiredValue(argv, ++i, "--anchor thiếu execution id");
  else if (arg === "--release") releaseTarget = requiredValue(argv, ++i, "--release thiếu execution id");
  else if (arg !== "--") promptParts.push(arg);
}

if (exec && background) die("`--exec` và `--pane` loại trừ nhau — chọn một");
if (!["codex", "claude"].includes(runtime)) die(`--kind chỉ nhận \`codex\` hoặc \`claude\``);
if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0))
  die("--timeout-ms phải là số dương");

const { service, config } = createDelegationService({ repoRoot });

if (releaseTarget) {
  // ALP execution IDs remember their backend. A pre-migration pane ID has no ALP record,
  // so route that legacy cleanup explicitly through HerdrBackend via the service.
  try { service.cleanup(releaseTarget, releaseTarget.startsWith("exec_") ? {} : { backend: "herdr" }); }
  catch (error) { die(error.message); }
  console.log(`CLEANED   ${releaseTarget}`);
  process.exit(0);
}

const ws = L.effectiveWorkspaces(loadout);
if (role === "search" && !project) {
  // Compatibility facade follows the same rule as `alp delegate`: caller cwd is the
  // workspace. Chỉ fall back về workspace đăng ký đầu tiên khi launcher được gọi từ
  // chính alp-code (legacy maintenance flow).
  const callerCwd = process.cwd();
  project = L.isWithin(repoRoot, callerCwd) ? ws.read[0] || null : callerCwd;
}
if (project) project = path.resolve(project);
if (project && (!fs.existsSync(project) || !fs.statSync(project).isDirectory()))
  die(`workspace không tồn tại: ${project}`);
if (role === "search" && !project)
  die("Search cần --project <path> hoặc một workspaces.read trong loadout.yaml");

const sessionRole = process.env.ALP_DELEGATED_ROLE || process.env.ALP_ROLE || null;
const parentRole = role === "main" ? sessionRole || "principal" : sessionRole || "main";
const task = promptParts.join(" ").trim() ||
  (role === "main" ? "Chưa có nội dung nhiệm vụ." : "Báo role giao việc rằng chưa có nội dung nhiệm vụ.");
const input = {
  parentRole,
  parentExecutionId: process.env.ALP_DELEGATION_EXECUTION_ID || null,
  targetRole: role,
  task,
  workspace: project || repoRoot,
  metadata: backend ? { backend } : {},
  executionOptions: {
    background,
    interactive: !exec && !background,
    timeoutMs,
    runtime,
  },
};

if (ignoredAnchor)
  console.error("WARN      `--anchor` được giữ để parse compatibility nhưng Delegation API không expose runtime anchor");

if (dryRun) {
  let prepared;
  try { prepared = service.prepare(input); }
  catch (error) { die(error.message); }
  const context = prepared.context;
  console.log(JSON.stringify({
    role,
    mode: background ? "pane" : exec ? "exec" : "interactive",
    kind: runtime,
    backend: prepared.backend.name,
    configuredBackend: config.backend,
    profile: P.profilePath(P.codexHome(), role),
    model: P.codexModel(loadout),
    reasoningEffort: loadout.reasoning_effort || null,
    cwd: context.workspace,
    sandbox: context.sandbox,
    webSearch: P.WEB_SEARCH_ROLES.has(role),
    delegation: role === "main"
      ? { from: "principal", replyTo: "principal", principalFacing: true }
      : { from: parentRole, replyTo: parentRole, principalFacing: true },
  }, null, 2));
  process.exit(0);
}

let delegated;
try { delegated = service.delegate(input); }
catch (error) { die(`${error.code || "DelegationError"}: ${error.message}`); }

// `--exec` và interactive compatibility chờ kết quả. `--pane` trả handle ngay.
if (!background && delegated.status === "running") {
  try { delegated = service.wait(delegated.executionId, { timeoutMs }); }
  catch (error) { die(`${error.code || "DelegationError"}: ${error.message}`); }
}

printResult(delegated, delegated.metadata?.backend || preparedBackend(config, backend));
process.exit(delegated.status === "failed" ? 1 : 0);

function printResult(value, backendName) {
  console.log(`EXECUTION ${value.executionId}`);
  console.log(`STATUS    ${value.status}`);
  console.log(`BACKEND   ${backendName}`);
  if (value.output) process.stdout.write(value.output.endsWith("\n") ? value.output : value.output + "\n");
  if (value.status === "running") {
    console.log(`WAIT      node ${path.join(repoRoot, "scripts", "delegate.cjs")} wait ${value.executionId}`);
    console.log(`CLEANUP   node ${path.join(repoRoot, "scripts", "delegate.cjs")} cleanup ${value.executionId}`);
  }
}

function preparedBackend(cfg, override) { return override || cfg.backend; }
function requiredValue(args, index, message) { if (!args[index]) die(message); return args[index]; }
function usage(code) {
  console.log(
    "Usage: run-role <role> [--project path] [--dry-run] [--] [prompt]\n" +
    "         --exec                         foreground/headless compatibility\n" +
    "         --pane                         background compatibility alias\n" +
    "         --backend herdr|paseo          override configured backend\n" +
    "         --kind codex|claude            target execution runtime\n" +
    "         --release <execution-id>       compatibility alias for cleanup"
  );
  process.exit(code);
}
function die(message) { console.error(`ERROR     ${message}`); process.exit(2); }

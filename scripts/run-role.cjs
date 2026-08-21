#!/usr/bin/env node
// Launcher Codex cho các vai retrieval. Mọi vai chạy read-only; main
// chịu trách nhiệm lưu artifact sau khi kiểm chứng.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const L = require("./lib/loadout.cjs");
const D = require("./lib/delegation.cjs");

const repoRoot = L.findRepoRoot(__dirname);
if (!repoRoot) die("không tìm thấy repo alp-code");
const argv = process.argv.slice(2);
const role = argv.shift();
if (!role || ["-h", "--help"].includes(role)) usage(role ? 0 : 2);

const allowed = new Set(["search", "librarian", "read-thread"]);
if (!allowed.has(role)) die(`\`${role}\` không phải vai Codex retrieval`);
const loadout = L.loadLoadout(repoRoot, role);
if (!loadout) die(`thiếu identity/${role}/loadout.yaml`);

let project = null;
let dryRun = false;
const promptParts = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--project") {
    if (!argv[i + 1]) die("--project thiếu path");
    project = path.resolve(argv[++i]);
  } else if (argv[i] === "--dry-run") {
    dryRun = true;
  } else if (argv[i] !== "--") promptParts.push(argv[i]);
}

const ws = L.effectiveWorkspaces(loadout);
if (role === "search" && !project) project = ws.read[0] || null;
if (project && (!fs.existsSync(project) || !fs.statSync(project).isDirectory()))
  die(`workspace không tồn tại: ${project}`);
if (role === "search" && !project)
  die("Search cần --project <path> hoặc một workspaces.read trong loadout.yaml");

const cwd = project || repoRoot;
const boot = buildBoot(role, loadout, ws);
const userPrompt = promptParts.join(" ").trim() || "Báo main rằng chưa có nội dung nhiệm vụ.";
const prompt = `${boot}\n\n${D.wrapDelegatedPrompt(userPrompt)}`;
const args = ["-m", loadout.model, "-s", "read-only", "-a", "never", "-C", cwd];
if (role === "librarian") args.push("--search");
args.push(prompt);

if (dryRun) {
  console.log(JSON.stringify({
    role,
    model: loadout.model,
    cwd,
    sandbox: "read-only",
    webSearch: role === "librarian",
    delegation: { from: "main", replyTo: "main", principalFacing: false },
  }, null, 2));
  process.exit(0);
}

const bin = process.platform === "win32" ? "codex.cmd" : "codex";
const result = spawnSync(bin, args, { stdio: "inherit" });
if (result.error) die(`không chạy được Codex CLI: ${result.error.message}`);
process.exit(result.status ?? 1);

function buildBoot(role, lo, ws) {
  const roleDir = path.join(repoRoot, "identity", role);
  const shared = path.join(repoRoot, "identity", "_shared");
  const files = [
    path.join(roleDir, "IDENTITY.md"), path.join(roleDir, "SOUL.md"),
    path.join(roleDir, "PLAYBOOK.md"), path.join(roleDir, "RELATIONS.md"),
    path.join(shared, "VOICE.md"), path.join(shared, "HOUSE-RULES.md"),
    path.join(shared, "PRINCIPAL.md"),
  ];
  const body = files.map((f) => `## ${path.basename(f)}\n\n${fs.readFileSync(f, "utf8")}`).join("\n\n---\n\n");
  return `# BOOT alp-code\n\nTên: ${lo.name}\nVai: ${role}\nModel: ${lo.model}\n` +
    `Workspace đọc: ${ws.read.join(", ") || "không có"}\n` +
    "Chế độ: READ-ONLY. Không sửa file; trả artifact cho main.\n\n" + body;
}
function usage(code) {
  console.log("Usage: run-role <search|librarian|read-thread> [--project path] [--] [prompt]");
  process.exit(code);
}
function die(message) { console.error(`ERROR     ${message}`); process.exit(2); }

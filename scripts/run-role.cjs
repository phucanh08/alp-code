#!/usr/bin/env node
// Launcher Codex. Vai phụ chạy read-only; main chịu trách nhiệm lưu artifact sau
// khi kiểm chứng.
//
// `main` cũng chạy được qua đây nhưng KHÁC vai phụ ở ba chỗ, đừng gộp:
//   - không bọc prompt bằng wrapDelegatedPrompt — main nhận việc TỪ principal, không từ ai khác
//   - được `workspace-write`, nhưng CHỈ ở nhà mình hoặc workspace đã khai `workspaces.write`
//   - boot không nói "trả artifact cho main" — main không báo cáo cho chính nó

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const L = require("./lib/loadout.cjs");
const D = require("./lib/delegation.cjs");
const C = require("./lib/codex-role.cjs");

const repoRoot = L.findRepoRoot(__dirname);
if (!repoRoot) die("không tìm thấy repo alp-code");
const argv = process.argv.slice(2);
const role = argv.shift();
if (!role || ["-h", "--help"].includes(role)) usage(role ? 0 : 2);

if (!C.isAllowedRole(role)) die(`\`${role}\` không phải vai Codex được launcher hỗ trợ`);
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

const isMain = role === "main";
const cwd = project || repoRoot;

// `model:` là model của runtime chính. Với main runtime chính là Claude, nên launcher Codex
// phải lấy `codex_model:` — nếu không sẽ đưa `claude-opus-5` cho `codex -m`.
const model = loadout.codex_model || loadout.model;

// BẤT BIẾN CHARTER: cwd lạ = read-only. Chỉ main, và chỉ ở nhà mình hoặc trong một
// workspace đã khai `workspaces.write`, mới được ghi. Vai phụ không bao giờ.
const sandbox = isMain && (!project || isInside(cwd, ws.write)) ? "workspace-write" : "read-only";

const boot = buildBoot(role, loadout, ws, sandbox);
const userPrompt = promptParts.join(" ").trim() ||
  (isMain ? "Chưa có nội dung nhiệm vụ." : "Báo main rằng chưa có nội dung nhiệm vụ.");
// main nhận việc từ principal — bọc nó bằng contract delegation là nói dối nó về nguồn việc.
const prompt = isMain ? `${boot}\n\n# NHIỆM VỤ\n\n${userPrompt}` : `${boot}\n\n${D.wrapDelegatedPrompt(userPrompt)}`;
const args = [
  "-m", model,
  ...C.reasoningArgs(loadout),
  "-s", sandbox, "-a", "never", "-C", cwd,
];
if (role === "librarian") args.push("--search");
args.push(prompt);

if (dryRun) {
  console.log(JSON.stringify({
    role,
    model,
    reasoningEffort: loadout.reasoning_effort || null,
    cwd,
    sandbox,
    webSearch: role === "librarian",
    delegation: isMain
      ? { from: "principal", replyTo: "principal", principalFacing: true }
      : { from: "main", replyTo: "main", principalFacing: false },
  }, null, 2));
  process.exit(0);
}

const bin = process.platform === "win32" ? "codex.cmd" : "codex";
const result = spawnSync(bin, args, { stdio: "inherit" });
if (result.error) die(`không chạy được Codex CLI: ${result.error.message}`);
process.exit(result.status ?? 1);

function buildBoot(role, lo, ws, sandbox) {
  const roleDir = path.join(repoRoot, "identity", role);
  const shared = path.join(repoRoot, "identity", "_shared");
  const files = [
    path.join(roleDir, "IDENTITY.md"), path.join(roleDir, "SOUL.md"),
    path.join(roleDir, "PLAYBOOK.md"), path.join(roleDir, "RELATIONS.md"),
    path.join(shared, "VOICE.md"), path.join(shared, "HOUSE-RULES.md"),
    path.join(shared, "PRINCIPAL.md"),
  ];
  const body = files.map((f) => `## ${path.basename(f)}\n\n${fs.readFileSync(f, "utf8")}`).join("\n\n---\n\n");
  return `# BOOT alp-code\n\nTên: ${lo.name}\nVai: ${role}\nModel: ${model}\n` +
    `Reasoning effort: ${lo.reasoning_effort || "mặc định runtime"}\n` +
    `Workspace đọc: ${ws.read.join(", ") || "không có"}\n` +
    `Chế độ: ${sandbox.toUpperCase()}. ` +
    (role === "main"
      ? "Bạn báo cáo cho principal.\n\n"
      : "Không sửa file; trả artifact cho main.\n\n") + body;
}
/**
 * `dir` có nằm trong (hoặc bằng) một trong các root đã khai không?
 * `effectiveWorkspaces` trả path tuyệt đối đã resolve, không có glob — so bằng tiền tố
 * cộng dấu phân cách, không so chuỗi trần: `/a/bc` không được tính là nằm trong `/a/b`.
 */
function isInside(dir, roots) {
  return roots.some((root) => dir === root || dir.startsWith(root + path.sep));
}
function usage(code) {
  console.log(
    "Usage: run-role <main|search|librarian|read-thread|review|oracle|compaction|titling> " +
    "[--project path] [--] [prompt]"
  );
  process.exit(code);
}
function die(message) { console.error(`ERROR     ${message}`); process.exit(2); }

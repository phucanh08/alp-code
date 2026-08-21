#!/usr/bin/env node
// Launcher Codex. Vai phụ chạy read-only; main chịu trách nhiệm lưu artifact sau
// khi kiểm chứng.
//
// Model, effort, approval, web search và HOOK BOOT đều nằm trong profile
// `$CODEX_HOME/<role>.config.toml` do compile-acl sinh ra. Launcher này chỉ còn ba việc
// mà profile không làm được: chọn cwd, nâng quyền ghi theo cwd, và bọc contract delegation.
//
// `main` cũng chạy được qua đây nhưng KHÁC vai phụ ở hai chỗ, đừng gộp:
//   - không bọc prompt bằng wrapDelegatedPrompt — main nhận việc TỪ principal, không từ ai khác
//   - được `workspace-write`, nhưng CHỈ ở nhà mình hoặc workspace đã khai `workspaces.write`

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const L = require("./lib/loadout.cjs");
const D = require("./lib/delegation.cjs");
const C = require("./lib/codex-role.cjs");
const P = require("./lib/codex-profile.cjs");

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
let exec = false;
const promptParts = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--project") {
    if (!argv[i + 1]) die("--project thiếu path");
    project = path.resolve(argv[++i]);
  } else if (argv[i] === "--dry-run") {
    dryRun = true;
  } else if (argv[i] === "--exec") {
    exec = true;
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
const profile = P.profilePath(P.codexHome(), role);

// BẤT BIẾN CHARTER: cwd lạ = read-only. Chỉ main, và chỉ ở nhà mình hoặc trong một
// workspace đã khai `workspaces.write`, mới được ghi. Vai phụ không bao giờ.
// Profile pin sẵn `read-only`; chỉ nâng ở đây, cho ĐÚNG lần chạy này.
const sandbox = isMain && (!project || isInside(cwd, ws.write)) ? "workspace-write" : "read-only";

const userPrompt = promptParts.join(" ").trim() ||
  (isMain ? "Chưa có nội dung nhiệm vụ." : "Báo main rằng chưa có nội dung nhiệm vụ.");
// main nhận việc từ principal — bọc nó bằng contract delegation là nói dối nó về nguồn việc.
const prompt = isMain ? userPrompt : D.wrapDelegatedPrompt(userPrompt);

const args = exec
  ? [
      "exec", "-p", role,
      // Hook bị trust-gate: profile chưa duyệt thì SessionStart bị BỎ QUA IM LẶNG trong
      // phiên headless — vai vào việc mà không có danh tính. Profile này do chính
      // compile-acl sinh ra nên bề mặt vẫn là file của mình.
      "--dangerously-bypass-hook-trust",
      "-C", cwd, "--skip-git-repo-check",
    ]
  : ["-p", role, "-C", cwd];
// Chỉ truyền `-s` khi NÂNG quyền: mức nền read-only đã nằm trong profile.
if (sandbox === "workspace-write") args.push("-s", sandbox);
args.push(prompt);

if (dryRun) {
  console.log(JSON.stringify({
    role,
    mode: exec ? "exec" : "interactive",
    profile,
    model: P.codexModel(loadout),
    reasoningEffort: loadout.reasoning_effort || null,
    cwd,
    sandbox,
    webSearch: P.WEB_SEARCH_ROLES.has(role),
    delegation: isMain
      ? { from: "principal", replyTo: "principal", principalFacing: true }
      : { from: "main", replyTo: "main", principalFacing: false },
  }, null, 2));
  process.exit(0);
}

// Thiếu profile thì `codex -p` KHÔNG báo lỗi — nó im lặng chạy mặc định, mà mặc định của
// `exec` là `workspace-write`. Fail đóng ở đây, đừng để hỏng thầm lặng ở đó.
if (!fs.existsSync(profile))
  die(`thiếu profile ${profile} — chạy scripts/compile-acl.sh rồi thử lại`);

const bin = process.platform === "win32" ? "codex.cmd" : "codex";
// BẪY: `codex exec` đọc stdin mặc định. Không đóng stdin thì phiên treo ở
// "Reading additional input from stdin..." cho tới khi bị giết.
const result = spawnSync(bin, args, { stdio: exec ? ["ignore", "inherit", "inherit"] : "inherit" });
if (result.error) die(`không chạy được Codex CLI: ${result.error.message}`);
process.exit(result.status ?? 1);

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
    "[--project path] [--exec] [--dry-run] [--] [prompt]"
  );
  process.exit(code);
}
function die(message) { console.error(`ERROR     ${message}`); process.exit(2); }

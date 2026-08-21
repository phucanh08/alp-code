#!/usr/bin/env node
// Launcher vai. Vai phụ chạy read-only; main chịu trách nhiệm lưu artifact sau
// khi kiểm chứng.
//
// BA ĐƯỜNG CHẠY, chọn theo HÌNH DẠNG VIỆC (bảng đầy đủ: `_shared/DELEGATION.md`):
//   (mặc định)  phiên Codex tương tác, chiếm terminal hiện tại
//   --exec      headless, một câu hỏi → một câu trả lời ra stdout
//   --pane      pane herdr riêng, chạy nền, theo dõi được — đường CHÍNH khi có fleet
// `--pane` mà không có fleet thì TỰ rơi về `--exec`: phiên headless không có pane để mở,
// và bắt principal xử lý sự khác biệt đó là bắt sai người.
//
// Model, effort, approval, web search và HOOK BOOT đều nằm trong profile
// `$CODEX_HOME/<role>.config.toml` do compile-acl sinh ra. Launcher này chỉ làm những việc
// profile không làm được: chọn cwd, nâng quyền ghi theo cwd, bọc contract delegation, và
// (với `--pane`) điều phối herdr — xem lib/herdr-fleet.cjs.
//
// `--release <pane>` là đường thứ tư, không chạy vai nào: trả quyền lifecycle cho một pane
// đã xong việc. Nó ở đây vì `--seq` phải nằm trong code, không nằm trong tay người gõ lệnh.
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
const F = require("./lib/herdr-fleet.cjs");

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
let pane = false;
let kind = "codex";
let anchor = null;
let releaseTarget = null;
const promptParts = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--project") {
    if (!argv[i + 1]) die("--project thiếu path");
    project = path.resolve(argv[++i]);
  } else if (argv[i] === "--dry-run") {
    dryRun = true;
  } else if (argv[i] === "--exec") {
    exec = true;
  } else if (argv[i] === "--pane") {
    pane = true;
  } else if (argv[i] === "--kind") {
    kind = argv[++i];
    if (!["codex", "claude"].includes(kind)) die(`--kind chỉ nhận \`codex\` hoặc \`claude\`, không phải \`${kind}\``);
  } else if (argv[i] === "--anchor") {
    if (!argv[i + 1]) die("--anchor thiếu pane id");
    anchor = argv[++i];
  } else if (argv[i] === "--release") {
    if (!argv[i + 1]) die("--release thiếu pane id");
    releaseTarget = argv[++i];
  } else if (argv[i] !== "--") promptParts.push(argv[i]);
}
if (exec && pane) die("`--exec` và `--pane` loại trừ nhau — chọn một");
if (kind === "claude" && !pane) die("`--kind claude` chỉ có nghĩa với `--pane`");

// Trả quyền cho pane đã xong việc. Đường RIÊNG vì `release-agent` thiếu `--seq` bị bỏ qua
// im lặng — seq nằm trong lib, không để ai gõ tay (xem lib/herdr-fleet.cjs).
if (releaseTarget) {
  const fleet = F.available();
  if (!fleet.ok) die(`không trả quyền được: ${fleet.reason}`);
  let label;
  try {
    label = F.releasePane(releaseTarget);
  } catch (e) {
    die(e.message);
  }
  console.log(`RELEASED  ${releaseTarget} (${label}) — panel trả về cho herdr tự suy state`);
  process.exit(0);
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

// `--pane` cần fleet đang chạy. Không có thì rơi về `--exec` NGAY Ở ĐÂY, trước khi
// dựng args: phiên headless không có pane nào để mở, và im lặng thất bại ở
// `pane split` thì người gọi chỉ thấy một stack trace vô nghĩa.
let paneFallback = null;
if (pane) {
  const fleet = F.available();
  if (!fleet.ok) {
    paneFallback = fleet.reason;
    pane = false;
    exec = true;
    kind = "codex";
  }
}

// Hook bị trust-gate: profile chưa duyệt thì Codex CHẶN ở dialog "Hooks need review"
// (phiên có TUI) hoặc BỎ QUA HOOK IM LẶNG (phiên headless) — cả hai đều là vai vào việc
// mà không có danh tính. Bỏ qua gate ở đâu KHÔNG có người ngồi trước pane để bấm: `--exec`
// và `--pane`. Phiên tương tác do chính principal mở thì để dialog hiện — họ trả lời được,
// và đó là một prompt bảo mật thật. Profile là file compile-acl sinh ra, không phải của lạ.
const bypassHookTrust = exec || pane;

const args = exec
  ? ["exec", "-p", role, "--dangerously-bypass-hook-trust", "-C", cwd, "--skip-git-repo-check"]
  : ["-p", role, ...(bypassHookTrust ? ["--dangerously-bypass-hook-trust"] : []), "-C", cwd];
// Chỉ truyền `-s` khi NÂNG quyền: mức nền read-only đã nằm trong profile.
if (sandbox === "workspace-write") args.push("-s", sandbox);
args.push(prompt);

// Vai chạy Claude trong pane: danh tính đến từ `--settings` + `ALP_ROLE` (herdr truyền
// qua `pane split --env`), không từ cwd. Cùng bộ ACL mà compile-acl sinh cho vai đó.
const settings = path.join(repoRoot, "identity", role, ".claude", "settings.json");
const paneArgv = kind === "claude" ? ["--settings", settings, prompt] : args;
const mode = pane ? "pane" : exec ? "exec" : "interactive";

if (dryRun) {
  console.log(JSON.stringify({
    role,
    mode,
    kind: pane ? kind : "codex",
    argv: pane ? paneArgv : args,
    fallback: paneFallback,
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

if (paneFallback)
  console.error(`NOTE      không có fleet (${paneFallback}) — rơi về \`--exec\``);

// Thiếu config thì cả hai runtime hỏng IM LẶNG theo cách riêng: `codex -p` bỏ qua profile
// không có và chạy mặc định `workspace-write`; `claude` không có `--settings` thì mở phiên
// không ACL, không hook. Fail đóng ở đây, đừng để hỏng thầm lặng ở đó.
if (kind === "claude") {
  if (!fs.existsSync(settings))
    die(`thiếu ${settings} — chạy scripts/compile-acl.sh rồi thử lại`);
} else if (!fs.existsSync(profile)) {
  die(`thiếu profile ${profile} — chạy scripts/compile-acl.sh rồi thử lại`);
}

if (pane) {
  let spawned;
  try {
    spawned = F.spawn({
      role,
      kind,
      argv: paneArgv,
      cwd,
      anchor,
      message: `${role}: ${userPrompt.slice(0, 80)}`,
      // Prompt nhiều dòng phải ra file (herdr từ chối newline) và dòng thay thế phải
      // mang theo nguồn ủy nhiệm — thiếu nó vai phụ từ chối vì luật main-only.
      pointer: isMain ? undefined : D.delegatedPromptPointer,
    });
  } catch (e) {
    // Fleet có mà spawn hỏng là chuyện khác hẳn "không có fleet": pane có thể đã tạo dở,
    // im lặng rơi về `--exec` sẽ chạy việc HAI LẦN. Dừng, để người gọi quyết.
    die(`spawn pane thất bại: ${e.message}`);
  }
  console.log(`PANE      ${spawned.pane}`);
  console.log(`AGENT     ${spawned.label} (${kind})`);
  console.log(`WATCH     herdr pane read ${spawned.pane} --lines 30`);
  // KHÔNG gợi ý `herdr pane release-agent` trần: thiếu `--seq` nó bị bỏ qua im lặng.
  console.log(`RELEASE   node ${__filename} ${role} --release ${spawned.pane}`);
  process.exit(0);
}

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
    "Usage: run-role <main|search|librarian|read-thread|review|oracle|compaction|titling>\n" +
    "         [--project path] [--dry-run] [--] [prompt]\n" +
    "         --exec                        headless, trả text ra stdout\n" +
    "         --pane [--kind claude|codex] [--anchor <pane>]\n" +
    "                                       pane herdr riêng; không có fleet thì tự về --exec\n" +
    "         --release <pane>              trả quyền lifecycle khi pane xong việc"
  );
  process.exit(code);
}
function die(message) { console.error(`ERROR     ${message}`); process.exit(2); }

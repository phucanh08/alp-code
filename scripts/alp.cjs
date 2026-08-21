#!/usr/bin/env node
// alp.cjs — một cửa vào duy nhất cho cả hệ.
//
//   alp                    phiên Phở CHỈ-ĐỌC ở cwd bất kỳ (không cần init)
//   alp init [path]        đăng ký project + sinh config Claude/Codex + trust hai runtime
//   alp init --uninstall   gỡ config cục bộ, huỷ đăng ký workspace
//   alp doctor             khám toàn hệ
//   alp update             git pull --ff-only + bootstrap lại
//   alp help               9 script của repo, gom về một chỗ
//
// SAU `alp init`, GÕ `claude` (hoặc `codex`) TRONG PROJECT LÀ RA PHỞ. Không `cd`,
// không flag — đó là toàn bộ lý do file này tồn tại.
//
// `alp` KHÔNG THAM SỐ khác `alp init` ở chỗ nó không ghi gì vào project: nó nạp settings
// của main từ repo alp-code và đánh dấu cwd là chỉ-đọc qua `ALP_READONLY_DIRS`. Giữ đúng
// bất biến CHARTER "cwd lạ = read-only" mà không cần đăng ký trước.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const L = require("./lib/loadout.cjs");
const T = require("./lib/trust.cjs");
const PC = require("./lib/project-config.cjs");

const repoRoot = L.findRepoRoot(__dirname);
if (!repoRoot) die("không tìm thấy repo alp-code (thư mục có CHARTER.md)");

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith("-") ? argv.shift() : null;

const COMMANDS = { init, doctor, update, help };

if (!cmd) session();
else if (COMMANDS[cmd]) COMMANDS[cmd](argv);
else if (["-h", "--help"].includes(cmd)) help();
else die(`lệnh lạ \`${cmd}\` — xem \`alp help\``);

// ---------------------------------------------------------------- alp (không tham số)

/**
 * Phiên Phở chỉ-đọc ở cwd bất kỳ.
 *
 * Ba mảnh phải có mặt cùng lúc, thiếu một là hỏng câm:
 *   --settings  nạp hook + ACL của main (đã đo: giữ nguyên cwd, không nhảy thư mục)
 *   ALP_ROLE    nói cho hook biết vai — cwd ở đây chẳng gợi ý gì về danh tính
 *   trust       chưa trust thì Claude Code BỎ QUA allow/additionalDirectories VÀ chặn
 *               hook ở dialog "Is this a project you trust?" (BẪY 3)
 */
function session() {
  const cwd = process.cwd();
  const role = mainRole();
  const settings = path.join(repoRoot, "identity", role, ".claude", "settings.json");
  if (!fs.existsSync(settings))
    die(`thiếu ${settings} — chạy \`node ${path.join(repoRoot, "scripts", "compile-acl.cjs")}\``);

  if (L.isWithin(repoRoot, cwd)) {
    // Trong chính alp-code thì phiên chỉ-đọc là sai: đây là nhà của Phở.
    console.log(`NOTE     cwd nằm trong alp-code — chạy thẳng: cd ${path.join(repoRoot, "identity", role)} && claude`);
  }

  const trusted = safeTrust([cwd]);
  trusted.forEach((k) => console.log(`TRUSTED  ${k}`));
  console.log(`READONLY ${cwd} — phiên này đọc được, KHÔNG ghi được. Ghi được thì \`alp init\` trước.`);

  const env = { ...process.env, ALP_ROLE: role, ALP_READONLY_DIRS: cwd };
  const bin = process.platform === "win32" ? "claude.cmd" : "claude";
  const r = spawnSync(bin, ["--settings", settings, "--add-dir", cwd], { stdio: "inherit", env, cwd });
  if (r.error) die(`không chạy được Claude Code: ${r.error.message}`);
  process.exit(r.status ?? 1);
}

// ---------------------------------------------------------------- alp init

function init(args) {
  const uninstalling = args.includes("--uninstall");
  const positional = args.filter((a) => !a.startsWith("-"));
  for (const a of args)
    if (a.startsWith("-") && a !== "--uninstall") die(`tham số lạ: ${a}`);

  const projectPath = realOrResolved(positional[0] || process.cwd());
  if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory())
    die(`không phải thư mục: ${projectPath}`);
  if (L.isWithin(repoRoot, projectPath) || L.isWithin(projectPath, repoRoot))
    die("project code và alp-code không được chứa lẫn nhau");

  return uninstalling ? initUninstall(projectPath) : initInstall(projectPath);
}

function initInstall(projectPath) {
  const role = mainRole();

  // 1. Đăng ký. install-project.cjs đã làm project card L1 + L0 + workspaces trong mọi
  //    loadout rồi recompile ACL — gọi lại nó, không chép logic (idempotent sẵn).
  //    Bước này phải chạy TRƯỚC bước 2: config cục bộ đọc `workspaces` để quyết định
  //    có deny cwd hay không. Đảo thứ tự = project vừa đăng ký vẫn bị khoá chỉ-đọc.
  console.log("---");
  mustRun("install-project.cjs", [projectPath]);

  // 2. Config cục bộ cho hai runtime.
  console.log("---");
  let results;
  try {
    results = PC.install(repoRoot, role, projectPath, L.listRoles(repoRoot));
  } catch (e) {
    die(e.message);
  }
  for (const { file, action } of results) console.log(`${action.padEnd(8)} ${file}`);

  // 3. Giấu khỏi `git status` của người ta — per-clone, không tracked.
  if (PC.setGitExclude(projectPath, true)) console.log("WROTE    khối exclude per-clone cho hai file trên");
  const tracked = PC.trackedConfigs(projectPath);
  if (tracked.length)
    console.log(`WARN     project đang track ${tracked.join(", ")} — exclude không áp được, \`git status\` sẽ đổi`);

  // 4. Trust CẢ HAI runtime. Không trust thì delegation chết câm: Claude dừng ở dialog
  //    và hook không chạy; Codex bỏ qua hook của config cấp project.
  const claudeTrusted = safeTrust([projectPath]);
  const codexTrusted = T.trustCodex([projectPath]);
  for (const k of claudeTrusted) console.log(`TRUSTED  ${k} (Claude)`);
  for (const k of codexTrusted) console.log(`TRUSTED  ${k} (Codex)`);
  if (!claudeTrusted.length && !codexTrusted.length) console.log("OK       đã trust ở cả hai runtime từ trước");

  console.log("---");
  console.log(`READY    ${projectPath}`);
  console.log("");
  console.log(`  cd ${projectPath} && claude      # ra Phở, ghi được trong project này`);
  console.log(`  cd ${projectPath} && codex       # cũng ra Phở`);
  console.log("");
  console.log("Gỡ: `alp init --uninstall` (chạy trong project đó).");
}

function initUninstall(projectPath) {
  console.log("---");
  for (const { file, action } of PC.uninstall(projectPath)) {
    if (action === "ABSENT") continue;
    if (action === "FOREIGN") console.log(`KEEP     ${file} — không phải file do alp init sinh, không đụng`);
    else console.log(`${action.padEnd(8)} ${file}`);
  }
  if (PC.setGitExclude(projectPath, false)) console.log("WROTE    gỡ khối exclude per-clone");

  // Huỷ đăng ký: rút project khỏi `workspaces` của MỌI vai rồi recompile. Không recompile
  // thì settings cũ vẫn mở workspace đó — gỡ file cục bộ mà quyền vẫn còn.
  let changed = 0;
  for (const role of L.listRoles(repoRoot)) {
    const ws = L.effectiveWorkspaces(L.loadLoadout(repoRoot, role));
    const keep = (list) => list.filter((p) => p !== projectPath);
    if (L.writeWorkspaces(repoRoot, role, keep(ws.read), keep(ws.write))) {
      console.log(`WROTE    identity/${role}/loadout.yaml (gỡ workspace)`);
      changed++;
    }
  }
  if (changed) mustRun("compile-acl.cjs", []);

  console.log("---");
  console.log(`REMOVED  config cục bộ tại ${projectPath}`);
  console.log("KEEP     memory/projects/<slug>/ — trí nhớ về project không tự xoá, xoá tay nếu muốn");
  console.log("KEEP     trust trong ~/.claude.json và ~/.codex/config.toml — vô hại, giữ lại");
}

// ---------------------------------------------------------------- lệnh còn lại

function doctor(args) {
  process.exit(run("doctor.cjs", args));
}

function update(args) {
  if (args.length) die("`alp update` không nhận tham số");
  console.log(`PULL     ${repoRoot}`);
  // --ff-only: có commit nội bộ chưa push thì DỪNG. Tự merge/stash hộ người dùng
  // còn tệ hơn bắt họ xử lý tay.
  const pull = spawnSync("git", ["-C", repoRoot, "pull", "--ff-only"], { stdio: "inherit" });
  if (pull.error) die(`không chạy được git: ${pull.error.message}`);
  if (pull.status !== 0)
    die(`${repoRoot} không fast-forward được — nhánh nội bộ đã rẽ hoặc đang dở việc. ` +
        `Tự xử lý (git -C "${repoRoot}" status) rồi chạy lại.`);
  process.exit(run("bootstrap.cjs", []));
}

function help() {
  const rows = [
    ["alp", "phiên Phở chỉ-đọc ở cwd bất kỳ"],
    ["alp init [path]", "đăng ký project + sinh config Claude/Codex + trust"],
    ["alp init --uninstall", "gỡ config cục bộ, huỷ đăng ký workspace"],
    ["alp doctor", "khám toàn hệ; mọi tín hiệu kèm dòng `→ fix:` chạy được"],
    ["alp update", "git pull --ff-only rồi bootstrap lại"],
    ["alp help", "bảng này"],
  ];
  const scripts = [
    ["bootstrap.cjs", "compile ACL mọi vai + trust + doctor"],
    ["compile-acl.cjs [--check]", "loadout.yaml → settings.json + profile Codex"],
    ["new-role.cjs <slug>", "tạo vai mới (đường DUY NHẤT — xem CHARTER §4)"],
    ["install-project.cjs <path>", "đăng ký project code có sẵn"],
    ["run-role.cjs <role> [--pane]", "giao việc cho một vai (--exec headless · --release trả quyền)"],
    ["trust-role.cjs [role]", "trust workspace của vai trong ~/.claude.json"],
    ["doctor.cjs [--quiet]", "kiểm toàn vẹn"],
    ["sync-project-index.sh --write", "sinh lại L0 từ frontmatter L1"],
    ["test-isolation.cjs [--live]", "cách ly giữa các vai + chống đệ quy delegation"],
  ];
  const table = (rows) => rows.map(([a, b]) => `  ${a.padEnd(30)} ${b}`).join("\n");

  console.log(`alp — cửa vào alp-code (${repoRoot})\n`);
  console.log(table(rows));
  console.log("\nScript của repo (chạy bằng `node scripts/<tên>`):\n");
  console.log(table(scripts));
  console.log("\nLuật nền: CHARTER.md · danh bạ vai: identity/REGISTRY.md");
}

// ---------------------------------------------------------------- tiện ích

function mainRole() {
  const roles = L.listRoles(repoRoot);
  if (!roles.length) die("identity/ không có vai nào — repo hỏng hoặc clone thiếu");
  return roles.includes("main") ? "main" : roles[0];
}

/** Trust Claude không được phép làm hỏng lệnh: ~/.claude.json là state của người dùng. */
function safeTrust(dirs) {
  try {
    return T.trustClaude(dirs);
  } catch (e) {
    console.error(`WARN     không trust được cho Claude Code: ${e.message}`);
    console.error("WARN     phiên đầu tiên sẽ hỏi trust dialog — bấm chấp nhận một lần là xong");
    return [];
  }
}

function run(script, extra) {
  const file = path.join(repoRoot, "scripts", script);
  // ALP_INIT: script con biết mình đang chạy TRONG `alp init` nên đừng in lại hướng dẫn
  // bước tiếp theo — `alp init` in bản đầy đủ ở cuối.
  const r = spawnSync(process.execPath, [file, ...extra], {
    stdio: "inherit",
    cwd: repoRoot,
    env: { ...process.env, ALP_INIT: "1" },
  });
  if (r.error) die(`không chạy được ${script}: ${r.error.message}`);
  return r.status ?? 1;
}

function mustRun(script, extra) {
  const code = run(script, extra);
  if (code !== 0) die(`bước bắt buộc \`${script}\` thất bại (exit ${code})`);
}

function realOrResolved(p) {
  const abs = path.resolve(p);
  try { return fs.realpathSync(abs); } catch { return abs; }
}

function die(m) {
  console.error(`ERROR    ${m}`);
  process.exit(2);
}

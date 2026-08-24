#!/usr/bin/env node
// bootstrap.cjs — bước 2 của installer: repo đã nằm trên đĩa, giờ làm nó chạy được.
//
//   bootstrap.cjs              compile ACL mọi vai + trust workspace + doctor
//   bootstrap.cjs --no-trust   bỏ bước ghi ~/.claude.json (CI, hoặc chỉ muốn xem thử)
//   bootstrap.cjs --no-path    tạo lệnh `alp` nhưng không sửa shell profile/User PATH
//
// VÌ SAO TÁCH KHỎI install.sh: install.sh/install.ps1 chạy khi repo CHƯA tồn tại nên
// buộc phải viết bằng shell. Từ lúc có repo trở đi, ba OS dùng chung một implementation
// Node — đúng luật của repo này: .sh/.ps1 là wrapper, .cjs là bản thật duy nhất.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const L = require("./lib/loadout.cjs");
const CLI = require("./lib/cli-link.cjs");
const D = require("./lib/delegation/config.cjs");

const repoRoot = L.findRepoRoot(__dirname);
if (!repoRoot) die("không tìm thấy repo root (thư mục có CHARTER.md)");

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) usage(0);
const skipTrust = args.includes("--no-trust");
const skipPath = args.includes("--no-path") || process.env.ALP_NO_PATH === "1";
for (const a of args)
  if (a.startsWith("-") && !["--no-trust", "--no-path", "-h", "--help"].includes(a))
    die(`tham số lạ: ${a}`);

const roles = L.listRoles(repoRoot);
if (!roles.length) die("identity/ không có vai nào — repo hỏng hoặc clone thiếu");

// 1. Trí nhớ. `memory/` KHÔNG nằm trong git (xem .gitignore) nên clone sạch không có
//    nó. Thiếu `memory/projects/INDEX.md` thì `alp init` chết ngay ở marker END:INDEX,
//    và hook SessionStart boot rỗng. Dựng khung trước mọi bước khác.
console.log("---");
ensureMemory();

// Delegation state nằm ngoài source workspace. Tạo root trước khi sinh config để
// Claude/Codex có một writable root tồn tại ngay từ phiên main đầu tiên.
ensureDelegationState();

// 2. ACL. Bắt buộc --all: `deny` thắng `allow` nên settings mỗi vai phải liệt kê
//    đủ các vai anh em. Thiếu một vai = rò rỉ im lặng.
console.log("---");
mustRun("compile-acl.cjs", []);

// 3. Trust. Chưa trust thì Claude Code BỎ QUA allow/additionalDirectories ⇒ vai mở
//    được phiên nhưng không đọc nổi memory/. Hỏng theo kiểu "câm", khó phát hiện.
if (skipTrust) console.log("SKIP     trust-role (--no-trust) — vai sẽ không đọc được memory/ cho tới khi trust");
else mustRun("trust-role.cjs", []);

// 4. Khám. doctor exit 1 = có finding (DRIFT, TEMPLATE-LEFT…) — đó là thông tin, không
//    phải lỗi cài đặt. Chỉ exit 2 mới là doctor tự gãy.
console.log("---");
const health = run("doctor.cjs", []);
if (health === 2) die("doctor.cjs gãy — repo có thể clone thiếu file");

// 5. `alp` vào PATH. Không có bước này thì mọi lệnh trong README đều phải gõ đường dẫn
//    tuyệt đối tới repo — tức là vẫn đúng cái phiền mà `alp init` sinh ra để xoá bỏ.
console.log("---");
for (const entry of CLI.installCli(repoRoot, { skipPath }))
  console.log(`${entry.level.padEnd(8)} ${entry.text}`);

const mainRole = roles.includes("main") ? "main" : roles[0];
const cdPath = path.join(repoRoot, "identity", mainRole);

console.log("---");
console.log(`READY    alp-code tại ${repoRoot} — ${roles.length} vai: ${roles.join(", ")}`);
if (health !== 0) console.log("CHECK    doctor còn cảnh báo ở trên — cài đặt vẫn dùng được, xử lý sau cũng kịp");
console.log("");
console.log(`  cd <project-bất-kỳ> && alp init   # rồi gõ \`claude\` là ra Phở`);
console.log(`  cd ${cdPath} && claude`);
console.log("");
console.log("Cập nhật về sau: `alp update` (hoặc chạy lại lệnh cài) — pull rồi recompile, không mất memory/.");

/**
 * Dựng `memory/` từ `scaffold/memory/` — chỉ những gì còn THIẾU.
 *
 * Trí nhớ là dữ liệu cục bộ của từng máy, không đi theo git. Hệ quả: clone sạch có đủ
 * code nhưng không có một byte trí nhớ nào, và hai file khung là bắt buộc mới chạy được —
 * `memory/projects/INDEX.md` (install-project.cjs đọc marker END:INDEX, thiếu là die) và
 * `memory/INDEX.md` (hook SessionStart lọc theo loadout rồi nạp vào boot set).
 *
 * KHÔNG BAO GIỜ ĐÈ. Trí nhớ mất là thiệt hại thật và không có bản sao trên remote để lấy
 * lại — nên hàm này chỉ biết tạo cái vắng mặt, không biết sửa cái đã có.
 */
function ensureMemory() {
  const seed = path.join(repoRoot, "scaffold", "memory");
  const dest = path.join(repoRoot, "memory");
  if (!fs.existsSync(seed)) die("thiếu scaffold/memory/ — clone hỏng, không dựng lại memory/ được");

  const made = [];
  copyMissing(seed, dest, made);

  // Khoang không có file khung: shared/* rỗng là hợp lệ, private/<role> theo số vai hiện có.
  const dirs = [
    path.join(dest, "shared", "decisions"),
    path.join(dest, "shared", "people"),
    path.join(dest, "shared", "reference"),
    ...roles.map((r) => path.join(dest, "private", r)),
  ];
  for (const d of dirs) {
    if (fs.existsSync(d)) continue;
    fs.mkdirSync(d, { recursive: true });
    made.push(path.relative(repoRoot, d) + "/");
  }

  if (!made.length) console.log("OK       memory/ đã đủ khung — không đụng vào nội dung");
  else for (const m of made) console.log(`WROTE    ${m}`);
}

function ensureDelegationState() {
  let config;
  try { config = D.loadDelegationConfig(repoRoot); }
  catch (error) { die(`delegation config không hợp lệ: ${error.message}`); }
  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  console.log(`OK       delegation state ${config.stateDir}`);
}

function copyMissing(srcDir, dstDir, made) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, e.name);
    const dst = path.join(dstDir, e.name);
    if (e.isDirectory()) copyMissing(src, dst, made);
    else if (!fs.existsSync(dst)) {
      fs.copyFileSync(src, dst);
      made.push(path.relative(repoRoot, dst));
    }
  }
}

// ---------------------------------------------------------------- tiện ích

function run(script, extra) {
  const file = path.join(repoRoot, "scripts", script);
  const r = spawnSync(process.execPath, [file, ...extra], { stdio: "inherit", cwd: repoRoot });
  if (r.error) die(`không chạy được ${script}: ${r.error.message}`);
  return r.status ?? 1;
}

function mustRun(script, extra) {
  const code = run(script, extra);
  if (code !== 0) die(`bước bắt buộc \`${script}\` thất bại (exit ${code})`);
}

function usage(code) {
  console.log("bootstrap.cjs [--no-trust] [--no-path]   — compile ACL, trust, doctor, cài alp CLI");
  process.exit(code);
}

function die(m) {
  console.error(`ERROR    ${m}`);
  process.exit(1);
}

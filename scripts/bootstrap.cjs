#!/usr/bin/env node
// bootstrap.cjs — bước 2 của installer: repo đã nằm trên đĩa, giờ làm nó chạy được.
//
//   bootstrap.cjs              compile ACL mọi vai + trust workspace + doctor
//   bootstrap.cjs --no-trust   bỏ bước ghi ~/.claude.json (CI, hoặc chỉ muốn xem thử)
//
// VÌ SAO TÁCH KHỎI install.sh: install.sh/install.ps1 chạy khi repo CHƯA tồn tại nên
// buộc phải viết bằng shell. Từ lúc có repo trở đi, ba OS dùng chung một implementation
// Node — đúng luật của repo này: .sh/.ps1 là wrapper, .cjs là bản thật duy nhất.

const path = require("path");
const { spawnSync } = require("child_process");
const L = require("./lib/loadout.cjs");

const repoRoot = L.findRepoRoot(__dirname);
if (!repoRoot) die("không tìm thấy repo root (thư mục có CHARTER.md)");

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) usage(0);
const skipTrust = args.includes("--no-trust");
for (const a of args) if (a.startsWith("-") && !["--no-trust", "-h", "--help"].includes(a)) die(`tham số lạ: ${a}`);

const roles = L.listRoles(repoRoot);
if (!roles.length) die("identity/ không có vai nào — repo hỏng hoặc clone thiếu");

// 1. ACL. Bắt buộc --all: `deny` thắng `allow` nên settings mỗi vai phải liệt kê
//    đủ các vai anh em. Thiếu một vai = rò rỉ im lặng.
console.log("---");
mustRun("compile-acl.cjs", []);

// 2. Trust. Chưa trust thì Claude Code BỎ QUA allow/additionalDirectories ⇒ vai mở
//    được phiên nhưng không đọc nổi memory/. Hỏng theo kiểu "câm", khó phát hiện.
if (skipTrust) console.log("SKIP     trust-role (--no-trust) — vai sẽ không đọc được memory/ cho tới khi trust");
else mustRun("trust-role.cjs", []);

// 3. Khám. doctor exit 1 = có finding (DRIFT, TEMPLATE-LEFT…) — đó là thông tin, không
//    phải lỗi cài đặt. Chỉ exit 2 mới là doctor tự gãy.
console.log("---");
const health = run("doctor.cjs", []);
if (health === 2) die("doctor.cjs gãy — repo có thể clone thiếu file");

const mainRole = roles.includes("main") ? "main" : roles[0];
const cdPath = path.join(repoRoot, "identity", mainRole);

console.log("---");
console.log(`READY    alp-code tại ${repoRoot} — ${roles.length} vai: ${roles.join(", ")}`);
if (health !== 0) console.log("CHECK    doctor còn cảnh báo ở trên — cài đặt vẫn dùng được, xử lý sau cũng kịp");
console.log("");
console.log(`  cd ${cdPath} && claude`);
console.log("");
console.log("Cập nhật về sau: chạy lại đúng lệnh cài — nó pull rồi recompile, không mất memory/.");

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
  console.log("bootstrap.cjs [--no-trust]   — compile ACL, trust workspace, chạy doctor");
  process.exit(code);
}

function die(m) {
  console.error(`ERROR    ${m}`);
  process.exit(1);
}

#!/usr/bin/env node
// bootstrap.cjs — bước 2 của installer: repo đã nằm trên đĩa, giờ làm nó chạy được.
//
//   bootstrap.cjs              compile ACL mọi vai + trust workspace + doctor
//   bootstrap.cjs --no-trust   bỏ bước ghi ~/.claude.json (CI, hoặc chỉ muốn xem thử)
//
// VÌ SAO TÁCH KHỎI install.sh: install.sh/install.ps1 chạy khi repo CHƯA tồn tại nên
// buộc phải viết bằng shell. Từ lúc có repo trở đi, ba OS dùng chung một implementation
// Node — đúng luật của repo này: .sh/.ps1 là wrapper, .cjs là bản thật duy nhất.

const fs = require("fs");
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

// 4. `alp` vào PATH. Không có bước này thì mọi lệnh trong README đều phải gõ đường dẫn
//    tuyệt đối tới repo — tức là vẫn đúng cái phiền mà `alp init` sinh ra để xoá bỏ.
console.log("---");
linkCli();

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
 * Symlink `~/.local/bin/alp` → `scripts/alp.cjs`.
 *
 * Không sửa `.bashrc`/`.zshrc`: chỉnh shell profile của người khác là việc phải xin phép,
 * và sửa sai thì họ mất luôn cái shell. Ghi được symlink thì báo; không ghi được (hoặc
 * Windows) thì in path để họ tự thêm vào PATH — hỏng theo kiểu NÓI RA, không im lặng.
 */
function linkCli() {
  const cli = path.join(repoRoot, "scripts", "alp.cjs");
  try { fs.chmodSync(cli, 0o755); } catch {}

  if (process.platform === "win32") {
    console.log(`PATH     thêm vào PATH: ${path.join(repoRoot, "scripts")} (dùng \`alp.ps1\`)`);
    return;
  }

  const dir = path.join(process.env.HOME || "", ".local", "bin");
  const link = path.join(dir, "alp");
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(link) || isBrokenLink(link)) {
      const current = fs.lstatSync(link).isSymbolicLink() ? fs.readlinkSync(link) : null;
      if (current === cli) console.log(`OK       ${link} → ${cli}`);
      else if (current === null) {
        // File thật của người khác trùng tên — không đụng, chỉ nói.
        console.log(`SKIP     ${link} đã tồn tại và không phải symlink của alp-code — chạy trực tiếp: ${cli}`);
        return;
      } else {
        fs.rmSync(link);
        fs.symlinkSync(cli, link);
        console.log(`LINKED   ${link} → ${cli} (trỏ lại từ ${current})`);
      }
    } else {
      fs.symlinkSync(cli, link);
      console.log(`LINKED   ${link} → ${cli}`);
    }
  } catch (e) {
    console.log(`SKIP     không tạo được ${link} (${e.message}) — chạy trực tiếp: ${cli}`);
    return;
  }

  const onPath = (process.env.PATH || "").split(path.delimiter).includes(dir);
  if (!onPath) console.log(`PATH     ${dir} chưa có trong PATH — thêm vào shell profile rồi mở lại terminal`);
}

function isBrokenLink(p) {
  try { fs.lstatSync(p); return true; } catch { return false; }
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
  console.log("bootstrap.cjs [--no-trust]   — compile ACL, trust workspace, chạy doctor");
  process.exit(code);
}

function die(m) {
  console.error(`ERROR    ${m}`);
  process.exit(1);
}

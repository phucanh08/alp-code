#!/usr/bin/env node
// bootstrap.cjs — bước 2 của installer: dựng state, kiểm tra bản cài rồi đưa `alp` vào PATH.
//   bootstrap.cjs --no-path    tạo lệnh `alp` nhưng không sửa shell profile/User PATH
//
// VÌ SAO TÁCH KHỎI install.sh: install.sh/install.ps1 chạy khi chưa có gì trên máy nên buộc
// phải viết bằng shell. Từ lúc code đã nằm trên đĩa trở đi, ba OS dùng chung một
// implementation Node — đúng luật của repo này: .sh/.ps1 là wrapper, .cjs là bản thật duy nhất.
//
// Từ v0.9.0 chỉ dev clone mới build. Bản npm và bản tarball tới máy người dùng đã có sẵn
// `dist/`, nên ở đó bootstrap không gọi `npm ci` hay `tsc` — nó chỉ kiểm tra rằng artifact
// đầy đủ. Đó chính là điều làm việc cài nhanh và không cần toolchain.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { spawnSyncCommand } = require("./lib/delegation/command-runner.cjs");
const CLI = require("./lib/cli-link.cjs");
const P = require("./lib/install-paths.cjs");
const { ensureState } = require("./lib/state.cjs");

const repoRoot = path.resolve(__dirname, "..");
if (!fs.existsSync(path.join(repoRoot, "package.json"))) die("không tìm thấy package.json của alp-code");

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) usage(0);
const skipPath = args.includes("--no-path") || process.env.ALP_NO_PATH === "1";
for (const a of args)
  if (a.startsWith("-") && !["--no-path", "-h", "--help"].includes(a))
    die(`tham số lạ: ${a}`);

const channel = P.detectChannel(repoRoot);

// 1. Build — chỉ ở dev clone. Bản phát hành đã compile sẵn trên máy maintainer.
console.log("---");
if (channel === "dev") {
  mustNpm(["ci", "--include=dev"]);
  mustNpm(["run", "build"]);
  writeBuildHash();
} else {
  console.log(`OK       bản cài ${channel} — dùng dist/ dựng sẵn, không build trên máy này`);
}

// 2. State cục bộ ở `~/.alp`. Không bao giờ đè memory hay preferences.
console.log("---");
let state;
try { state = ensureState({ root: repoRoot }); }
catch (error) { die(error.message); }
for (const entry of state.log) console.log(`${entry.level.padEnd(8)} ${entry.text}`);

// 3. Validate the compiled registry and both runtime adapters without launching them.
validateCodeNative();

// 4. Khám. doctor exit 1 = có finding (DRIFT, TEMPLATE-LEFT…) — đó là thông tin, không
//    phải lỗi cài đặt. Chỉ exit 2 mới là doctor tự gãy.
console.log("---");
const health = run("doctor.cjs", []);
if (health === 2) die("doctor.cjs gãy — bản cài có thể thiếu file");

// 5. `alp` vào PATH. Không có bước này thì mọi lệnh trong README đều phải gõ đường dẫn
//    tuyệt đối tới thư mục cài — tức là vẫn đúng cái phiền mà `alp init` sinh ra để xoá bỏ.
//    Trừ bản npm: ở đó `alp` đã là bin do npm tạo trong global bin dir của chính nó. Tạo
//    thêm một shim thứ hai trong `~/.local/bin` chỉ dựng lên hai lệnh `alp` tranh nhau PATH,
//    và cái do ta tạo sẽ trỏ vào một thư mục npm có toàn quyền xoá ở lần cài kế tiếp.
console.log("---");
if (channel === "npm") {
  console.log("OK       lệnh `alp` do npm cài — installer không tạo thêm shim nào");
} else {
  for (const entry of CLI.installCli(repoRoot, { skipPath }))
    console.log(`${entry.level.padEnd(8)} ${entry.text}`);
}

console.log("---");
console.log(`READY    code-native alp-code tại ${repoRoot} (${channel})`);
console.log(`         memory và state: ${state.stateHome}`);
if (health !== 0) console.log("CHECK    doctor còn cảnh báo ở trên — cài đặt vẫn dùng được, xử lý sau cũng kịp");
console.log("");
console.log("  cd <project-bất-kỳ> && alp init");
console.log("  alp                              # launch main agent");
console.log("");
console.log("Cập nhật về sau: `alp update` — thay thư mục cài, giữ nguyên mọi thứ trong ~/.alp.");

function mustNpm(extra) {
  // spawnSync("npm.cmd", ...) trực tiếp trên Windows ăn EINVAL từ bản Node vá
  // CVE-2024-27980 (chặn spawn .cmd/.bat không qua shell). spawnSyncCommand đã giải
  // quyết đúng việc này ở chỗ khác trong repo — dùng lại thay vì viết version yếu hơn.
  const r = spawnSyncCommand("npm", extra, { stdio: "inherit", cwd: repoRoot });
  if (r.error || r.status !== 0)
    die(`\`npm ${extra.join(" ")}\` thất bại${r.error ? `: ${r.error.message}` : ` (exit ${r.status})`}`);
}

function validateCodeNative() {
  try {
    const { agentRegistry } = require(path.join(repoRoot, "dist", "src", "agents", "registry.js"));
    const { ClaudeRuntimeAdapter } = require(path.join(repoRoot, "dist", "src", "runtime", "claude-adapter.js"));
    const { CodexRuntimeAdapter } = require(path.join(repoRoot, "dist", "src", "runtime", "codex-adapter.js"));
    const agents = agentRegistry.list();
    if (!agents.length || !agentRegistry.has("main")) throw new Error("registry thiếu main agent");
    if (new ClaudeRuntimeAdapter().name !== "claude" || new CodexRuntimeAdapter().name !== "codex")
      throw new Error("runtime adapter name không hợp lệ");
    console.log(`OK       AgentRegistry ${agents.length} agents; runtime adapters claude,codex`);
  } catch (error) {
    die(channel === "dev"
      ? `code-native validation thất bại: ${error.message}`
      : `bản cài ${channel} tại ${repoRoot} không dùng được: ${error.message}\n         Artifact hỏng hoặc thiếu dependency — cài lại thay vì build tại chỗ.`);
  }
}

function writeBuildHash() {
  const crypto = require("crypto");
  const files = [];
  collectTypeScript(path.join(repoRoot, "src"), files);
  const hash = crypto.createHash("sha256");
  for (const file of files.sort()) hash.update(path.relative(repoRoot, file)).update("\0").update(fs.readFileSync(file));
  fs.mkdirSync(path.join(repoRoot, "dist"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "dist", ".alp-source-hash"), `${hash.digest("hex")}\n`);
}

function collectTypeScript(directory, files) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) collectTypeScript(file, files);
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(file);
  }
}

// ---------------------------------------------------------------- tiện ích

function run(script, extra) {
  const file = path.join(repoRoot, "scripts", script);
  const r = spawnSync(process.execPath, [file, ...extra], { stdio: "inherit", cwd: repoRoot });
  if (r.error) die(`không chạy được ${script}: ${r.error.message}`);
  return r.status ?? 1;
}

function usage(code) {
  console.log("bootstrap.cjs [--no-path]   — dựng ~/.alp, validate bản cài, doctor, cài lệnh `alp`");
  console.log("                              (dev clone: npm ci + build trước)");
  process.exit(code);
}

function die(m) {
  console.error(`ERROR    ${m}`);
  process.exit(1);
}

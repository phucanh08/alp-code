#!/usr/bin/env node
// bootstrap.cjs — bước 2 của installer: install/build code-native ALP rồi kiểm tra health.
//   bootstrap.cjs --no-path    tạo lệnh `alp` nhưng không sửa shell profile/User PATH
//
// VÌ SAO TÁCH KHỎI install.sh: install.sh/install.ps1 chạy khi repo CHƯA tồn tại nên
// buộc phải viết bằng shell. Từ lúc có repo trở đi, ba OS dùng chung một implementation
// Node — đúng luật của repo này: .sh/.ps1 là wrapper, .cjs là bản thật duy nhất.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { spawnSyncCommand } = require("./lib/delegation/command-runner.cjs");
const CLI = require("./lib/cli-link.cjs");
const D = require("./lib/delegation/config.cjs");

const repoRoot = path.resolve(__dirname, "..");
if (!fs.existsSync(path.join(repoRoot, "package.json"))) die("không tìm thấy package.json của alp-code");

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) usage(0);
const skipPath = args.includes("--no-path") || process.env.ALP_NO_PATH === "1";
for (const a of args)
  if (a.startsWith("-") && !["--no-path", "-h", "--help"].includes(a))
    die(`tham số lạ: ${a}`);

// 1. Machine-local state. Never overwrite memory or preferences.
console.log("---");
ensureMemory();
ensureDelegationState();
ensureExecutionState();

// 2. Deterministic dependency install and build.
console.log("---");
mustNpm(["ci", "--include=dev"]);
mustNpm(["run", "build"]);
writeBuildHash();

// 3. Validate the compiled registry and both runtime adapters without launching them.
validateCodeNative();

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

console.log("---");
console.log(`READY    code-native alp-code tại ${repoRoot}`);
if (health !== 0) console.log("CHECK    doctor còn cảnh báo ở trên — cài đặt vẫn dùng được, xử lý sau cũng kịp");
console.log("");
console.log("  cd <project-bất-kỳ> && alp init");
console.log("  alp                              # launch main agent");
console.log("");
console.log("Cập nhật về sau: chạy lại installer — rebuild code, giữ memory và runtime preference.");

/**
 * Dựng `memory/` từ `scaffold/memory/` — chỉ những gì còn THIẾU.
 *
 * Trí nhớ là dữ liệu cục bộ của từng máy, không đi theo git. Hệ quả: clone sạch có đủ
 * code nhưng không có một byte trí nhớ nào, và hai file khung là bắt buộc mới chạy được —
 * `memory/projects/INDEX.md` và `memory/INDEX.md` vẫn là dữ liệu Markdown được
 * `MarkdownFileStore` phục vụ qua code-native policy boundary.
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
    path.join(dest, "private"),
  ];
  for (const d of dirs) {
    if (fs.existsSync(d)) continue;
    fs.mkdirSync(d, { recursive: true });
    made.push(path.relative(repoRoot, d) + "/");
  }

  if (!made.length) console.log("OK       memory/ đã đủ khung — không đụng vào nội dung");
  else for (const m of made) console.log(`WROTE    ${m}`);
}

function ensureExecutionState() {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) die("không xác định được HOME/USERPROFILE để tạo execution state");
  const root = path.join(home, ".alp", "executions");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(root, 0o700); } catch {}
  console.log(`OK       execution state ${root}`);
}

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
    die(`code-native validation thất bại: ${error.message}`);
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
  console.log("bootstrap.cjs [--no-path]   — npm ci, build, validate, initialize state, doctor, install CLI");
  process.exit(code);
}

function die(m) {
  console.error(`ERROR    ${m}`);
  process.exit(1);
}

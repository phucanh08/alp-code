#!/usr/bin/env node
// pack-release.cjs — dựng artifact phát hành trên máy maintainer, để máy người dùng không
// phải build gì cả.
//
//   node scripts/pack-release.cjs [--out <thư mục>] [--skip-bundle]
//
// Ra hai file, cho hai channel cài:
//
//   alp-code-<version>.tgz              → `npm publish`. npm tự cài `zod` cho người dùng.
//   alp-code-v<version>-bundle.tar.gz   → asset của GitHub Release. Cùng cây file đó, kèm sẵn
//                                         `node_modules` chỉ có dependency runtime, giải nén
//                                         ra là chạy — không git, không npm, không tsc.
//
// Bundle tồn tại vì đó là toàn bộ lý do có channel thứ hai: máy không có npm, hoặc mạng chặn
// registry. Một tarball vẫn bắt `npm install` sau khi giải nén thì không giải quyết gì.
//
// Script CỐ Ý dừng trước `npm publish` và `gh release upload`. Đẩy artifact ra ngoài máy là
// việc principal quyết, giống hệt `cut-release.cjs` dừng trước `git push`.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { REQUIRED, verifyEntries } = require("./lib/release-manifest.cjs");

const repoRoot = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) usage(0);

const skipBundle = args.includes("--skip-bundle");
let outDir = path.join(repoRoot, "build");
for (let index = 0; index < args.length; index += 1) {
  const value = args[index];
  if (value === "--out") {
    outDir = path.resolve(args[++index] || die("--out thiếu giá trị"));
  } else if (value.startsWith("-") && !["--skip-bundle", "-h", "--help"].includes(value)) {
    die(`tham số lạ: ${value}`);
  }
}

const version = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
if (!version) die("package.json không có version");

fs.mkdirSync(outDir, { recursive: true });

// ------------------------------------------------------------------ npm tarball
// `npm pack` chạy `prepack` (= build) và áp đúng `files` của package.json, nên nó cho ra CHÍNH
// cây file sẽ được publish. Tự nén tay ở đây nghĩa là artifact GitHub và artifact npm có thể
// khác nhau mà không ai biết.
log("BUILD", "npm pack (chạy prepack → tsc)");
const packed = run("npm", ["pack", "--pack-destination", outDir, "--json"], { cwd: repoRoot, capture: true });
const tarball = path.join(outDir, parsePackOutput(packed.stdout));
log("PACK", `${tarball} (${size(tarball)})`);

const entries = listTarball(tarball).map((entry) => entry.replace(/^package\//, ""));
verifyContents(entries);
log("VERIFY", `${entries.length} file — đủ ${REQUIRED.length} file bắt buộc, không lọt src/ test/ memory/`);

// ---------------------------------------------------------------- bundle tarball
if (skipBundle) {
  log("SKIP", "--skip-bundle: không dựng artifact GitHub Release");
} else {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "alp-pack-"));
  try {
    run("tar", ["-xzf", tarball, "-C", staging, "--strip-components=1"]);
    // Lock của repo đi kèm để `npm ci` cho ra đúng bộ dependency đã test, không phải bộ mới
    // nhất mà registry trả về hôm nay. Nó không nằm trong `files` vì bản npm không cần.
    fs.copyFileSync(path.join(repoRoot, "package-lock.json"), path.join(staging, "package-lock.json"));
    log("DEPS", "npm ci --omit=dev trong staging");
    run("npm", ["ci", "--omit=dev", "--ignore-scripts"], { cwd: staging });
    fs.rmSync(path.join(staging, "package-lock.json"), { force: true });

    verifySelfContained(staging);
    log("VERIFY", "artifact tự chạy được: registry + hai runtime adapter load từ staging");

    const bundle = path.join(outDir, `alp-code-v${version}-bundle.tar.gz`);
    fs.rmSync(bundle, { force: true });
    run("tar", ["-czf", bundle, "-C", staging, "."]);
    log("BUNDLE", `${bundle} (${size(bundle)})`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

console.log("");
console.log(`READY    artifact v${version} nằm trong ${outDir}. CHƯA đẩy đi đâu — cần principal duyệt:`);
console.log(`           npm publish ${show(tarball)}`);
// Không in lệnh upload cho file không tồn tại: người đọc báo cáo sẽ copy nguyên dòng đó.
if (!skipBundle)
  console.log(`           gh release upload v${version} ${show(path.join(outDir, `alp-code-v${version}-bundle.tar.gz`))}`);

// ---------------------------------------------------------------------- tiện ích

function verifyContents(entries) {
  const { missing, leaked } = verifyEntries(entries);
  if (missing.length) die(`artifact thiếu file bắt buộc: ${missing.join(", ")}`);
  if (leaked.length) die(`artifact chứa file không được phát hành: ${leaked.slice(0, 10).join(", ")}`);
}

/**
 * Load thật registry và hai adapter từ staging, với cwd ở ngoài repo.
 *
 * Đây là chỗ duy nhất phát hiện được "quên một dependency runtime": ở trong repo, `require`
 * leo lên `node_modules` của repo và mọi thứ đều chạy — đúng đến khi artifact tới máy người
 * dùng, nơi không có cây đó. Staging nằm trong tmpdir chính vì lý do này.
 */
function verifySelfContained(staging) {
  const probe = [
    `const { agentRegistry } = require(${JSON.stringify(path.join(staging, "dist", "src", "agents", "registry.js"))});`,
    `const { ClaudeRuntimeAdapter } = require(${JSON.stringify(path.join(staging, "dist", "src", "runtime", "claude-adapter.js"))});`,
    `const { CodexRuntimeAdapter } = require(${JSON.stringify(path.join(staging, "dist", "src", "runtime", "codex-adapter.js"))});`,
    'if (!agentRegistry.has("main")) throw new Error("registry thiếu main agent");',
    'if (new ClaudeRuntimeAdapter().name !== "claude" || new CodexRuntimeAdapter().name !== "codex") throw new Error("adapter name sai");',
  ].join("\n");
  const result = spawnSync(process.execPath, ["-e", probe], {
    cwd: staging,
    encoding: "utf8",
    env: { ...process.env, NODE_PATH: "" },
  });
  if (result.status !== 0)
    die(`artifact không tự chạy được: ${(result.stderr || "").trim().split("\n").slice(0, 3).join(" · ")}`);
}

function listTarball(tarball) {
  return run("tar", ["-tzf", tarball], { capture: true }).stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.endsWith("/"));
}

function parsePackOutput(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    const filename = Array.isArray(parsed) ? parsed[0]?.filename : parsed?.filename;
    if (filename) return path.basename(filename);
  } catch { /* npm cũ in text thay vì JSON */ }
  const line = stdout.split("\n").map((value) => value.trim()).filter(Boolean).at(-1);
  if (!line || !line.endsWith(".tgz")) die(`không đọc được tên tarball từ npm pack: ${stdout.slice(0, 200)}`);
  return path.basename(line);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
  });
  if (result.error) die(`không chạy được \`${command}\`: ${result.error.message}`);
  if (result.status !== 0)
    die(`\`${command} ${commandArgs.join(" ")}\` thất bại (exit ${result.status})${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
  return result;
}

/** Đường dẫn tương đối khi còn nằm trong repo, tuyệt đối khi đã ra ngoài — dán vào shell là chạy. */
function show(file) {
  const relative = path.relative(repoRoot, file);
  return relative.startsWith("..") ? file : relative;
}

function size(file) {
  const bytes = fs.statSync(file).size;
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} kB`;
}

function log(level, message) {
  console.log(`${level.padEnd(9)}${message}`);
}

function usage(code) {
  console.log("pack-release.cjs [--out <thư mục>] [--skip-bundle]");
  console.log("  dựng .tgz cho npm publish và bundle .tar.gz cho GitHub Release. KHÔNG đẩy đi.");
  process.exit(code);
}

function die(message) {
  console.error(`ERROR    ${message}`);
  process.exit(1);
}

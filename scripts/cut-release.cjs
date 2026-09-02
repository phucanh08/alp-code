#!/usr/bin/env node
// cut-release.cjs — bump version, viết CHANGELOG, tạo commit + tag cho một bản release.
//
//   node scripts/cut-release.cjs <patch|minor|major|X.Y.Z> [--dry-run] [--no-commit] [--allow-empty]
//
// Script CỐ Ý dừng trước `git push`. Push tag là việc ra ngoài máy — principal quyết định,
// không phải script. Xem .claude/skills/release/SKILL.md cho quy trình đầy đủ.

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const semver = require("./lib/semver-lite.cjs");
const { assertCleanWorkingTree } = require("./lib/update.cjs");

const repoRoot = process.env.ALP_REPO_ROOT || path.resolve(__dirname, "..");
const packageFile = path.join(repoRoot, "package.json");
const lockFile = path.join(repoRoot, "package-lock.json");
const changelogFile = path.join(repoRoot, "CHANGELOG.md");
const UNRELEASED = "## [Chưa phát hành]";
const DEFAULT_SLUG = "phucanh08/alp-code";

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) usage(0);

const dryRun = args.includes("--dry-run");
const noCommit = args.includes("--no-commit");
const allowEmpty = args.includes("--allow-empty");
const positional = args.filter((value) => !value.startsWith("-"));
if (positional.length !== 1) usage(1, "cần đúng một tham số: patch | minor | major | X.Y.Z");
for (const value of args)
  if (value.startsWith("-") && !["--dry-run", "--no-commit", "--allow-empty", "-h", "--help"].includes(value))
    die(`tham số lạ: ${value}`);

const current = readCurrentVersion();
const next = resolveNextVersion(positional[0], current);
const tag = `v${next}`;

// ------------------------------------------------------------------ preflight
if (semver.compare(next, current) <= 0) die(`${next} không lớn hơn version hiện tại ${current}`);
if (!dryRun && !noCommit) {
  const clean = assertCleanWorkingTree(repoRoot, process.env);
  if (!clean.ok) die(clean.message);
}
if (git(["tag", "-l", tag]).trim()) die(`tag ${tag} đã tồn tại — không ghi đè; chọn số kế tiếp`);

// ------------------------------------------------------------------ soạn nội dung
// CRLF trên working tree (vd. core.autocrlf=true của Windows) làm `text.indexOf(UNRELEASED
// + "\n")` không khớp dù nội dung committed luôn là LF — chuẩn hoá trước khi so khớp.
const changelog = rewriteChangelog(fs.readFileSync(changelogFile, "utf8").replace(/\r\n/g, "\n"), next, today());
const packageJson = rewriteVersion(fs.readFileSync(packageFile, "utf8"), current, next);
const lock = fs.existsSync(lockFile) ? rewriteLockVersion(fs.readFileSync(lockFile, "utf8"), next) : null;
const written = ["package.json", ...(lock ? ["package-lock.json"] : []), "CHANGELOG.md"];

log("VERSION", `${current} → ${next}`);
log("ENTRY", `[${next}] - ${today()} (${changelog.entryLines} dòng nội dung)`);

if (dryRun) {
  log("DRY-RUN", "không ghi file, không commit, không tag");
  process.exit(0);
}

fs.writeFileSync(packageFile, packageJson);
if (lock) fs.writeFileSync(lockFile, lock);
fs.writeFileSync(changelogFile, changelog.text);
log("WRITE", written.join(" + "));

if (noCommit) {
  log("SKIP", "--no-commit: chưa tạo commit/tag");
  console.log(`NEXT     git add ${written.join(" ")} && git commit -m "chore(release): ${tag}" && git tag ${tag}`);
  process.exit(0);
}

// ------------------------------------------------------------------ commit + tag
mustGit(["add", ...written]);
mustGit(["commit", "-m", `chore(release): ${tag}`]);
mustGit(["tag", tag]);
log("COMMIT", `${git(["rev-parse", "--short", "HEAD"]).trim()} chore(release): ${tag}`);
log("TAG", tag);
console.log("");
console.log(`READY    ${tag} sẵn sàng. Chưa push — cần principal duyệt:`);
console.log("           git push origin main --tags");

// ------------------------------------------------------------------ helpers

function readCurrentVersion() {
  const parsed = JSON.parse(fs.readFileSync(packageFile, "utf8"));
  if (typeof parsed.version !== "string") die("package.json thiếu field `version`");
  if (!semver.isValid(parsed.version)) die(`package.json.version không hợp lệ: ${parsed.version}`);
  return parsed.version;
}

function resolveNextVersion(requested, from) {
  const parts = semver.parse(from);
  if (requested === "patch") return `${parts.major}.${parts.minor}.${parts.patch + 1}`;
  if (requested === "minor") return `${parts.major}.${parts.minor + 1}.0`;
  if (requested === "major") return `${parts.major + 1}.0.0`;
  if (!semver.isValid(requested)) die(`version không hợp lệ: ${requested} (cần patch|minor|major|X.Y.Z)`);
  return requested.replace(/^v/, "");
}

/** Đổi đúng dòng `"version"` thay vì stringify lại cả file, để giữ nguyên format. */
function rewriteVersion(text, from, to) {
  const pattern = new RegExp(`("version"\\s*:\\s*")${escapeRegExp(from)}(")`);
  if (!pattern.test(text)) die("không tìm thấy dòng `\"version\"` trong package.json");
  return text.replace(pattern, `$1${to}$2`);
}

/**
 * Lockfile giữ version ở hai chỗ: gốc và `packages[""]`. Không dùng regex vì một dependency
 * bất kỳ cũng có dòng `"version"` cùng mức thụt lề — sửa nhầm thì lock hỏng âm thầm. Round-trip
 * JSON.parse/stringify với indent 2 tái tạo đúng byte-for-byte định dạng npm ghi ra.
 */
function rewriteLockVersion(text, version) {
  const lock = JSON.parse(text);
  lock.version = version;
  if (lock.packages && lock.packages[""]) lock.packages[""].version = version;
  return `${JSON.stringify(lock, null, 2)}\n`;
}

/**
 * Chuyển mục `[Chưa phát hành]` thành `[X.Y.Z] - ngày`, mở lại một mục rỗng ở trên, rồi
 * cập nhật link compare ở cuối file.
 */
function rewriteChangelog(text, version, date) {
  const start = text.indexOf(`${UNRELEASED}\n`);
  if (start < 0) die(`CHANGELOG.md thiếu tiêu đề \`${UNRELEASED}\``);
  const bodyStart = start + UNRELEASED.length + 1;
  const nextHeading = text.indexOf("\n## [", bodyStart);
  const bodyEnd = nextHeading < 0 ? text.length : nextHeading + 1;
  const body = text.slice(bodyStart, bodyEnd);

  const entryLines = body.split("\n").filter((line) => line.trim()).length;
  if (!entryLines && !allowEmpty)
    die(`mục \`${UNRELEASED}\` đang rỗng — không có gì để kể cho người dùng. Viết CHANGELOG trước, hoặc --allow-empty`);

  const released = `## [${version}] - ${date}\n${body}`;
  const text2 = `${text.slice(0, start)}${UNRELEASED}\n\n${released}${text.slice(bodyEnd)}`;
  return { text: rewriteLinks(text2, version), entryLines };
}

function rewriteLinks(text, version) {
  const pattern = /^\[Chưa phát hành\]:\s*(\S*?\/([^/\s]+\/[^/\s]+))\/compare\/(v[^.\s]+\.[^.\s]+\.[^.\s]+)\.\.\.HEAD\s*$/m;
  const match = pattern.exec(text);
  if (!match) {
    // Không có link để suy ra slug/version trước: chỉ nối link mới vào cuối file.
    return `${text.replace(/\s*$/, "\n")}[${version}]: https://github.com/${DEFAULT_SLUG}/releases/tag/v${version}\n`;
  }
  const [line, base, , previousTag] = match;
  const compare = base.replace(/\/compare$/, "");
  return text.replace(
    line,
    `[Chưa phát hành]: ${compare}/compare/v${version}...HEAD\n` +
    `[${version}]: ${compare}/compare/${previousTag}...v${version}`,
  );
}

function today() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function git(args) {
  const result = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return String(result.stdout || "");
}

function mustGit(args) {
  const result = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0)
    die(`git ${args.join(" ")} thất bại: ${String(result.stderr || result.stdout || result.error?.message).trim()}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function log(level, message) {
  console.log(`${level.padEnd(9)}${message}`);
}

function die(message) {
  console.error(`ERROR    ${message}`);
  process.exit(1);
}

function usage(code, message) {
  if (message) console.error(`ERROR    ${message}`);
  console.log("cut-release.cjs <patch|minor|major|X.Y.Z> [--dry-run] [--no-commit] [--allow-empty]");
  console.log("  bump package.json, viết CHANGELOG, tạo commit + tag. KHÔNG push.");
  process.exit(code);
}

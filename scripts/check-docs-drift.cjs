#!/usr/bin/env node
// check-docs-drift.cjs — tìm những chỗ trong docs/user/ còn nói về bản cũ.
//
//   node scripts/check-docs-drift.cjs [--version X.Y.Z] [--json]
//
// docs/user/ được xuất bản lên alp.anhlp.com và mô tả hành vi của chính repo này, nên
// cắt release mà không rà nó là đẩy tài liệu sai ra ngoài. Script chỉ ĐO và chỉ chỗ;
// nó không tự sửa, vì hai trong ba nhóm dưới đây cần người quyết định.
//
// Ba nhóm:
//
//   VERSION  chuỗi version ALP khác version sắp phát hành
//   PIN      commit được trích dẫn nhưng không nằm trên nhánh hiện tại
//   PREVIEW  banner "chưa có trong stable vX.Y.Z" — phải XOÁ nếu tính năng đã vào stable,
//            không phải đổi số. Đổi số là biến docs từ cũ thành sai.
//
// Thoát 1 khi có việc cần quyết, 0 khi sạch. Xem .claude/skills/release/SKILL.md bước 2.

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = process.env.ALP_REPO_ROOT || path.resolve(__dirname, "..");
const docsRoot = path.join(repoRoot, "docs/user");
const packageFile = path.join(repoRoot, "package.json");

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) usage(0);
const asJson = args.includes("--json");
const requestedVersion = valueOf("--version");
for (const value of args)
  if (value.startsWith("-") && !["--version", "--json", "-h", "--help"].includes(value) && !isValue(value))
    die(`tham số lạ: ${value}`);

if (!fs.existsSync(docsRoot)) die(`không thấy ${path.relative(repoRoot, docsRoot)}`);

const target = requestedVersion || JSON.parse(fs.readFileSync(packageFile, "utf8")).version;
if (!/^\d+\.\d+\.\d+$/.test(target)) die(`version không hợp lệ: ${target}`);

// Tag đã phát hành dùng để nhận ra một chuỗi semver trần có phải version ALP không.
// Không có nó thì "22.12.0" trong một câu về Node cũng bị báo nhầm.
const releasedTags = new Set(
  git(["tag", "-l"])
    .split("\n")
    .map((line) => line.trim().replace(/^v/, ""))
    .filter(Boolean),
);

const findings = [];
const warnings = [];

for (const file of markdownFiles(docsRoot)) {
  const rel = path.relative(repoRoot, file);
  const lines = fs.readFileSync(file, "utf8").split("\n");

  lines.forEach((line, index) => {
    const at = { file: rel, line: index + 1, text: line.trim().slice(0, 110) };
    checkVersions(line, at);
    checkPins(line, at);
    checkPreview(line, at, lines, index);
  });
}

report();
process.exit(findings.length ? 1 : 0);

// ------------------------------------------------------------------- kiểm tra

function checkVersions(line, at) {
  // `v` viết liền là quy ước version ALP trong docs; semver trần chỉ tính khi trùng một
  // tag đã phát hành.
  for (const match of line.matchAll(/(v?)(\d+\.\d+\.\d+)/g)) {
    const [, prefix, version] = match;
    if (!prefix && !releasedTags.has(version)) continue;
    if (version === target) continue;
    findings.push({ kind: "VERSION", ...at, detail: `${prefix}${version} ≠ v${target}` });
  }
}

function checkPins(line, at) {
  for (const sha of shasIn(line)) {
    const resolved = git(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]).trim();
    if (!resolved) {
      findings.push({ kind: "PIN", ...at, detail: `${sha} không có trong repo local` });
      continue;
    }
    if (!isAncestor(resolved)) {
      findings.push({ kind: "PIN", ...at, detail: `${sha} không nằm trên nhánh hiện tại` });
    }
  }
}

function checkPreview(line, at, lines, index) {
  // Chỉ dòng mở một aside của Starlight. Chữ "preview" trong câu văn bình thường không
  // phải banner, và bắt cả hai thì report đầy tiếng ồn rồi không ai đọc nữa.
  const aside = line.match(/^:::[a-z]+\[([^\]]*)\]/i);
  if (!aside || !/preview|chưa có trong stable/i.test(aside[1])) return;

  // Version nằm ở tiêu đề (`[Preview, chưa có trong stable v0.10.4]`) hoặc ở thân aside
  // (`:::caution[Preview]` rồi câu sau mới nói version). Cả hai đều là cách viết đang có
  // trong docs, nên đọc cả hai — không thì mỗi lần release lại phải bỏ qua một WARN cố định.
  const version = aside[1].match(/v?(\d+\.\d+\.\d+)/) || asideBody(lines, index).match(/v?(\d+\.\d+\.\d+)/);
  if (!version) {
    warnings.push({ kind: "PREVIEW", ...at, detail: "banner không nói version nào — tự đọc rồi quyết" });
    return;
  }
  if (version[1] === target) return;
  findings.push({ kind: "PREVIEW", ...at, detail: `banner nói v${version[1]}, đang phát hành v${target}` });
}

/** Thân của aside mở tại `index`, tới dòng `:::` đóng. */
function asideBody(lines, index) {
  const body = [];
  for (let i = index + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === ":::") break;
    body.push(lines[i]);
  }
  return body.join("\n");
}

// --------------------------------------------------------------------- tiện ích

/** Sha 40 ký tự ở bất kỳ đâu; sha ngắn chỉ tính khi nằm trong backtick hoặc URL GitHub. */
function shasIn(line) {
  const found = new Set();
  for (const match of line.matchAll(/\b[0-9a-f]{40}\b/g)) found.add(match[0]);
  for (const match of line.matchAll(/`([0-9a-f]{7,12})`/g)) found.add(match[1]);
  for (const match of line.matchAll(/github\.com\/[^/]+\/[^/]+\/(?:commit|blob|tree)\/([0-9a-f]{7,40})\b/g))
    found.add(match[1]);

  // Sha ngắn là tiền tố của sha dài cùng dòng thì chỉ báo một lần.
  const all = [...found].sort((a, b) => b.length - a.length);
  return all.filter((sha, index) => !all.slice(0, index).some((longer) => longer.startsWith(sha)));
}

function isAncestor(sha) {
  return spawnSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { cwd: repoRoot }).status === 0;
}

function markdownFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(full));
    // README.md là hướng dẫn cho người sửa docs, không phải một trang của site.
    else if (entry.name.endsWith(".md") && entry.name !== "README.md") out.push(full);
  }
  return out.sort();
}

function report() {
  if (asJson) {
    console.log(JSON.stringify({ target, findings, warnings }, null, 2));
    return;
  }

  log("TARGET", `v${target} · ${path.relative(repoRoot, docsRoot)}`);

  for (const group of ["VERSION", "PIN", "PREVIEW"]) {
    const rows = findings.filter((f) => f.kind === group);
    if (!rows.length) continue;
    console.log("");
    log(group, `${rows.length} chỗ`);
    for (const row of rows) console.log(`           ${row.file}:${row.line} — ${row.detail}`);
  }

  for (const row of warnings) {
    console.log("");
    log("WARN", `${row.file}:${row.line} — ${row.detail}`);
  }

  console.log("");
  if (!findings.length) {
    log("OK", `docs/user/ đã nói về v${target}`);
    return;
  }
  log("TODO", `${findings.length} chỗ cần quyết trước khi bump.`);
  console.log("           Banner preview: XOÁ nếu tính năng đã vào stable, không đổi số.");
}

function valueOf(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? "" : (args[index + 1] || "");
}

function isValue(value) {
  const index = args.indexOf(value);
  return index > 0 && args[index - 1] === "--version";
}

function git(argv) {
  const result = spawnSync("git", argv, { cwd: repoRoot, encoding: "utf8" });
  return result.stdout || "";
}

function log(level, message) {
  console.log(`${level.padEnd(9)}${message}`);
}

function die(message) {
  console.error(`LỖI      ${message}`);
  process.exit(1);
}

function usage(code, message) {
  if (message) console.error(`LỖI      ${message}`);
  console.log("check-docs-drift.cjs [--version X.Y.Z] [--json]");
  console.log("  tìm chỗ trong docs/user/ còn nói về bản cũ. Không sửa gì. Thoát 1 khi có việc cần quyết.");
  process.exit(code);
}

#!/usr/bin/env node
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const script = path.join(__dirname, "check-docs-drift.cjs");
const sandbox = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "alp-docs-drift-"));

let failed = 0;
try {
  testCleanDocsPass();
  testStaleVersion();
  testBareSemverOnlyWhenTagged();
  testPinOffBranch();
  testPreviewBanner();
  testReadmeIsNotAPage();
  testJsonShape();
  if (failed) process.exitCode = 1;
  else console.log("OK               check-docs-drift: version/pin/preview + các trường hợp không được báo nhầm");
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

function testCleanDocsPass() {
  const repo = makeRepo("clean", { "index.md": "Bản stable là `v0.4.0`." });
  const run = check_(repo, []);
  check("docs khớp version → thoát 0", () => assert.strictEqual(run.status, 0, run.stdout + run.stderr));
  check("in OK", () => assert.match(run.stdout, /OK\s+docs\/user\/ đã nói về v0\.4\.0/));
}

function testStaleVersion() {
  const repo = makeRepo("stale", { "index.md": "Bản stable là `v0.3.0`." });
  const run = check_(repo, []);
  check("version cũ → thoát 1", () => assert.strictEqual(run.status, 1, run.stdout));
  check("chỉ đúng file và dòng", () => assert.match(run.stdout, /VERSION\s+1 chỗ[\s\S]*docs\/user\/index\.md:1 — v0\.3\.0 ≠ v0\.4\.0/));
}

function testBareSemverOnlyWhenTagged() {
  const repo = makeRepo("bare", { "index.md": "Cần Node.js 22.12.0 trở lên.\n\nBản 0.3.0 đã cũ." });
  const run = check_(repo, []);
  check("semver trần không trùng tag nào thì bỏ qua", () => assert(!run.stdout.includes("22.12.0"), run.stdout));
  check("semver trần trùng tag đã phát hành thì bắt", () => assert.match(run.stdout, /index\.md:3 — 0\.3\.0 ≠ v0\.4\.0/));
}

function testPinOffBranch() {
  const repo = makeRepo("pin", { "index.md": "placeholder" });
  // Commit chỉ tồn tại trên nhánh khác: đúng tình huống docs trích một commit chưa lên main.
  git(repo, ["checkout", "-q", "-b", "feature"]);
  fs.writeFileSync(path.join(repo, "note.txt"), "x");
  commit(repo, "ngoài nhánh");
  const offBranch = git(repo, ["rev-parse", "HEAD"]).trim();
  git(repo, ["checkout", "-q", "main"]);

  const onBranch = git(repo, ["rev-parse", "HEAD"]).trim();
  write(repo, "index.md", [
    `Kiểm chứng tại commit \`${offBranch.slice(0, 7)}\`.`,
    `Bản trên nhánh: \`${onBranch.slice(0, 7)}\`.`,
    `Không tồn tại: \`deadbee\`.`,
  ].join("\n"));
  commit(repo, "docs");

  const run = check_(repo, []);
  check("commit ngoài nhánh → báo", () => assert.match(run.stdout, new RegExp(`${offBranch.slice(0, 7)} không nằm trên nhánh hiện tại`)));
  check("commit trên nhánh → không báo", () => assert(!run.stdout.includes(`${onBranch.slice(0, 7)} không`), run.stdout));
  check("sha không có trong repo → báo riêng", () => assert.match(run.stdout, /deadbee không có trong repo local/));
}

function testPreviewBanner() {
  const repo = makeRepo("preview", {
    "a.md": ":::caution[Preview, chưa có trong stable `v0.3.0`]\nnội dung\n:::",
    "b.md": ":::caution[Preview, chưa có trong stable `v0.4.0`]\nnội dung\n:::",
    "c.md": ":::note[Preview]\nnội dung\n:::",
    // Version ở thân aside, không ở tiêu đề — cách viết có thật trong reference/cli.md.
    "e.md": ":::caution[Preview]\nNhóm `alp agent …` chưa có trong stable binary `v0.3.0`.\n:::",
    "f.md": ":::caution[Preview]\nChưa có trong stable binary `v0.4.0`.\n:::",
    "d.md": "Chạy `alp context pin next-action -- \"chạy production preview\"` để ghim.",
  });
  const run = check_(repo, []);
  check("banner nói version cũ → báo", () => assert.match(run.stdout, /PREVIEW[\s\S]*a\.md:1 — banner nói v0\.3\.0/));
  check("banner nói đúng version → im", () => assert(!run.stdout.includes("b.md"), run.stdout));
  check("banner không có version → chỉ WARN, không tính là finding", () => {
    assert.match(run.stdout, /WARN\s+docs\/user\/c\.md:1/);
    assert(!blockOf(run.stdout, "PREVIEW").includes("c.md"), run.stdout);
  });
  check("chữ preview trong câu văn thường → không báo", () => assert(!run.stdout.includes("d.md"), run.stdout));
  check("version ở thân aside, nói bản cũ → báo", () => assert.match(blockOf(run.stdout, "PREVIEW"), /e\.md:1 — banner nói v0\.3\.0/));
  check("version ở thân aside, nói đúng bản → im", () => assert(!run.stdout.includes("f.md"), run.stdout));
}

function testReadmeIsNotAPage() {
  const repo = makeRepo("readme", { "index.md": "Bản stable là `v0.4.0`.", "README.md": "Xem `v0.1.0` cũ." });
  const run = check_(repo, []);
  check("README.md không bị quét", () => assert.strictEqual(run.status, 0, run.stdout));
}

function testJsonShape() {
  const repo = makeRepo("json", { "index.md": "Bản stable là `v0.3.0`." });
  const run = check_(repo, ["--json"]);
  const payload = JSON.parse(run.stdout);
  check("--json ra target/findings/warnings", () => {
    assert.strictEqual(payload.target, "0.4.0");
    assert.strictEqual(payload.findings.length, 1);
    assert.strictEqual(payload.findings[0].kind, "VERSION");
    assert.strictEqual(payload.findings[0].line, 1);
    assert(Array.isArray(payload.warnings));
  });
  check("--version ghi đè package.json", () => {
    const override = check_(repo, ["--version", "0.3.0"]);
    assert.strictEqual(override.status, 0, override.stdout);
  });
}

// ------------------------------------------------------------------- tiện ích

function makeRepo(name, files) {
  const repo = path.join(sandbox, name);
  fs.mkdirSync(path.join(repo, "docs/user"), { recursive: true });
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "alp-code", version: "0.4.0" }, null, 2) + "\n");
  for (const [file, body] of Object.entries(files)) write(repo, file, body);

  git(repo, ["init", "-q", "-b", "main"]);
  commit(repo, "seed");
  // Tag để phân biệt semver trần của ALP với version của thứ khác.
  for (const tag of ["v0.3.0", "v0.4.0"]) git(repo, ["tag", tag]);
  return repo;
}

/** Một khối của report = từ dòng tiêu đề tới dòng trắng kế tiếp. */
function blockOf(stdout, kind) {
  const lines = stdout.split("\n");
  const start = lines.findIndex((line) => line.startsWith(kind));
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.trim() === "");
  return rest.slice(0, end === -1 ? rest.length : end).join("\n");
}

function write(repo, file, body) {
  const full = path.join(repo, "docs/user", file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body + "\n");
}

function commit(repo, message) {
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=ALP Test", "-c", "user.email=test@alp.local", "commit", "-qm", message]);
}

function check_(repo, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ALP_REPO_ROOT: repo },
  });
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function check(label, assertion) {
  try {
    assertion();
    console.log(`PASS             ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL             ${label}\n                 ${error.message}`);
  }
}

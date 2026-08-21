#!/usr/bin/env node
// session-end.cjs — nhắc việc ghi nhớ khi phiên kết thúc.
//
// KHÔNG GỌI LLM. Chỉ việc cơ học: so mtime, đối chiếu index, chạy script.
// Trích fact bằng LLM là việc của agent (skill `agent-memory`), không phải của hook —
// tốn token, ghi rác, khó kiểm soát.
//
// Không có gì đáng nói → IM LẶNG. Nhắc thừa dạy agent bỏ qua lời nhắc.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const L = require(path.join(__dirname, "..", "scripts", "lib", "loadout.cjs"));

main();

function main() {
  let notes = [];
  try {
    notes = collect();
  } catch (e) {
    notes = [`session-end.cjs lỗi: ${e.message}`];
  }
  if (notes.length) {
    process.stdout.write(
      JSON.stringify({ systemMessage: ["Trước khi đóng phiên:", ...notes.map((n) => `- ${n}`)].join("\n") })
    );
  }
  process.exit(0);
}

function collect() {
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const repoRoot = L.findRepoRoot(cwd);
  if (!repoRoot) return [];

  const notes = [];
  const memDir = path.join(repoRoot, "memory");

  // 1. File trong memory/shared/ chưa được trỏ trong INDEX.md.
  const indexFile = path.join(memDir, "INDEX.md");
  if (fs.existsSync(indexFile)) {
    const index = fs.readFileSync(indexFile, "utf8");
    const orphans = walk(path.join(memDir, "shared"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => path.relative(memDir, f).split(path.sep).join("/"))
      .filter((rel) => !index.includes(rel));
    for (const o of orphans) notes.push(`\`memory/${o}\` chưa có dòng trong \`memory/INDEX.md\``);
  }

  // 2. L1 bị chạm mà `updated:` chưa đổi + 3. đồng bộ lại L0.
  const sync = path.join(repoRoot, "scripts", "sync-project-index.sh");
  if (fs.existsSync(sync)) {
    const out = run(sync, ["--write"]);
    for (const line of out.split("\n")) {
      if (/^(DRIFT|ORPHAN|MISSING|MISMATCH)/.test(line)) notes.push(line.trim());
      if (/^WROTE/.test(line)) notes.push("L0 `memory/projects/INDEX.md` đã được sinh lại");
    }
  }

  return notes;
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return e.stdout || "";
  }
}

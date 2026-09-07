#!/usr/bin/env node
// Code-native ALP health checks. Exit 0 healthy, 1 actionable findings, 2 doctor failure.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const D = require("./lib/delegation/config.cjs");
const P = require("./lib/install-paths.cjs");

const quiet = process.argv.includes("--quiet");
const repoRoot = path.resolve(__dirname, "..");
const channel = P.detectChannel(repoRoot);
// Cách sửa một bản cài khác hẳn cách sửa một dev clone: bản phát hành không có `src/` lẫn
// devDependencies, nên bảo người dùng chạy `npm run build` ở đó là chỉ đường vào ngõ cụt.
const REBUILD = channel === "dev" ? "node scripts/bootstrap.cjs --no-path" : "alp update";
const signals = [];
const observations = [];
const signal = (tag, msg, fix) => signals.push({ tag, msg, fix });
const observe = (tag, msg) => observations.push({ tag, msg });
const compiled = (file) => path.join(repoRoot, "dist", "src", ...file.split("/")) + ".js";

function checkAgentRegistry() {
  try {
    const { agentRegistry } = require(compiled("agents/registry"));
    const agents = agentRegistry.list();
    if (!agents.length || !agentRegistry.has("main")) throw new Error("missing main agent");
    observe("AGENT-REGISTRY", `${agents.length} agents valid`);
  } catch (error) { signal("AGENT-REGISTRY", error.message, REBUILD); }
}

async function checkRuntimes() {
  const runtimes = [
    ["RUNTIME-CLAUDE", "ClaudeRuntimeAdapter", "runtime/claude-adapter", "Install Claude Code and ensure claude is on PATH."],
    ["RUNTIME-CODEX", "CodexRuntimeAdapter", "runtime/codex-adapter", "Install Codex CLI and ensure codex is on PATH."],
  ];
  for (const [tag, exportName, moduleName, fallback] of runtimes) {
    try {
      const Adapter = require(compiled(moduleName))[exportName];
      const health = await new Adapter().probe();
      if (health.ok) observe(tag, health.message);
      else signal(tag, health.message, health.remediation || fallback);
    } catch (error) { signal(tag, error.message, REBUILD); }
  }
}

async function checkMemory() {
  const root = P.memoryRoot();
  try {
    const { MarkdownFileStore } = require(compiled("memory/adapters/markdown-file-store"));
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK);
    const store = new MarkdownFileStore({ root });
    await store.search({ scope: "shared", text: "", limit: 1 });
    observe("MEMORY-ADAPTER", `${root} readable and writable`);
  } catch (error) { signal("MEMORY-ADAPTER", error.message, REBUILD); }
}

function checkExecutionState() {
  let roots;
  try { roots = [P.executionsDir()]; }
  catch (error) { return signal("EXECUTION-STATE", error.message, "set HOME rồi chạy lại alp doctor"); }
  try { roots.push(D.loadDelegationConfig(repoRoot).stateDir); }
  catch (error) { signal("EXECUTION-STATE", `delegation config invalid: ${error.message}`, "sửa alp.config.yaml"); }
  for (const root of new Set(roots)) {
    try {
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      const mode = fs.statSync(root).mode & 0o777;
      if (process.platform !== "win32" && (mode & 0o077))
        signal("EXECUTION-STATE", `${root} permissions are ${mode.toString(8)}`, `chmod 700 ${JSON.stringify(root)}`);
      for (const entry of fs.readdirSync(root)) if (/^\..+\.tmp$/.test(entry))
        signal("ORPHAN-EXECUTION", path.join(root, entry), `rm -rf ${JSON.stringify(path.join(root, entry))}`);
      observe("EXECUTION-STATE", `${root} accessible`);
    } catch (error) { signal("EXECUTION-STATE", `${root}: ${error.message}`, REBUILD); }
  }
}

function collect(directory, files) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(file, files);
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(file);
  }
}

function sourceHash() {
  const files = [];
  collect(path.join(repoRoot, "src"), files);
  const hash = crypto.createHash("sha256");
  for (const file of files.sort()) hash.update(path.relative(repoRoot, file)).update("\0").update(fs.readFileSync(file));
  return hash.digest("hex");
}

/**
 * Dev clone: `dist/` có khớp `src/` không.
 *
 * Chỉ có ý nghĩa ở dev clone. Bản phát hành không mang theo `src/` — nó được compile trên máy
 * maintainer — nên ở đó câu hỏi đúng không phải "build có cũ không" mà là "artifact có đủ
 * file không", và đó là việc của checkArtifact().
 */
function checkBuildDrift() {
  if (channel !== "dev") return;
  const entry = compiled("cli/alp");
  const stamp = path.join(repoRoot, "dist", ".alp-source-hash");
  try {
    if (!fs.existsSync(entry) || !fs.existsSync(stamp)) throw new Error("compiled CLI or source hash missing");
    if (fs.readFileSync(stamp, "utf8").trim() !== sourceHash()) throw new Error("TypeScript source differs from compiled build stamp");
    observe("BUILD-DRIFT", "compiled artifacts match source hash");
  } catch (error) { signal("BUILD-DRIFT", error.message, REBUILD); }
}

/** Bản phát hành: những file mà thiếu là hỏng câm, không phải hỏng ồn. */
function checkArtifact() {
  if (channel === "dev") return;
  const required = ["dist/src/cli/alp.js", "hooks/session-boot.cjs", "scaffold/memory/INDEX.md", "alp.config.yaml"];
  const missing = required.filter((file) => !fs.existsSync(path.join(repoRoot, ...file.split("/"))));
  if (missing.length) signal("ARTIFACT", `bản cài ${channel} thiếu ${missing.join(", ")}`, REBUILD);
  else observe("ARTIFACT", `bản cài ${channel} tại ${repoRoot} đầy đủ`);
}

/**
 * `~/.alp/hooks/*.cjs` và `~/.alp/install.json` có trỏ đúng bản cài đang chạy không.
 *
 * Đây là chỗ hỏng câm nguy hiểm nhất của mô hình mới: `<project>/.claude/settings.local.json`
 * do `alp init` ghi trỏ vào forwarder, forwarder đọc install.json để tìm thư mục cài. Lệch
 * một mắt xích thì phiên `claude` mở tay vẫn chạy — chỉ là không còn identity nào cả, và
 * không có thông báo lỗi nào xuất hiện.
 */
function checkInstallRecord() {
  const record = P.readInstallRecord();
  if (!record) return signal("INSTALL-RECORD", `thiếu ${P.installRecordPath()}`, "node scripts/ensure-state.cjs");
  if (path.resolve(record.root) !== repoRoot)
    signal("INSTALL-RECORD", `install.json trỏ tới ${record.root}, không phải ${repoRoot}`, "node scripts/ensure-state.cjs");

  const forwarder = P.hookForwarderPath("session-boot");
  if (!fs.existsSync(forwarder))
    return signal("HOOK-FORWARDER", `thiếu ${forwarder} — hook SessionStart trong project sẽ im lặng không chạy`, "node scripts/ensure-state.cjs");
  observe("HOOK-FORWARDER", `${forwarder} → ${record.root}`);
}

const render = ({ tag, msg, fix }) => `${tag.padEnd(20)} ${msg}\n${" ".repeat(20)} → fix: ${fix}`;

async function main() {
  checkAgentRegistry();
  await checkRuntimes();
  await checkMemory();
  checkExecutionState();
  checkBuildDrift();
  checkArtifact();
  checkInstallRecord();
  if (!quiet) for (const item of observations) console.log(`${item.tag.padEnd(20)} ${item.msg}`);
  for (const item of signals) console.log(render(item));
  if (!signals.length && !quiet) console.log("OK                   code-native alp-code healthy");
  process.exitCode = signals.length ? 1 : 0;
}

main().catch((error) => {
  console.error(`ERROR                doctor failed: ${error.message}`);
  process.exitCode = 2;
});

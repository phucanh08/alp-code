#!/usr/bin/env node
// Code-native ALP health checks. Exit 0 healthy, 1 actionable findings, 2 doctor failure.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const D = require("./lib/delegation/config.cjs");

const quiet = process.argv.includes("--quiet");
const repoRoot = path.resolve(__dirname, "..");
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
  } catch (error) { signal("AGENT-REGISTRY", error.message, "npm run build"); }
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
    } catch (error) { signal(tag, error.message, "npm run build"); }
  }
}

async function checkMemory() {
  const root = process.env.ALP_MEMORY_ROOT || path.join(repoRoot, "memory");
  try {
    const { MarkdownFileStore } = require(compiled("memory/adapters/markdown-file-store"));
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK);
    const store = new MarkdownFileStore({ root });
    await store.search({ scope: "shared", text: "", limit: 1 });
    observe("MEMORY-ADAPTER", `${root} readable and writable`);
  } catch (error) { signal("MEMORY-ADAPTER", error.message, "node scripts/bootstrap.cjs --no-path"); }
}

function checkExecutionState() {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return signal("EXECUTION-STATE", "HOME/USERPROFILE unavailable", "set HOME rồi chạy lại alp doctor");
  const roots = [path.join(home, ".alp", "executions")];
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
    } catch (error) { signal("EXECUTION-STATE", `${root}: ${error.message}`, "node scripts/bootstrap.cjs --no-path"); }
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

function checkBuildDrift() {
  const entry = compiled("cli/alp");
  const stamp = path.join(repoRoot, "dist", ".alp-source-hash");
  try {
    if (!fs.existsSync(entry) || !fs.existsSync(stamp)) throw new Error("compiled CLI or source hash missing");
    if (fs.readFileSync(stamp, "utf8").trim() !== sourceHash()) throw new Error("TypeScript source differs from compiled build stamp");
    observe("BUILD-DRIFT", "compiled artifacts match source hash");
  } catch (error) { signal("BUILD-DRIFT", error.message, "node scripts/bootstrap.cjs --no-path"); }
}

const render = ({ tag, msg, fix }) => `${tag.padEnd(20)} ${msg}\n${" ".repeat(20)} → fix: ${fix}`;

async function main() {
  checkAgentRegistry();
  await checkRuntimes();
  await checkMemory();
  checkExecutionState();
  checkBuildDrift();
  if (!quiet) for (const item of observations) console.log(`${item.tag.padEnd(20)} ${item.msg}`);
  for (const item of signals) console.log(render(item));
  if (!signals.length && !quiet) console.log("OK                   code-native alp-code healthy");
  process.exitCode = signals.length ? 1 : 0;
}

main().catch((error) => {
  console.error(`ERROR                doctor failed: ${error.message}`);
  process.exitCode = 2;
});

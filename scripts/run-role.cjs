#!/usr/bin/env node
// Deprecated compatibility wrapper. Identity-aware raw runtime launch is no longer
// supported; accepted legacy flags are translated into `alp delegate` arguments.

const fs = require("fs");
const path = require("path");
const { spawnSyncCommand } = require("./lib/delegation/backends/command-runner.cjs");
const repoRoot = path.resolve(__dirname, "..");
const entry = path.join(repoRoot, "dist", "src", "cli", "alp.js");
if (!fs.existsSync(entry)) {
  const built = spawnSyncCommand("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
  if (built.error || built.status !== 0) process.exit(built.status || 2);
}
const input = process.argv.slice(2);
const role = input.shift();
if (!role) {
  console.error("ERROR     run-role requires a role");
  process.exit(2);
}
if (input.includes("--dry-run") || input.includes("--anchor")) {
  console.error("ERROR     identity-aware raw-runtime shortcuts are unsupported; use `alp delegate`");
  process.exit(2);
}
const output = ["delegate", role];
for (let index = 0; index < input.length; index += 1) {
  const value = input[index];
  if (value === "--kind") output.push("--runtime", input[++index]);
  else if (value === "--pane") output.push("--background");
  else if (value === "--exec") continue;
  else if (value === "--release") {
    output.splice(0, output.length, "delegation", "cleanup", input[++index]);
    break;
  } else output.push(value);
}
process.env.ALP_REPO_ROOT = repoRoot;
require(entry).main(output).then(
  (code) => { process.exitCode = code; },
  (error) => { console.error(`ERROR     ${error && error.message ? error.message : String(error)}`); process.exitCode = 2; },
);

#!/usr/bin/env node
// Compatibility wrapper for the code-native TypeScript CLI.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const repoRoot = path.resolve(__dirname, "..");
const entry = path.join(repoRoot, "dist", "src", "cli", "alp.js");
if (!fs.existsSync(entry)) {
  const built = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
  if (built.error || built.status !== 0) process.exit(built.status || 2);
}
process.env.ALP_REPO_ROOT = repoRoot;
const argv = process.argv.slice(2);
const command = argv[0] === "delegate" ? argv : ["delegation", ...argv];
require(entry).main(command).then(
  (code) => { process.exitCode = code; },
  (error) => { console.error(`ERROR     ${error && error.message ? error.message : String(error)}`); process.exitCode = 2; },
);

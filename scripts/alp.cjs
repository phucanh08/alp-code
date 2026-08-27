#!/usr/bin/env node
// Stable CommonJS bootstrap. All parsing, policy, identity, and runtime selection live
// in the compiled TypeScript CLI; this file only ensures that entrypoint exists.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const maintenance = process.argv[2];

if (["help", "--help", "-h"].includes(maintenance)) {
  console.log([
    "alp — code-native agent launcher",
    "",
    "  alp [--runtime claude|codex]",
    "  alp runtime show|set <runtime>",
    "  alp init [path] [--backend name]",
    "  alp deinit [path]",
    "  alp delegate <role> [options] -- <task>",
    "  alp doctor",
    "  alp update",
    "  alp uninstall [--purge-memory] [--force]",
  ].join("\n"));
  process.exit(0);
}

if (maintenance === "doctor") {
  const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "doctor.cjs"), ...process.argv.slice(3)], { cwd: repoRoot, stdio: "inherit" });
  process.exit(result.status ?? 2);
}

if (maintenance === "update") {
  const { updateInstallation } = require("./lib/update.cjs");
  const result = updateInstallation(repoRoot);
  if (!result.ok) console.error(`ERROR     ${result.message}`);
  else console.log("READY     alp-code updated; memory/runtime/backend preferences preserved");
  process.exit(result.ok ? 0 : 1);
}

if (maintenance === "uninstall") {
  const args = new Set(process.argv.slice(3));
  for (const arg of args) if (!["--purge-memory", "--force"].includes(arg)) {
    console.error(`ERROR     unknown uninstall option \`${arg}\``);
    process.exit(2);
  }
  const { uninstall } = require("./lib/uninstall.cjs");
  try {
    const result = uninstall(repoRoot, { purgeMemory: args.has("--purge-memory"), force: args.has("--force") });
    for (const item of result.log) console.log(`${item.level.padEnd(9)} ${item.text}`);
    process.exit(0);
  } catch (error) {
    console.error(`ERROR     ${error.message}`);
    process.exit(1);
  }
}
const entry = path.join(repoRoot, "dist", "src", "cli", "alp.js");
if (!fs.existsSync(entry)) {
  const built = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (built.error || built.status !== 0) {
    console.error(`ERROR     cannot build ALP TypeScript CLI${built.error ? `: ${built.error.message}` : ""}`);
    process.exit(built.status || 2);
  }
}

process.env.ALP_REPO_ROOT = repoRoot;
require(entry).main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (error) => {
    console.error(`ERROR     ${error && error.message ? error.message : String(error)}`);
    process.exitCode = 2;
  },
);

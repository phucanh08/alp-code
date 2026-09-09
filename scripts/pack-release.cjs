#!/usr/bin/env node
"use strict";

// Builds the wrapper-only npm package plus native release archives. It never publishes or uploads.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { NPM_WRAPPER_REQUIRED, NPM_WRAPPER_FORBIDDEN } = require("./lib/release-manifest.cjs");

const repoRoot = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
let outDir = path.join(repoRoot, "build", "release");
let npmOnly = args.includes("--npm-only") || args.includes("--skip-bundle");
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--out") outDir = path.resolve(args[++index] || fail("--out requires a directory"));
  else if (!["--npm-only", "--skip-bundle"].includes(args[index])) fail(`unknown option: ${args[index]}`);
}
const rootPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const version = rootPackage.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`invalid package version: ${version}`);
fs.mkdirSync(outDir, { recursive: true });

const staging = fs.mkdtempSync(path.join(os.tmpdir(), "alp-npm-wrapper-"));
try {
  fs.cpSync(path.join(repoRoot, "npm-wrapper"), staging, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "LICENSE"), path.join(staging, "LICENSE"));
  fs.copyFileSync(path.join(repoRoot, "README.md"), path.join(staging, "README.md"));
  fs.copyFileSync(path.join(repoRoot, "src", "install", "binary-targets.json"), path.join(staging, "lib", "binary-targets.json"));
  const wrapper = JSON.parse(fs.readFileSync(path.join(staging, "package.json"), "utf8"));
  Object.assign(wrapper, {
    version,
    description: rootPackage.description,
    license: rootPackage.license,
    author: rootPackage.author,
    repository: rootPackage.repository,
    homepage: rootPackage.homepage,
    bugs: rootPackage.bugs,
  });
  delete wrapper.private;
  fs.writeFileSync(path.join(staging, "package.json"), `${JSON.stringify(wrapper, null, 2)}\n`);

  const packed = run("npm", ["pack", staging, "--pack-destination", outDir, "--json", "--ignore-scripts"], true);
  const parsed = JSON.parse(packed.stdout);
  const item = Array.isArray(parsed) ? parsed[0] : parsed;
  const tarball = path.join(outDir, path.basename(item.filename));
  const entries = item.files.map((entry) => entry.path);
  const missing = NPM_WRAPPER_REQUIRED.filter((file) => !entries.includes(file));
  const leaked = entries.filter((file) => NPM_WRAPPER_FORBIDDEN.some((pattern) => pattern.test(file)));
  if (missing.length || leaked.length) fail(`invalid npm wrapper: missing=${missing.join(",") || "none"}; leaked=${leaked.join(",") || "none"}`);
  console.log(`NPM       ${tarball} (${entries.length} files, wrapper only)`);

  if (!npmOnly) {
    const buildArgs = [path.join(repoRoot, "scripts", "build-binary.cjs"), "--all", "--out", outDir];
    run(process.execPath, buildArgs, false);
  }
  console.log(`READY     release artifacts in ${outDir}; nothing was published or uploaded`);
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}

function run(command, commandArgs, capture) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error || result.status !== 0) fail(result.stderr || result.error?.message || `${command} failed with ${result.status}`);
  return result;
}

function fail(message) { throw new Error(message); }

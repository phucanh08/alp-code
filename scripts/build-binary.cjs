#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");
const { TARGETS, archiveName, byId } = require("./lib/binary-targets.cjs");
const { createInstallManifest, validateArchiveEntries } = require("./lib/release-manifest.cjs");

const repoRoot = path.resolve(__dirname, "..");
const packageDocument = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const version = packageDocument.version;
const compilerVersion = fs.readFileSync(path.join(repoRoot, ".bun-version"), "utf8").trim();

function die(message) { throw new Error(message); }
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: "utf8",
    env: { ...process.env, COPYFILE_DISABLE: "1", ...options.env },
  });
  if (result.error || result.status !== 0) die(result.stderr || result.stdout || result.error?.message || `${command} failed`);
  return result;
}

function machineArch() {
  if (process.platform !== "darwin") return os.arch() === "arm64" ? "aarch64" : os.arch();
  const translated = spawnSync("sysctl", ["-in", "sysctl.proc_translated"], { encoding: "utf8" });
  if (translated.status === 0 && translated.stdout.trim() === "1") return "aarch64";
  return os.arch() === "arm64" ? "aarch64" : os.arch();
}

function findBun() {
  if (process.env.BUN_BINARY) return path.resolve(process.env.BUN_BINARY);
  const name = process.platform === "win32" ? "bun.exe" : "bun";
  for (const candidate of [
    path.join(repoRoot, "node_modules", ".bin", name),
    path.join(repoRoot, "node_modules", "@oven", `bun-${process.platform}-${machineArch()}`, "bin", name),
  ]) if (fs.existsSync(candidate)) return candidate;
  return name;
}

function parseArgs(argv) {
  let outDir = path.join(repoRoot, "build", "native");
  const selected = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--out") outDir = path.resolve(argv[++index] || die("--out requires a directory"));
    else if (argv[index] === "--target") selected.push(byId(argv[++index] || die("--target requires an id")));
    else if (argv[index] === "--all") selected.splice(0, selected.length, ...TARGETS);
    else if (argv[index] === "--help") {
      console.log("build-binary.cjs [--all | --target <id> ...] [--out <directory>]");
      process.exit(0);
    } else die(`unknown argument: ${argv[index]}`);
  }
  return { outDir, targets: selected.length ? selected : TARGETS };
}

function gitCommit() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function assertSource() {
  if (process.env.ALP_SKIP_GIT_CHECK === "1") return;
  const status = run("git", ["status", "--porcelain" ]).stdout.trim();
  if (status) die("binary release build requires a clean working tree (set ALP_SKIP_GIT_CHECK=1 only for local tests)");
}

function normalizeTree(directory) {
  const epoch = new Date(0);
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      fs.utimesSync(file, epoch, epoch);
    }
  };
  visit(directory);
  fs.utimesSync(directory, epoch, epoch);
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function tarOwnershipArgs() {
  const version = spawnSync("tar", ["--version"], { encoding: "utf8" }).stdout || "";
  // GNU tar (Linux) rejects the BSD-tar-only --uid/--gid/--uname/--gname flags; it needs
  // --owner=name:uid instead. bsdtar (macOS, Windows' built-in tar.exe) takes the reverse.
  return /GNU tar/i.test(version)
    ? ["--owner=root:0", "--group=root:0"]
    : ["--uid", "0", "--gid", "0", "--uname", "root", "--gname", "root"];
}

function buildTarget(bun, target, outDir) {
  const staging = path.join(outDir, `.stage-${target.id}-${process.pid}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.join(staging, "bin"), { recursive: true });
  const executable = path.join(staging, "bin", target.executable);
  const metafile = path.join(outDir, `${target.id}.metafile.json`);
  run(bun, [
    "build", "--compile", "--minify", `--target=${target.bunTarget}`,
    "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--no-compile-autoload-package-json",
    `--define=__ALP_BUILD_VERSION__=${JSON.stringify(version)}`,
    `--define=__ALP_COMPILER_NAME__=${JSON.stringify("bun")}`,
    `--define=__ALP_COMPILER_VERSION__=${JSON.stringify(compilerVersion)}`,
    `--metafile=${metafile}`,
    path.join(repoRoot, "src", "cli", "entry.ts"), "--outfile", executable,
  ]);
  if (target.platform !== "win32") fs.chmodSync(executable, 0o755);
  for (const name of ["skills", "scaffold", "hooks"]) fs.cpSync(path.join(repoRoot, name), path.join(staging, name), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "LICENSE"), path.join(staging, "LICENSE"));
  fs.writeFileSync(path.join(staging, "install-manifest.json"), `${JSON.stringify(createInstallManifest({
    version, target: target.id, compilerVersion, sourceCommit: gitCommit(),
  }), null, 2)}\n`);
  normalizeTree(staging);

  const archive = path.join(outDir, archiveName(version, target.id));
  const tarball = path.join(outDir, `.${target.id}.${process.pid}.tar`);
  fs.rmSync(archive, { force: true });
  fs.rmSync(tarball, { force: true });
  try {
    run("tar", ["-cf", tarball, "--format", "ustar", ...tarOwnershipArgs(), "-C", staging, "."]);
    fs.writeFileSync(archive, zlib.gzipSync(fs.readFileSync(tarball), { level: 9, mtime: 0 }));
  } finally {
    fs.rmSync(tarball, { force: true });
  }
  const entries = run("tar", ["-tzf", archive]).stdout.split(/\r?\n/).filter(Boolean);
  validateArchiveEntries(entries);
  fs.rmSync(staging, { recursive: true, force: true });
  return archive;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  assertSource();
  fs.mkdirSync(options.outDir, { recursive: true });
  const bun = findBun();
  const actual = run(bun, ["--version"]).stdout.trim();
  if (actual !== compilerVersion) die(`Bun version mismatch: expected ${compilerVersion}, got ${actual}`);
  const archives = options.targets.map((target) => buildTarget(bun, target, options.outDir));
  const lines = archives.sort().map((archive) => `${sha256(archive)}  ${path.basename(archive)}`);
  fs.writeFileSync(path.join(options.outDir, "SHA256SUMS"), `${lines.join("\n")}\n`);
  for (const archive of archives) console.log(`BUILT     ${archive}`);
  console.log(`CHECKSUMS ${path.join(options.outDir, "SHA256SUMS")}`);
}

try { main(); }
catch (error) { console.error(`ERROR     ${error.message}`); process.exitCode = 1; }

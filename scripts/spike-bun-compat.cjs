#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const expectedVersion = fs.readFileSync(path.join(repoRoot, ".bun-version"), "utf8").trim();

function machineArch() {
  if (process.platform !== "darwin") return os.arch();
  const translated = spawnSync("sysctl", ["-in", "sysctl.proc_translated"], { encoding: "utf8" });
  if (translated.status === 0 && translated.stdout.trim() === "1") return "arm64";
  const result = spawnSync("uname", ["-m"], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() === "arm64" ? "arm64" : os.arch();
}

function bunPackageArch() {
  const arch = machineArch();
  if (arch === "arm64") return "aarch64";
  return arch;
}

function findBun() {
  if (process.env.BUN_BINARY) return path.resolve(process.env.BUN_BINARY);

  const executable = process.platform === "win32" ? "bun.exe" : "bun";
  const candidates = [
    path.join(repoRoot, "node_modules", ".bin", executable),
    path.join(
      repoRoot,
      "node_modules",
      "@oven",
      `bun-${process.platform}-${bunPackageArch()}`,
      "bin",
      executable,
    ),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  const onPath = spawnSync(executable, ["--version"], { encoding: "utf8" });
  if (onPath.status === 0) return executable;
  throw new Error(
    `Bun ${expectedVersion} not found. Install bun@${expectedVersion} or set BUN_BINARY to an exact-version executable.`,
  );
}

function parseArgs(argv) {
  const options = { json: false, outDir: path.join(repoRoot, "build", "bun-compat") };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--json") options.json = true;
    else if (argv[index] === "--out") options.outDir = path.resolve(argv[++index]);
    else if (argv[index] === "--help") options.help = true;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return options;
}

function run(executable, args, options = {}) {
  return spawnSync(executable, args, { encoding: "utf8", ...options });
}

function waitForFile(filePath, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (fs.existsSync(filePath)) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 20);
  });
}

async function signalProbe(executable, workspace, signal) {
  const name = signal.toLowerCase().slice(3);
  const readyPath = path.join(workspace, `${name}.ready`);
  const markerPath = path.join(workspace, `${name}.marker`);
  const child = spawn(executable, ["forward-signal", signal, readyPath, markerPath], {
    stdio: "ignore",
  });
  const ready = await waitForFile(readyPath);
  if (!ready) {
    child.kill("SIGKILL");
    return { ok: false, error: "forwarder did not become ready" };
  }
  child.kill(signal);
  const exitCode = await new Promise((resolve) => child.once("close", resolve));
  const expectedExitCode = signal === "SIGINT" ? 130 : 143;
  return {
    ok: fs.existsSync(markerPath) && exitCode === expectedExitCode,
    exitCode,
    expectedExitCode,
    forwarded: fs.existsSync(markerPath),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("Usage: node scripts/spike-bun-compat.cjs [--json] [--out DIR]\n");
    return;
  }

  const bun = findBun();
  const versionResult = run(bun, ["--version"]);
  const revisionResult = run(bun, ["--revision"]);
  const actualVersion = versionResult.stdout.trim();
  if (versionResult.status !== 0 || actualVersion !== expectedVersion) {
    throw new Error(`Bun version mismatch: expected ${expectedVersion}, got ${actualVersion || "unavailable"}`);
  }

  fs.mkdirSync(options.outDir, { recursive: true });
  const runDir = fs.mkdtempSync(path.join(options.outDir, "run-"));
  const workspace = path.join(runDir, "runtime");
  fs.mkdirSync(workspace, { recursive: true });
  const executable = path.join(runDir, process.platform === "win32" ? "alp-bun-probe.exe" : "alp-bun-probe");
  const source = path.join(repoRoot, "test", "fixtures", "binary-compat", "probe.ts");
  const compileResult = run(bun, ["build", "--compile", source, "--outfile", executable]);
  if (compileResult.status !== 0) throw new Error(compileResult.stderr || compileResult.stdout);

  const runtimeResult = run(executable, ["report", workspace]);
  if (runtimeResult.status !== 0) throw new Error(runtimeResult.stderr || runtimeResult.stdout);
  const runtime = JSON.parse(runtimeResult.stdout);

  const detachedMarker = path.join(workspace, "detached.marker");
  const detachedParent = run(executable, ["launch-detached", detachedMarker]);
  const absentAtParentExit = !fs.existsSync(detachedMarker);
  const detachedCompleted = detachedParent.status === 0 && (await waitForFile(detachedMarker));

  const symlinkPath = path.join(runDir, "alp-bun-probe-link");
  fs.symlinkSync(executable, symlinkPath);
  const symlinkResult = run(symlinkPath, ["path-report"]);
  const symlinkReport = symlinkResult.status === 0 ? JSON.parse(symlinkResult.stdout) : null;

  runtime.process.detached = {
    ok: detachedCompleted && absentAtParentExit,
    parentExitCode: detachedParent.status,
    completedAfterParentExit: detachedCompleted && absentAtParentExit,
  };
  runtime.process.sigint = await signalProbe(executable, workspace, "SIGINT");
  runtime.process.sigterm = await signalProbe(executable, workspace, "SIGTERM");
  runtime.filesystem.symlinkInvocation = {
    ok:
      symlinkResult.status === 0 &&
      symlinkReport &&
      fs.realpathSync(symlinkReport.execPath) === fs.realpathSync(executable),
    invokedPath: symlinkPath,
    ...symlinkReport,
  };

  const report = {
    compiler: {
      expectedVersion,
      actualVersion,
      revision: revisionResult.stdout.trim(),
      executable: bun,
    },
    host: {
      platform: process.platform,
      nodeArch: process.arch,
      machineArch: machineArch(),
      osRelease: os.release(),
      filesystemType: fs.statfsSync(repoRoot).type,
    },
    compile: {
      ok: true,
      source,
      executable,
      stderr: compileResult.stderr.trim(),
    },
    ...runtime,
  };

  process.stdout.write(options.json ? JSON.stringify(report) : `${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});

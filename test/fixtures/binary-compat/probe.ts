import { execFile, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { runChildMode, STDERR_BYTES, STDOUT_BYTES } from "./child";

type ProbeResult = { ok: boolean; [key: string]: unknown };

function result(ok: boolean, details: Record<string, unknown> = {}): ProbeResult {
  return { ok, ...details };
}

function runAsync(executable: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, ["child-output"], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("close", (code) => {
      const out = Buffer.concat(stdout);
      const err = Buffer.concat(stderr);
      resolve(
        result(code === 0 && out.equals(STDOUT_BYTES) && err.equals(STDERR_BYTES), {
          exitCode: code,
          stdoutBytes: out.length,
          stderrBytes: err.length,
        }),
      );
    });
    child.on("error", (error) => resolve(result(false, { error: error.message })));
  });
}

function runExecFile(executable: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    execFile(executable, ["child-output"], { encoding: "buffer" }, (error, stdout, stderr) => {
      const out = Buffer.from(stdout);
      const err = Buffer.from(stderr);
      resolve(
        result(!error && out.equals(STDOUT_BYTES) && err.equals(STDERR_BYTES), {
          error: error?.message,
          stdoutBytes: out.length,
          stderrBytes: err.length,
        }),
      );
    });
  });
}

function runStdin(executable: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const input = Buffer.allocUnsafe(1024 * 1024);
    for (let index = 0; index < input.length; index += 1) input[index] = index % 251;

    const child = spawn(executable, ["echo-stdin"], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("close", (code) => {
      const output = Buffer.concat(stdout);
      resolve(
        result(code === 0 && output.equals(input) && Buffer.concat(stderr).length === 0, {
          exitCode: code,
          bytes: output.length,
        }),
      );
    });
    child.on("error", (error) => resolve(result(false, { error: error.message })));
    child.stdin.end(input);
  });
}

async function runProcessProbes(executable: string, workspace: string): Promise<Record<string, ProbeResult>> {
  const sync = spawnSync(executable, ["child-output"], { encoding: "buffer" });
  const exit = spawnSync(executable, ["exit-code"], { stdio: "ignore" });
  const inheritedMarker = path.join(workspace, "stdio-inherit.marker");
  const inherited = spawnSync(executable, ["mark", inheritedMarker], { stdio: "inherit" });

  return {
    spawnSync: result(
      sync.status === 0 &&
        Buffer.from(sync.stdout).equals(STDOUT_BYTES) &&
        Buffer.from(sync.stderr).equals(STDERR_BYTES) &&
        exit.status === 23,
      { exitCode: sync.status, explicitExitCode: exit.status },
    ),
    spawn: await runAsync(executable),
    execFile: await runExecFile(executable),
    stdin: await runStdin(executable),
    stdioInherit: result(inherited.status === 0 && fs.existsSync(inheritedMarker), {
      exitCode: inherited.status,
    }),
  };
}

function runFilesystemProbes(workspace: string): Record<string, ProbeResult> {
  const privateFileTemp = path.join(workspace, "private.tmp");
  const privateFile = path.join(workspace, "private.json");
  const privateDir = path.join(workspace, "private-dir");
  fs.writeFileSync(privateFileTemp, "state\n", { mode: 0o600 });
  fs.renameSync(privateFileTemp, privateFile);
  fs.chmodSync(privateFile, 0o600);
  fs.mkdirSync(privateDir, { mode: 0o700 });
  fs.chmodSync(privateDir, 0o700);
  const fileMode = fs.statSync(privateFile).mode & 0o777;
  const dirMode = fs.statSync(privateDir).mode & 0o777;

  const firstTarget = path.join(workspace, "target-v1");
  const secondTarget = path.join(workspace, "target-v2");
  const stableLink = path.join(workspace, "stable-link");
  const replacementLink = path.join(workspace, "stable-link.next");
  fs.writeFileSync(firstTarget, "v1\n");
  fs.writeFileSync(secondTarget, "v2\n");
  fs.symlinkSync(firstTarget, stableLink);
  fs.symlinkSync(secondTarget, replacementLink);
  fs.renameSync(replacementLink, stableLink);

  const movedExecutable = `${process.execPath}.running-${process.pid}`;
  let executableRenamed = false;
  let executableRestored = false;
  let executableRenameError: string | undefined;
  try {
    fs.renameSync(process.execPath, movedExecutable);
    executableRenamed = true;
  } catch (error) {
    executableRenameError = error instanceof Error ? error.message : String(error);
  } finally {
    if (executableRenamed) {
      fs.renameSync(movedExecutable, process.execPath);
      executableRestored = true;
    }
  }

  return {
    atomicRename: result(fs.readFileSync(privateFile, "utf8") === "state\n"),
    privateModes: result(process.platform === "win32" || (fileMode === 0o600 && dirMode === 0o700), {
      fileMode: fileMode.toString(8),
      directoryMode: dirMode.toString(8),
      skipped: process.platform === "win32",
    }),
    symlinkReplace: result(fs.realpathSync(stableLink) === fs.realpathSync(secondTarget), {
      target: fs.readlinkSync(stableLink),
    }),
    runningExecutable: result(process.platform === "win32" || (executableRenamed && executableRestored), {
      renamed: executableRenamed,
      restored: executableRestored,
      error: executableRenameError,
      platformBehaviorOnly: process.platform === "win32",
    }),
  };
}

async function launchDetached(executable: string, markerPath: string): Promise<void> {
  const child = spawn(executable, ["delayed-marker", markerPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function forwardSignal(
  executable: string,
  signal: NodeJS.Signals,
  readyPath: string,
  markerPath: string,
): Promise<void> {
  const childReadyPath = `${readyPath}.child`;
  const child = spawn(executable, ["signal-child", signal, childReadyPath, markerPath], {
    stdio: "ignore",
  });
  const interval = setInterval(() => {
    if (fs.existsSync(childReadyPath)) fs.writeFileSync(readyPath, `${process.pid}\n`);
  }, 10);
  process.on(signal, () => child.kill(signal));
  child.on("close", (code) => {
    clearInterval(interval);
    process.exit(code ?? 1);
  });
}

async function main(): Promise<void> {
  // Bun standalone executables retain the virtual bundled entry at argv[1].
  const [mode = "report", ...args] = process.argv.slice(2);
  if (await runChildMode(mode, args)) return;

  if (mode === "launch-detached") {
    await launchDetached(process.execPath, args[0]);
    return;
  }

  if (mode === "forward-signal") {
    await forwardSignal(process.execPath, args[0] as NodeJS.Signals, args[1], args[2]);
    return;
  }

  if (mode !== "report" || !args[0]) throw new Error("usage: probe report <workspace>");
  const workspace = args[0];
  fs.mkdirSync(workspace, { recursive: true });
  process.stdout.write(
    JSON.stringify({
      process: await runProcessProbes(process.execPath, workspace),
      filesystem: runFilesystemProbes(workspace),
    }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

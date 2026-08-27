// Safe `alp update` support for code-native ALP. Project registrations are machine-local,
// so tracked source must be clean and the update itself is a plain fast-forward.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

function pullPreservingWorkspaces(repoRoot, options = {}) {
  const env = options.env || process.env;
  const stdio = options.stdio || "inherit";
  const log = options.log || (() => {});

  const staged = gitLines(repoRoot, ["diff", "--cached", "--name-only"], env);
  if (!staged.ok) return failure(`không kiểm tra được staged changes: ${staged.message}`);
  if (staged.lines.length)
    return failure(`repo có staged changes; không tự cất: ${staged.lines.join(", ")}`);

  const dirty = gitLines(repoRoot, ["diff", "--name-only"], env);
  if (!dirty.ok) return failure(`không kiểm tra được working tree: ${dirty.message}`);

  if (dirty.lines.length) return failure(`repo có tracked changes; không tự cất: ${dirty.lines.join(", ")}`);
  log("CHECK", "tracked source clean; machine-local project registry is outside git");
  return pullResult(runGit(repoRoot, ["pull", "--ff-only"], { env, stdio }), []);
}

function preserveMaintenanceState(repoRoot, options = {}) {
  const env = options.env || process.env;
  const home = env.HOME || env.USERPROFILE;
  const paths = [path.join(repoRoot, "memory")];
  if (home) paths.push(path.join(home, ".alp", "runtime.json"), path.join(home, ".alp", "projects.json"), path.join(home, ".alp", "delegation"));
  const backupRoot = fs.mkdtempSync(path.join(options.tempRoot || os.tmpdir(), "alp-update-state-"));
  const entries = paths.filter((file) => fs.existsSync(file)).map((file, index) => {
    const backup = path.join(backupRoot, String(index));
    fs.cpSync(file, backup, { recursive: true, force: true });
    return { file, backup };
  });
  Object.defineProperty(entries, "backupRoot", { value: backupRoot });
  return entries;
}

function restoreMaintenanceState(snapshot) {
  try {
    for (const entry of snapshot) {
      fs.rmSync(entry.file, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(entry.file), { recursive: true });
      fs.cpSync(entry.backup, entry.file, { recursive: true, force: true });
    }
  } finally {
    discardMaintenanceState(snapshot);
  }
}

function discardMaintenanceState(snapshot) {
  if (snapshot.backupRoot) fs.rmSync(snapshot.backupRoot, { recursive: true, force: true });
}

function updateInstallation(repoRoot, options = {}) {
  const snapshot = preserveMaintenanceState(repoRoot, options);
  const pulled = pullPreservingWorkspaces(repoRoot, options);
  if (!pulled.ok) {
    discardMaintenanceState(snapshot);
    return pulled;
  }
  const spawnProcess = options.spawnProcess || spawnSync;
  let built;
  try {
    built = spawnProcess(process.execPath, [path.join(repoRoot, "scripts", "bootstrap.cjs"), "--no-path"], {
      cwd: repoRoot,
      env: options.env || process.env,
      stdio: options.stdio || "inherit",
    });
  } finally {
    restoreMaintenanceState(snapshot);
  }
  return succeeded(built) ? pulled : failure(commandFailure("bootstrap.cjs", built));
}

function onlyWorkspaceChanged(base, current) {
  const normalizedBase = normalizeNewlines(base);
  const normalizedCurrent = normalizeNewlines(current);
  const workspacePattern = /^workspaces:\s*$\n(?:^[ \t]+.*(?:\n|$))*/m;
  if (!workspacePattern.test(normalizedBase) || !workspacePattern.test(normalizedCurrent)) return false;
  return normalizedBase.replace(workspacePattern, "workspaces:\n") ===
    normalizedCurrent.replace(workspacePattern, "workspaces:\n");
}

function restoreStash(repoRoot, stashHash, env, stdio) {
  const applied = runGit(repoRoot, ["stash", "apply", stashHash], { env, stdio });
  if (!succeeded(applied)) return { ok: false, message: commandFailure("git stash apply", applied) };
  return dropStash(repoRoot, stashHash, env);
}

function dropStash(repoRoot, stashHash, env) {
  const listed = gitLines(repoRoot, ["stash", "list", "--format=%H"], env);
  if (!listed.ok) return listed;
  const index = listed.lines.indexOf(stashHash);
  if (index < 0) return { ok: false, message: `không tìm thấy ${stashHash} trong stash list` };
  const dropped = runGit(repoRoot, ["stash", "drop", `stash@{${index}}`], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return succeeded(dropped)
    ? { ok: true }
    : { ok: false, message: commandFailure("git stash drop", dropped) };
}

function pullResult(result, preserved) {
  return succeeded(result)
    ? { ok: true, status: result.status, preserved }
    : failure(commandFailure("git pull --ff-only", result));
}

function gitLines(repoRoot, args, env) {
  const result = gitText(repoRoot, args, env);
  return result.ok
    ? { ok: true, lines: result.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) }
    : result;
}

function gitText(repoRoot, args, env) {
  const result = runGit(repoRoot, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return succeeded(result)
    ? { ok: true, text: String(result.stdout || "") }
    : { ok: false, message: commandFailure(`git ${args.join(" ")}`, result) };
}

function runGit(repoRoot, args, options) {
  return spawnSync("git", ["-C", repoRoot, ...args], options);
}

function commandFailure(command, result) {
  return String(result?.stderr || result?.stdout || result?.error?.message || `${command} exit ${result?.status}`).trim();
}

function succeeded(result) {
  return !result.error && result.status === 0;
}

function failure(message) {
  return { ok: false, status: 1, message, preserved: [] };
}

function normalizeNewlines(text) {
  return String(text).replace(/\r\n/g, "\n");
}

module.exports = {
  onlyWorkspaceChanged,
  pullPreservingWorkspaces,
  preserveMaintenanceState,
  restoreMaintenanceState,
  discardMaintenanceState,
  updateInstallation,
};

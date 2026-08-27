// Safe `alp update` support for code-native ALP. Project registrations are machine-local,
// so tracked source must be clean; the update itself resolves and checks out the latest
// GitHub Release tag (detached HEAD) instead of fast-forwarding a branch.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const semver = require("./semver-lite.cjs");

function assertCleanWorkingTree(repoRoot, env) {
  const staged = gitLines(repoRoot, ["diff", "--cached", "--name-only"], env);
  if (!staged.ok) return failure(`không kiểm tra được staged changes: ${staged.message}`);
  if (staged.lines.length)
    return failure(`repo có staged changes; không tự cất: ${staged.lines.join(", ")}`);

  const dirty = gitLines(repoRoot, ["diff", "--name-only"], env);
  if (!dirty.ok) return failure(`không kiểm tra được working tree: ${dirty.message}`);

  if (dirty.lines.length) return failure(`repo có tracked changes; không tự cất: ${dirty.lines.join(", ")}`);
  return { ok: true };
}

async function resolveLatestReleaseTag(repoRoot, options = {}) {
  const repoSlug = options.repoSlug || "phucanh08/alp-code";
  const fetchImpl = options.fetch || globalThis.fetch;
  if (fetchImpl) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs || 5000);
      const response = await fetchImpl(`https://api.github.com/repos/${repoSlug}/releases/latest`, {
        signal: controller.signal,
        headers: { "User-Agent": "alp-code-updater" },
      });
      clearTimeout(timer);
      if (response.ok) {
        const body = await response.json();
        if (body && typeof body.tag_name === "string" && semver.isValid(body.tag_name)) {
          return { ok: true, tag: body.tag_name, source: "github-api" };
        }
      }
    } catch {
      /* fall through to git-based fallback */
    }
  }
  const remote = options.remote || "origin";
  const listed = gitText(repoRoot, ["ls-remote", "--tags", "--refs", remote], options.env || process.env);
  if (!listed.ok) return { ok: false, message: `không lấy được danh sách tag: ${listed.message}` };
  const tags = listed.text
    .split(/\r?\n/)
    .map((line) => line.split("refs/tags/")[1])
    .filter(Boolean)
    .filter((tag) => semver.isValid(tag));
  if (!tags.length) return { ok: false, message: "không tìm thấy tag phiên bản (vX.Y.Z) trên remote" };
  tags.sort(semver.compare);
  return { ok: true, tag: tags[tags.length - 1], source: "git-ls-remote" };
}

async function checkoutLatestRelease(repoRoot, options = {}) {
  const env = options.env || process.env;
  const stdio = options.stdio || "inherit";
  const log = options.log || (() => {});

  const clean = assertCleanWorkingTree(repoRoot, env);
  if (!clean.ok) return clean;
  log("CHECK", "tracked source clean; machine-local project registry is outside git");

  const remote = options.remote || "origin";
  const fetched = runGit(repoRoot, ["fetch", "--tags", "--force", remote], { env, stdio });
  if (!succeeded(fetched)) return failure(commandFailure("git fetch --tags", fetched));

  const resolved = options.pinTag
    ? { ok: true, tag: options.pinTag.startsWith("v") ? options.pinTag : `v${options.pinTag}`, source: "pinned" }
    : await (options.resolveLatestReleaseTag || resolveLatestReleaseTag)(repoRoot, options);
  if (!resolved.ok) return failure(resolved.message);

  log("CHECKOUT", `${resolved.tag} (${resolved.source})`);
  const checkedOut = runGit(repoRoot, ["checkout", "--detach", resolved.tag], { env, stdio });
  if (!succeeded(checkedOut)) return failure(commandFailure(`git checkout ${resolved.tag}`, checkedOut));
  return { ok: true, status: 0, tag: resolved.tag, source: resolved.source, preserved: [] };
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

async function updateInstallation(repoRoot, options = {}) {
  const snapshot = preserveMaintenanceState(repoRoot, options);
  const checkedOut = await checkoutLatestRelease(repoRoot, options);
  if (!checkedOut.ok) {
    discardMaintenanceState(snapshot);
    return checkedOut;
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
  return succeeded(built) ? checkedOut : failure(commandFailure("bootstrap.cjs", built));
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
  assertCleanWorkingTree,
  resolveLatestReleaseTag,
  checkoutLatestRelease,
  preserveMaintenanceState,
  restoreMaintenanceState,
  discardMaintenanceState,
  updateInstallation,
};

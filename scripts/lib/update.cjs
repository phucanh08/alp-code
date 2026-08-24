// Safe `alp update` support for machine-local workspace registrations.
//
// `alp init` intentionally writes workspaces into tracked loadout files because they are
// the ACL source of truth. Those paths are local state, however, and must not prevent a
// fast-forward when upstream changes another field in the same loadout. We preserve only
// workspace-only diffs; every other tracked edit remains a hard stop.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const L = require("./loadout.cjs");

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

  const snapshots = [];
  for (const relative of dirty.lines) {
    const match = relative.match(/^identity\/([^/]+)\/loadout\.yaml$/);
    if (!match)
      return failure(`repo có thay đổi tracked ngoài workspace config: ${relative}`);

    const currentFile = path.join(repoRoot, ...relative.split("/"));
    if (!fs.existsSync(currentFile))
      return failure(`loadout local đã bị xoá; không tự cất: ${relative}`);
    const base = gitText(repoRoot, ["show", `HEAD:${relative}`], env);
    if (!base.ok) return failure(`không đọc được bản HEAD của ${relative}: ${base.message}`);

    const currentText = fs.readFileSync(currentFile, "utf8");
    if (!onlyWorkspaceChanged(base.text, currentText))
      return failure(`loadout có thay đổi ngoài khối workspaces; không tự cất: ${relative}`);

    const workspace = L.effectiveWorkspaces(L.parseYaml(currentText));
    snapshots.push({ role: match[1], relative, ...workspace });
  }

  if (!snapshots.length) {
    const pull = runGit(repoRoot, ["pull", "--ff-only"], { env, stdio });
    return pullResult(pull, []);
  }

  log("PRESERVE", `${snapshots.length} loadout workspace local`);
  const paths = snapshots.map((snapshot) => snapshot.relative);
  const stash = runGit(
    repoRoot,
    ["stash", "push", "-m", "alp-update: preserve local workspaces", "--", ...paths],
    { env, stdio }
  );
  if (!succeeded(stash)) return failure(commandFailure("git stash", stash));

  const stashHead = gitText(repoRoot, ["rev-parse", "refs/stash"], env);
  if (!stashHead.ok) return failure(`đã cất workspace nhưng không tìm thấy stash: ${stashHead.message}`);
  const stashHash = stashHead.text.trim();

  const pull = runGit(repoRoot, ["pull", "--ff-only"], { env, stdio });
  if (!succeeded(pull)) {
    const restored = restoreStash(repoRoot, stashHash, env, stdio);
    const suffix = restored.ok
      ? "workspace local đã được khôi phục"
      : `workspace còn an toàn trong stash ${stashHash}; khôi phục tay bằng git stash apply ${stashHash}`;
    return failure(`${commandFailure("git pull --ff-only", pull)}; ${suffix}`);
  }

  try {
    for (const snapshot of snapshots)
      L.writeWorkspaces(repoRoot, snapshot.role, snapshot.read, snapshot.write);
  } catch (error) {
    return failure(
      `đã update code nhưng không áp lại được workspace: ${error.message}; ` +
      `bản cũ còn trong stash ${stashHash}`
    );
  }

  const dropped = dropStash(repoRoot, stashHash, env);
  if (!dropped.ok)
    return failure(`workspace đã áp lại nhưng không dọn được stash ${stashHash}: ${dropped.message}`);

  log("RESTORE", `${snapshots.length} loadout workspace local`);
  return { ok: true, status: pull.status, preserved: snapshots.map((snapshot) => snapshot.role) };
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

module.exports = { onlyWorkspaceChanged, pullPreservingWorkspaces };

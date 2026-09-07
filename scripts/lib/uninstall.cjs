// uninstall.cjs — gỡ cài đặt alp-code nhưng không làm mất memory âm thầm.
//
// Mặc định:
//   · gỡ config alp init khỏi mọi workspace còn tồn tại
//   · chuyển memory ra một backup cạnh `~/.alp`
//   · gỡ bản cài theo đúng cách của channel đó, gỡ shim/symlink `alp` và PATH do installer thêm
//   · xoá state của alp-code trong `~/.alp` — theo DANH SÁCH TÊN, không xoá cả thư mục
//   · giữ trust Claude/Codex: entry có thể đã tồn tại trước alp-code và để lại thì vô hại
//
// `--purge-memory` do alp.cjs chuyển vào mới cho phép memory bị xoá.
//
// Hai điều thay đổi từ v0.9.0, và cả hai đều là chuyện mất dữ liệu nếu làm sai:
//
//   1. Memory không còn nằm trong thư mục cài, mà ở `~/.alp/memory`. Xoá thư mục cài không
//      còn đụng tới nó — nhưng xoá `~/.alp` thì đụng, nên chỗ đó phải xoá có chọn lọc.
//   2. Thư mục cài không còn luôn là một git clone. Bản npm phải để npm gỡ; `rm -rf` sau
//      lưng npm để lại một entry ma trong registry global của nó.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const CLI = require("./cli-link.cjs");
const P = require("./install-paths.cjs");

/**
 * Những gì trong `~/.alp` thuộc về alp-code.
 *
 * Danh sách tên chứ không phải `rm -rf` cả thư mục: `~/.alp` là nhà chung, và một lệnh
 * uninstall không có quyền xoá thứ nó không tạo ra. `memory` cố tình vắng mặt ở đây — nó đi
 * đường riêng qua backup hoặc `--purge-memory`.
 */
const OWNED_STATE = [
  "agents",
  "hooks",
  "executions",
  "delegation",
  "install.json",
  "update-check.json",
  "mode.json",
  "projects.json",
];

function uninstall(repoRoot, opts = {}) {
  repoRoot = path.resolve(repoRoot);
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const cwd = path.resolve(opts.cwd || process.cwd());
  const purgeMemory = !!opts.purgeMemory;
  const force = !!opts.force;
  const log = [];
  const say = (level, text) => log.push({ level, text });

  const channel = opts.channel || P.detectChannel(repoRoot);
  const stateHome = opts.stateHome || P.stateHome(env);
  const memory = opts.memoryRoot || P.memoryRoot(env);

  assertInstallRoot(repoRoot);
  if (isWithin(repoRoot, cwd))
    throw new Error(`cwd đang nằm trong ${repoRoot} — cd ra ngoài thư mục này rồi chạy lại \`alp uninstall\``);
  if (!force) assertGitSafe(repoRoot);

  // Lấy registry machine-local trước khi xoá state.
  const projects = opts.projectPaths || registeredProjects(repoRoot, platform, env);

  // Memory đi trước mọi thao tác xoá: nếu bước sau hỏng, dữ liệu đã nằm an toàn ở backup.
  let memoryBackup = null;
  if (!purgeMemory && fs.existsSync(memory)) {
    memoryBackup = nextBackupPath(stateHome, opts.now || new Date());
    fs.renameSync(memory, memoryBackup);
    say("SAVED", `${memory} → ${memoryBackup}`);
  }

  // Nếu gỡ bản cài thất bại, trả memory về chỗ cũ: một uninstall dở dang không được để dữ
  // liệu bị tách khỏi một bản cài vẫn còn đang chạy.
  try {
    removeInstall(repoRoot, channel, opts, say);
  } catch (error) {
    if (memoryBackup && fs.existsSync(memoryBackup) && !fs.existsSync(memory)) {
      try { fs.renameSync(memoryBackup, memory); } catch { /* backup vẫn còn, tên vẫn rõ */ }
    }
    throw error;
  }

  // Module đã được Node nạp vào RAM nên vẫn tiếp tục cleanup được sau khi thư mục cài biến mất.
  cleanupProjects(projects, say);
  removeOwnedState(stateHome, say);
  const purged = purgeMemory && fs.existsSync(memory);
  if (purged) fs.rmSync(memory, { recursive: true, force: true });
  try {
    for (const entry of CLI.uninstallCli(repoRoot, { ...opts, env, platform }))
      say(entry.level, entry.text);
  } catch (e) {
    say("WARN", `không gỡ hết CLI/PATH: ${e.message}`);
  }

  if (purged) say("PURGED", `${memory} đã bị xoá theo yêu cầu --purge-memory`);
  else if (!memoryBackup) say("ABSENT", `không có ${memory} để backup`);
  say("KEEP", "trust Claude/Codex — vô hại và có thể đã tồn tại trước alp-code");
  return { log, memoryBackup, projects, channel };
}

/**
 * Gỡ thư mục cài theo đúng cách của channel.
 *
 * Bản npm phải do npm gỡ: `rm -rf` thư mục package để lại entry ma trong registry global,
 * và lần `npm i -g alp-code` sau đó có thể im lặng không làm gì vì npm tin rằng nó đã cài rồi.
 */
function removeInstall(repoRoot, channel, opts, say) {
  if (channel === "npm") {
    const run = opts.runCommand || npmCommand;
    const result = run("npm", ["uninstall", "--global", "alp-code"]);
    if (result.error || result.status !== 0)
      throw new Error(`\`npm uninstall -g alp-code\` thất bại: ${(result.stderr || result.error?.message || `exit ${result.status}`).toString().trim()}`);
    say("REMOVED", `bản npm ${repoRoot} (qua npm uninstall -g)`);
    return;
  }

  // Tarball: xoá cả nhà `~/.alp-code` — versions/, current, chứ không riêng version đang chạy.
  const home = channel === "tarball" ? tarballHomeOf(repoRoot) : repoRoot;
  try {
    fs.rmSync(home, { recursive: true, force: false });
  } catch (error) {
    throw new Error(`không xoá được ${home}: ${error.message}`);
  }
  say("REMOVED", home);
}

/** `<home>/versions/<tag>` hoặc `<home>/current` → `<home>`; layout lạ thì giữ nguyên. */
function tarballHomeOf(repoRoot) {
  const parent = path.dirname(repoRoot);
  if (path.basename(parent) === "versions") return path.dirname(parent);
  if (path.basename(repoRoot) === "current") return parent;
  return repoRoot;
}

function npmCommand(command, args) {
  const { spawnSyncCommand } = require("./delegation/command-runner.cjs");
  return spawnSyncCommand(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Xoá phần state của alp-code trong `~/.alp`, đúng từng tên trong OWNED_STATE.
 *
 * Thư mục này là nhà chung — `alp` bản khác, config, và những thứ người dùng tự để vào đều
 * có thể đang ở đó. `rm -rf ~/.alp` là cách nhanh nhất để một lệnh gỡ cài đặt xoá mất thứ
 * không phải của nó.
 */
function removeOwnedState(stateHome, say) {
  if (!stateHome || !fs.existsSync(stateHome)) {
    say("ABSENT", "state cục bộ");
    return;
  }
  const removed = [];
  for (const name of OWNED_STATE) {
    const target = path.join(stateHome, name);
    if (!fs.existsSync(target)) continue;
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(name);
  }
  if (removed.length) say("REMOVED", `${stateHome}: ${removed.join(", ")}`);
  else say("ABSENT", `${stateHome} không có state của alp-code`);
  try { if (!fs.readdirSync(stateHome).length) fs.rmdirSync(stateHome); } catch { /* còn thứ của người khác */ }
}

function assertInstallRoot(repoRoot) {
  if (path.dirname(repoRoot) === repoRoot)
    throw new Error(`từ chối uninstall đường dẫn gốc: ${repoRoot}`);
  for (const required of ["package.json", path.join("scripts", "alp.cjs")]) {
    if (!fs.existsSync(path.join(repoRoot, required)))
      throw new Error(`${repoRoot} không phải một bản cài alp-code (thiếu ${required})`);
  }
}

/** Không xoá một dev clone còn việc chưa commit hoặc commit chưa push. */
function assertGitSafe(repoRoot) {
  if (!fs.existsSync(path.join(repoRoot, ".git"))) return;
  const status = git(repoRoot, ["status", "--porcelain"]);
  if (status.stdout.trim())
    throw new Error("repo alp-code còn thay đổi chưa commit — xử lý trước, hoặc dùng --force nếu thật sự muốn xoá");

  const upstream = git(repoRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], true);
  if (upstream.status !== 0) return;
  const ahead = git(repoRoot, ["rev-list", "--count", "@{u}..HEAD"]);
  if (Number(ahead.stdout.trim()) > 0)
    throw new Error("repo alp-code có commit chưa push — push/backup trước, hoặc dùng --force nếu thật sự muốn xoá");
}

function git(repoRoot, args, allowFailure = false) {
  const r = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
  if (r.error) throw new Error(`không chạy được git: ${r.error.message}`);
  if (!allowFailure && r.status !== 0)
    throw new Error((r.stderr || "").trim() || `git ${args[0]} thất bại (exit ${r.status})`);
  return r;
}

function registeredProjects(repoRoot, platform, env = process.env) {
  const file = path.join(P.stateHome(env), "projects.json");
  if (!fs.existsSync(file)) return [];
  const projects = JSON.parse(fs.readFileSync(file, "utf8")).projects || [];
  return [...new Map(projects.map((entry) => {
    const resolved = path.resolve(entry.path);
    return [platform === "win32" ? resolved.toLowerCase() : resolved, resolved];
  })).values()];
}

function cleanupProjects(projects, say) {
  for (const project of projects) {
    if (!fs.existsSync(project)) {
      say("ABSENT", `${project} — workspace không còn trên đĩa`);
      continue;
    }
    try {
      for (const file of [path.join(project, ".claude", "settings.local.json"), path.join(project, ".codex", "config.toml")]) {
        if (!fs.existsSync(file)) continue;
        const body = fs.readFileSync(file, "utf8");
        if (!body.toLowerCase().includes("alp init")) { say("KEEP", `${file} — không phải file do alp init sinh`); continue; }
        fs.rmSync(file);
        say("REMOVED", file);
        const backup = `${file}.alp-backup`;
        if (fs.existsSync(backup)) { fs.renameSync(backup, file); say("RESTORED", file); }
      }
    } catch (e) {
      say("WARN", `${project} — không gỡ hết config cục bộ: ${e.message}`);
    }
  }
}

/** `~/.alp` → `~/.alp.memory-backup-<stamp>`: cạnh state home, không nằm trong thứ vừa bị xoá. */
function nextBackupPath(anchor, now) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const base = `${anchor}.memory-backup-${stamp}`;
  let candidate = base;
  for (let i = 2; fs.existsSync(candidate); i++) candidate = `${base}-${i}`;
  return candidate;
}

function isWithin(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

module.exports = {
  uninstall,
  assertInstallRoot,
  assertGitSafe,
  registeredProjects,
  nextBackupPath,
  isWithin,
  removeOwnedState,
  tarballHomeOf,
  OWNED_STATE,
};

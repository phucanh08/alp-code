// uninstall.cjs — gỡ cài đặt alp-code nhưng không làm mất memory âm thầm.
//
// Mặc định:
//   · gỡ config alp init khỏi mọi workspace còn tồn tại
//   · chuyển memory/ ra một backup cạnh repo
//   · xoá repo, shim/symlink `alp`, và PATH do installer thêm
//   · giữ trust Claude/Codex: entry có thể đã tồn tại trước alp-code và để lại thì vô hại
//
// `--purge-memory` do alp.cjs chuyển vào mới cho phép memory bị xoá cùng repo.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const L = require("./loadout.cjs");
const PC = require("./project-config.cjs");
const CLI = require("./cli-link.cjs");

function uninstall(repoRoot, opts = {}) {
  repoRoot = path.resolve(repoRoot);
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const cwd = path.resolve(opts.cwd || process.cwd());
  const purgeMemory = !!opts.purgeMemory;
  const force = !!opts.force;
  const log = [];
  const say = (level, text) => log.push({ level, text });

  assertInstallRoot(repoRoot);
  if (isWithin(repoRoot, cwd))
    throw new Error(`cwd đang nằm trong ${repoRoot} — cd ra ngoài thư mục này rồi chạy lại \`alp uninstall\``);
  if (!force) assertGitSafe(repoRoot);

  // Phải lấy danh sách trước khi xoá repo vì nguồn nằm trong identity/*/loadout.yaml.
  const projects = opts.projectPaths || registeredProjects(repoRoot, platform);
  const memory = path.join(repoRoot, "memory");
  let memoryBackup = null;

  if (!purgeMemory && fs.existsSync(memory)) {
    memoryBackup = nextBackupPath(repoRoot, opts.now || new Date());
    fs.renameSync(memory, memoryBackup);
    say("SAVED", `memory/ → ${memoryBackup}`);
  }

  // Xoá code trước. Nếu bước này fail, trả memory về chỗ cũ để uninstall thất bại không
  // làm dữ liệu bị tách khỏi một repo vẫn còn tồn tại.
  try {
    fs.rmSync(repoRoot, { recursive: true, force: false });
    say("REMOVED", repoRoot);
  } catch (e) {
    if (memoryBackup && fs.existsSync(memoryBackup) && fs.existsSync(repoRoot) && !fs.existsSync(memory)) {
      try { fs.renameSync(memoryBackup, memory); } catch {}
    }
    throw new Error(`không xoá được ${repoRoot}: ${e.message}`);
  }

  // Module đã được Node nạp vào RAM nên vẫn tiếp tục cleanup được sau khi repo biến mất.
  cleanupProjects(projects, say);
  try {
    for (const entry of CLI.uninstallCli(repoRoot, { ...opts, env, platform }))
      say(entry.level, entry.text);
  } catch (e) {
    say("WARN", `không gỡ hết CLI/PATH: ${e.message}`);
  }

  if (purgeMemory) say("PURGED", "memory/ đã bị xoá theo yêu cầu --purge-memory");
  else if (!memoryBackup) say("ABSENT", "repo không có memory/ để backup");
  say("KEEP", "trust Claude/Codex — vô hại và có thể đã tồn tại trước alp-code");
  return { log, memoryBackup, projects };
}

function assertInstallRoot(repoRoot) {
  if (path.dirname(repoRoot) === repoRoot)
    throw new Error(`từ chối uninstall đường dẫn gốc: ${repoRoot}`);
  for (const required of ["CHARTER.md", path.join("scripts", "alp.cjs")]) {
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

function registeredProjects(repoRoot, platform) {
  const byPath = new Map();
  for (const role of L.listRoles(repoRoot)) {
    const ws = L.effectiveWorkspaces(L.loadLoadout(repoRoot, role));
    for (const candidate of [...ws.read, ...ws.write]) {
      const resolved = path.resolve(candidate);
      if (isWithin(repoRoot, resolved)) continue;
      const key = platform === "win32" ? resolved.toLowerCase() : resolved;
      byPath.set(key, resolved);
    }
  }
  return [...byPath.values()];
}

function cleanupProjects(projects, say) {
  for (const project of projects) {
    if (!fs.existsSync(project)) {
      say("ABSENT", `${project} — workspace không còn trên đĩa`);
      continue;
    }
    try {
      for (const { file, action } of PC.uninstall(project)) {
        if (action === "ABSENT") continue;
        if (action === "FOREIGN") say("KEEP", `${file} — không phải file do alp init sinh`);
        else say(action, file);
      }
      if (PC.setGitExclude(project, false)) say("WROTE", `${project} — gỡ khối exclude per-clone`);
    } catch (e) {
      say("WARN", `${project} — không gỡ hết config cục bộ: ${e.message}`);
    }
  }
}

function nextBackupPath(repoRoot, now) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const base = `${repoRoot}.memory-backup-${stamp}`;
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
};

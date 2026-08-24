// project-config.cjs — sinh config CỤC BỘ trong một project code, để `claude` (hoặc
// `codex`) gõ ngay trong repo đó là ra Phở. Không `cd`, không flag.
//
//   <project>/.claude/settings.local.json   slot CÁ NHÂN của Claude Code
//   <project>/.codex/config.toml            layer project của Codex
//
// VÌ SAO LÀ `settings.local.json` CHỨ KHÔNG PHẢI `settings.json`: đây là repo của người
// khác. `settings.json` là file dùng chung của cả team và được commit; `settings.local.json`
// là slot cá nhân. Cộng với khối exclude per-clone (không tracked) ⇒ `git status` của họ
// không đổi một dòng nào.
//
// CẢ HAI FILE SINH TỪ CÙNG `loadout.yaml`. settings.local.json đi qua
// lib/claude-settings.cjs — đúng builder mà compile-acl dùng cho identity/<role>/, nên
// deny-list không thể lệch giữa hai nơi.
//
// BẤT BIẾN CHARTER Ở ĐÂY: cwd chưa nằm trong `workspaces` của vai ⇒ phải DENY TƯỜNG MINH.
// Claude Code mặc nhiên cho ghi thư mục làm việc, nên "chưa đăng ký" mà không deny thì
// bất biến "cwd lạ = read-only" vỡ IM LẶNG: không lỗi, không cảnh báo, chỉ là agent ghi
// được thứ nó không được phép ghi.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const L = require("./loadout.cjs");
const S = require("./claude-settings.cjs");
const P = require("./codex-profile.cjs");
const D = require("./delegation/config.cjs");

/** Dấu nhận biết file do `alp init` sinh. Không có dấu này = file của người ta, không đụng. */
const MARKER = "alp init";
const BACKUP_SUFFIX = ".alp-backup";

const EXCLUDE_BEGIN = "# >>> alp-code (alp init) — gỡ bằng: alp deinit";
const EXCLUDE_END = "# <<< alp-code";
/** Khớp cả marker cũ (`alp init --uninstall`): khối đã ghi ra ngoài kia vẫn phải gỡ được. */
const EXCLUDE_BEGIN_RE = "# >>> alp-code \\(alp init\\)[^\\n]*";
const PROJECT_SKILL_DIRS = [
  [".claude", "skills"],
  [".agents", "skills"],
];

function paths(projectPath) {
  return {
    claude: path.join(projectPath, ".claude", "settings.local.json"),
    codex: path.join(projectPath, ".codex", "config.toml"),
  };
}

function projectSkillDirs(projectPath) {
  return PROJECT_SKILL_DIRS.map((parts) => path.join(projectPath, ...parts));
}

// ---------------------------------------------------------------- nội dung

/** Project có nằm trong workspace đã khai của vai không? */
function isRegistered(loadout, projectPath) {
  const ws = L.effectiveWorkspaces(loadout);
  return [...ws.read, ...ws.write].some((root) => L.isWithin(root, projectPath));
}

/**
 * Object `<project>/.claude/settings.local.json`.
 *
 * Hàm THUẦN: cùng loadout + cùng path ⇒ cùng kết quả. `alp init` chạy hai lần cho ra
 * hai file byte-identical, và test kiểm được cả nhánh "chưa đăng ký" mà không cần
 * thật sự đăng ký gì.
 */
function claudeSettings(repoRoot, role, projectPath, allRoles, loadout, opts = {}) {
  const lo = loadout || L.loadLoadout(repoRoot, role);
  const stateDir = opts.delegationStateDir || D.loadDelegationConfig(repoRoot).stateDir;
  const settings = S.buildSettings(repoRoot, role, allRoles, lo, {
    delegationStateDir: stateDir,
  });
  const registered = isRegistered(lo, projectPath);

  settings.$comment =
    `GENERATED bởi \`${MARKER}\` từ identity/${role}/loadout.yaml — KHÔNG SỬA TAY. ` +
    `Sinh lại: \`alp init\` · gỡ: \`alp deinit\`. ` +
    "Absolute path trong permission rule dùng TIỀN TỐ HAI GẠCH `//`.";
  settings.$generatedBy = MARKER;
  settings.$alpRepo = repoRoot;
  settings.$alpProject = projectPath;

  // Danh tính đi theo settings, không theo cwd: hook đọc ALP_ROLE để biết mình là ai.
  // Không có dòng này thì `sessionIdentity` rơi về quy ước cwd = identity/<role>/ và
  // đoán ra vai bằng tên thư mục project.
  settings.env = { ALP_ROLE: role };

  if (!registered) {
    // Edit(...) phủ cả Write/NotebookEdit — Claude Code chỉ hiểu Read/Edit trong path
    // rule, các verb khác bị bỏ qua kèm warning lúc boot (xem doctor: ACL-SYNTAX).
    settings.permissions.deny.push(`Edit(${S.absoluteRule(projectPath, true)})`);
    // Path rule không chặn được Bash. ALP_READONLY_DIRS là đường duy nhất để acl-guard
    // biết thư mục này chỉ-đọc, và Bash mới là lỗ hổng thật (CHARTER §6).
    settings.env.ALP_READONLY_DIRS = projectPath;
  }

  return settings;
}

/**
 * Nội dung `<project>/.codex/config.toml` — layer cấp project của Codex, đứng TRÊN
 * config user (`codex-rs/config/src/loader`).
 *
 * Khác profile trong `$CODEX_HOME` đúng một điểm: sandbox. Ở đó `run-role` nâng quyền
 * theo từng lần chạy nên profile pin `read-only`; ở đây không có launcher nào chen vào
 * giữa — người dùng gõ thẳng `codex` — nên mức quyền phải đúng ngay trong file.
 */
function codexConfig(repoRoot, role, projectPath, loadout, opts = {}) {
  const lo = loadout || L.loadLoadout(repoRoot, role);
  const stateDir = opts.delegationStateDir || D.loadDelegationConfig(repoRoot).stateDir;
  const mayDelegate = L.canDelegate(lo);
  return P.buildProfile(lo, role, repoRoot, {
    sandboxMode: isRegistered(lo, projectPath) ? "workspace-write" : "read-only",
    writableRoots: mayDelegate ? [stateDir] : [],
    // Herdr dùng Unix socket và Paseo dùng daemon localhost. Raw runtime commands vẫn
    // bị acl-guard chặn; chỉ Delegation API đã qua policy được phép tận dụng network này.
    networkAccess: mayDelegate,
    header: [
      `# GENERATED bởi \`${MARKER}\` từ ${path.join(repoRoot, "identity", role, "loadout.yaml")} — KHÔNG SỬA TAY.`,
      `# Sinh lại: \`alp init\` · gỡ: \`alp deinit\``,
    ],
  });
}

// ---------------------------------------------------------------- ghi / gỡ

/** File này có phải do alp init sinh không? File lạ = tuyệt đối không ghi đè, không xoá. */
function isGenerated(file) {
  if (!fs.existsSync(file)) return false;
  return fs.readFileSync(file, "utf8").includes(MARKER);
}

/**
 * Ghi một file config, giữ nguyên file sẵn có của người ta bằng cách đổi tên thành
 * `<file>.alp-backup` (uninstall sẽ trả lại). Trả về "WROTE" | "KEEP" | "BACKUP".
 */
function writeConfig(file, body) {
  let action = "WROTE";
  if (fs.existsSync(file) && !isGenerated(file)) {
    const backup = file + BACKUP_SUFFIX;
    if (fs.existsSync(backup))
      throw new Error(
        `${file} là file của bạn nhưng ${path.basename(backup)} đã tồn tại — ` +
          "dọn thủ công một trong hai rồi chạy lại, alp init không tự chọn hộ"
      );
    fs.renameSync(file, backup);
    action = "BACKUP";
  } else if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === body) {
    return "KEEP";
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return action;
}

/** Sinh cả hai file. Trả về [{ file, action }]. */
function install(repoRoot, role, projectPath, allRoles) {
  const lo = L.loadLoadout(repoRoot, role);
  const delegationConfig = D.loadDelegationConfig(repoRoot);
  if (L.canDelegate(lo))
    fs.mkdirSync(delegationConfig.stateDir, { recursive: true, mode: 0o700 });
  const runtimeOpts = { delegationStateDir: delegationConfig.stateDir };
  const p = paths(projectPath);
  return [
    {
      file: p.claude,
      action: writeConfig(
        p.claude,
        JSON.stringify(claudeSettings(repoRoot, role, projectPath, allRoles, lo, runtimeOpts), null, 2) + "\n"
      ),
    },
    {
      file: p.codex,
      action: writeConfig(p.codex, codexConfig(repoRoot, role, projectPath, lo, runtimeOpts)),
    },
    ...syncProjectSkills(repoRoot, projectPath, lo.skills || []),
  ];
}

/** Gỡ hai file (chỉ file có MARKER), trả lại backup, dọn thư mục rỗng. */
function uninstall(projectPath, repoRoot = null) {
  const out = [];
  if (repoRoot) out.push(...removeProjectSkills(repoRoot, projectPath));
  for (const file of Object.values(paths(projectPath))) {
    const backup = file + BACKUP_SUFFIX;
    if (!fs.existsSync(file)) out.push({ file, action: "ABSENT" });
    else if (!isGenerated(file)) out.push({ file, action: "FOREIGN" }); // không phải của mình
    else {
      fs.rmSync(file);
      out.push({ file, action: "REMOVED" });
    }
    if (fs.existsSync(backup) && !fs.existsSync(file)) {
      fs.renameSync(backup, file);
      out.push({ file, action: "RESTORED" });
    }
    rmdirIfEmpty(path.dirname(file));
  }
  return out;
}

function syncProjectSkills(repoRoot, projectPath, names) {
  const out = [];
  const wanted = [...new Set(names)].sort();
  for (const dir of projectSkillDirs(projectPath)) {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of fs.readdirSync(dir)) {
      const link = path.join(dir, name);
      if (isAlpSkillLink(repoRoot, link) && !wanted.includes(name)) {
        fs.rmSync(link, { recursive: true, force: true });
        out.push({ file: link, action: "UNLINK" });
      }
    }
    for (const name of wanted) {
      const source = path.join(repoRoot, "skills", name);
      const link = path.join(dir, name);
      if (!fs.existsSync(source)) continue; // loadout validation will report the real error
      if (fs.existsSync(link) || isSymlink(link)) {
        const same = isAlpSkillLink(repoRoot, link) && safeRealpath(link) === safeRealpath(source);
        out.push({ file: link, action: same ? "KEEP" : "SKIP" });
        continue;
      }
      const target = process.platform === "win32" ? source : path.relative(dir, source);
      fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
      out.push({ file: link, action: "LINK" });
    }
    rmdirIfEmpty(dir);
    rmdirIfEmpty(path.dirname(dir));
  }
  return out;
}

function removeProjectSkills(repoRoot, projectPath) {
  const out = [];
  for (const dir of projectSkillDirs(projectPath)) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const link = path.join(dir, name);
      if (!isAlpSkillLink(repoRoot, link)) continue;
      fs.rmSync(link, { recursive: true, force: true });
      out.push({ file: link, action: "UNLINK" });
    }
    rmdirIfEmpty(dir);
    rmdirIfEmpty(path.dirname(dir));
  }
  return out;
}

function isSymlink(file) {
  try { return fs.lstatSync(file).isSymbolicLink(); } catch { return false; }
}

function safeRealpath(file) {
  try { return fs.realpathSync(file); } catch { return null; }
}

function isAlpSkillLink(repoRoot, file) {
  if (!isSymlink(file)) return false;
  const resolved = safeRealpath(file);
  return Boolean(resolved && L.isWithin(path.join(repoRoot, "skills"), resolved));
}

function rmdirIfEmpty(dir) {
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {}
}

// ---------------------------------------------------------------- git

/**
 * File exclude per-clone của project (`info/exclude` trong thư mục git).
 * Dùng nó chứ KHÔNG dùng `.gitignore`: `.gitignore` được tracked, sửa vào đó là bẩn
 * repo của người khác — đúng thứ mà "git status không đổi" cấm.
 */
function excludeFile(projectPath) {
  const gitDir = git(projectPath, ["rev-parse", "--absolute-git-dir"]);
  return gitDir ? path.join(gitDir, "info", "exclude") : null;
}

/** Thêm/gỡ khối exclude cho hai file config. Trả về true nếu có đổi. */
function setGitExclude(projectPath, on, skillNames = []) {
  const file = excludeFile(projectPath);
  if (!file) return false; // không phải git repo — không có gì để giấu

  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const stripped = current.replace(
    new RegExp(`\\n?${EXCLUDE_BEGIN_RE}[\\s\\S]*?${escapeRe(EXCLUDE_END)}\\n?`, "g"),
    "\n"
  );
  const skillLines = [...new Set(skillNames)].sort().flatMap((name) => [
    `/.claude/skills/${name}`,
    `/.agents/skills/${name}`,
  ]);
  const managed = ["/.claude/settings.local.json", "/.codex/config.toml", ...skillLines];
  const next = on
    ? stripped.trimEnd() +
      `\n\n${EXCLUDE_BEGIN}\n${managed.join("\n")}\n${EXCLUDE_END}\n`
    : stripped;

  if (next === current) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  return true;
}

/**
 * File config nào đang được project TRACK? Với những file đó khối exclude vô hiệu
 * (exclude chỉ áp cho file untracked) ⇒ `git status` của người ta sẽ đổi.
 * Không tự ý xử lý hộ — nói thẳng ra để họ quyết.
 */
function trackedConfigs(projectPath) {
  const rels = Object.values(paths(projectPath)).map((f) =>
    path.relative(projectPath, f).split(path.sep).join("/")
  );
  const out = git(projectPath, ["ls-files", "--", ...rels]);
  return out ? out.split("\n").filter(Boolean) : [];
}

function git(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

module.exports = {
  MARKER, BACKUP_SUFFIX, paths, claudeSettings, codexConfig, isRegistered,
  projectSkillDirs, syncProjectSkills, removeProjectSkills,
  install, uninstall, isGenerated, setGitExclude, trackedConfigs,
};

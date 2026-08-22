// skill-links.cjs — loadout.skills → symlink trong thư mục skill của TỪNG runtime.
//
// VÌ SAO CẦN FILE NÀY. `skills/` ở gốc repo KHÔNG runtime nào tự thấy. Cả Claude Code lẫn
// Codex chỉ quét thư mục skill tính từ CWD của phiên, mà CWD là `identity/<role>/`
// (CHARTER §7). Trước khi có module này, `skills:` trong loadout chỉ là một dòng chữ in ra
// trong thẻ danh tính — không vai nào thật sự nạp được skill nào.
//
// VÌ SAO SYMLINK, KHÔNG COPY. `skills/` là nguồn sự thật duy nhất. Copy sang 8 vai = 8 bản
// trôi lệch âm thầm, đúng thứ CHARTER §2.3 cấm. Symlink hỏng thì hỏng to và thấy ngay.
//
// VÌ SAO LINK TỪNG SKILL, KHÔNG LINK CẢ THƯ MỤC. Link nguyên `skills/` = mọi vai thấy mọi
// skill, `skills:` lại thành trang trí. Link đúng những tên trong loadout khiến `skills:`
// trở thành ACL thật — cùng một nguyên tắc least-privilege với `tools:` và `memory:`.
//
// VÌ SAO TARGET TƯƠNG ĐỐI. Symlink tuyệt đối chết khi repo bị clone sang máy/đường dẫn
// khác — cùng lớp lỗi với path tuyệt đối trong `workspaces:` đã sửa trước đó.
//
// VÌ SAO HAI THƯ MỤC. Hai runtime quét hai chỗ khác nhau, cùng tính từ CWD của phiên:
//   Claude Code → `.claude/skills/`
//   Codex       → `.agents/skills/` (và `.codex/skills/`, `$CODEX_HOME/skills/`)
// Cả hai đều ĐI THEO symlink của **thư mục** skill. Đo bằng `codex debug prompt-input`.
// BẪY đã đo: symlink riêng `SKILL.md` bên trong một thư mục thật thì Codex BỎ QUA —
// skill là package (kèm `scripts/`, `references/`), phải link nguyên thư mục.

const fs = require("fs");
const path = require("path");

/** Thư mục quét skill của từng runtime, tính từ `identity/<role>/`. */
const RUNTIME_DIRS = [
  [".claude", "skills"],   // Claude Code
  [".agents", "skills"],   // Codex
];

/** Mọi thư mục chứa symlink của một vai — một cái cho mỗi runtime. */
function linkDirs(repoRoot, role) {
  return RUNTIME_DIRS.map((seg) => path.join(repoRoot, "identity", role, ...seg));
}

/**
 * Tên mọi skill có thật trong `skills/`. Một thư mục chỉ tính là skill khi có `SKILL.md` —
 * thư mục rỗng hoặc thư mục rác không được phép lọt vào để rồi hỏng lúc runtime.
 */
function availableSkills(repoRoot) {
  const dir = path.join(repoRoot, "skills");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort();
}

/** Target tương đối từ `identity/<role>/<runtime>/skills/` ngược về `skills/<tên>`. */
function relativeTarget(name) {
  return path.join("..", "..", "..", "..", "skills", name);
}

/** Trạng thái một thư mục link: tên → target đang trỏ (null nếu không phải symlink). */
function currentLinks(dir) {
  if (!fs.existsSync(dir)) return null;
  const out = {};
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    out[e.name] = e.isSymbolicLink() ? fs.readlinkSync(path.join(dir, e.name)) : null;
  }
  return out;
}

/** Đồng bộ MỘT thư mục runtime về đúng `want`. */
function syncOne(dir, want) {
  const created = [];
  const removed = [];

  // Vai không có skill nào: dọn sạch thay vì để lại link cũ của lần compile trước.
  if (!want.length) {
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) {
        fs.rmSync(path.join(dir, name), { recursive: true, force: true });
        removed.push(name);
      }
      fs.rmdirSync(dir);
      // Dọn cả thư mục cha (`.agents/`) nếu nó rỗng — `.claude/` thì không, nó còn
      // `settings.json`. `rmdirSync` tự ném khi thư mục không rỗng, nên bọc try.
      try { fs.rmdirSync(path.dirname(dir)); } catch {}
    }
    return { created, removed };
  }

  fs.mkdirSync(dir, { recursive: true });

  const existing = currentLinks(dir) || {};
  for (const name of Object.keys(existing)) {
    if (!want.includes(name) || existing[name] !== relativeTarget(name)) {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      removed.push(name);
    }
  }
  for (const name of want) {
    const link = path.join(dir, name);
    if (fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()) continue;
    fs.symlinkSync(relativeTarget(name), link);
    created.push(name);
  }

  return { created, removed };
}

/**
 * Đồng bộ link của một vai cho MỌI runtime.
 * Trả `{ created, removed }` — mỗi phần tử là `<runtime>/<tên skill>` để caller in ra.
 * Im lặng sửa filesystem là cách chắc chắn nhất để không ai biết một link đã biến mất.
 */
function syncSkillLinks(repoRoot, role, loadout) {
  const want = [...new Set(loadout.skills || [])].sort();
  const created = [];
  const removed = [];
  for (const dir of linkDirs(repoRoot, role)) {
    const label = path.basename(path.dirname(dir));
    const r = syncOne(dir, want);
    created.push(...r.created.map((n) => `${label}/skills/${n}`));
    removed.push(...r.removed.map((n) => `${label}/skills/${n}`));
  }
  return { created, removed };
}

/** Mô tả chỗ lệch giữa filesystem và loadout. Rỗng = khớp. Dùng cho `--check` và doctor. */
function checkSkillLinks(repoRoot, role, loadout) {
  const want = [...new Set(loadout.skills || [])].sort();
  const issues = [];

  for (const dir of linkDirs(repoRoot, role)) {
    const label = path.basename(path.dirname(dir));
    const have = currentLinks(dir);

    if (have === null) {
      if (want.length)
        issues.push(`thiếu identity/${role}/${label}/skills/ — ${want.length} skill chưa link`);
      continue;
    }
    for (const name of want) {
      if (!(name in have)) issues.push(`${label}/skills: thiếu link \`${name}\``);
      else if (have[name] !== relativeTarget(name))
        issues.push(`${label}/skills: link \`${name}\` trỏ sai: ${have[name] || "(không phải symlink)"}`);
    }
    for (const name of Object.keys(have)) {
      if (!want.includes(name)) issues.push(`${label}/skills: thừa link \`${name}\` — không có trong \`skills:\``);
    }
  }
  return issues;
}

module.exports = { availableSkills, linkDirs, relativeTarget, syncSkillLinks, checkSkillLinks };

// skill-links.cjs — loadout.skills → `identity/<role>/.claude/skills/<tên>` (symlink).
//
// VÌ SAO CẦN FILE NÀY. `skills/` ở gốc repo KHÔNG runtime nào tự thấy. Claude Code chỉ nạp
// skill từ `<cwd>/.claude/skills/`, mà CWD của phiên là `identity/<role>/` (CHARTER §7).
// Trước khi có module này, `skills:` trong loadout chỉ là một dòng chữ in ra trong thẻ
// danh tính — không vai nào thật sự nạp được skill nào.
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

const fs = require("fs");
const path = require("path");

/** Thư mục chứa symlink của một vai. */
function linkDir(repoRoot, role) {
  return path.join(repoRoot, "identity", role, ".claude", "skills");
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

/** Target tương đối từ `identity/<role>/.claude/skills/` ngược về `skills/<tên>`. */
function relativeTarget(name) {
  return path.join("..", "..", "..", "..", "skills", name);
}

/** Trạng thái hiện tại của thư mục link: tên → target đang trỏ (null nếu không phải symlink). */
function currentLinks(repoRoot, role) {
  const dir = linkDir(repoRoot, role);
  if (!fs.existsSync(dir)) return null;
  const out = {};
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    out[e.name] = e.isSymbolicLink() ? fs.readlinkSync(path.join(dir, e.name)) : null;
  }
  return out;
}

/**
 * Đồng bộ thư mục link của một vai về đúng `loadout.skills`.
 * Trả `{ created, removed }` để caller in ra — im lặng sửa filesystem là cách chắc chắn
 * nhất để không ai biết một link đã biến mất.
 */
function syncSkillLinks(repoRoot, role, loadout) {
  const dir = linkDir(repoRoot, role);
  const want = [...new Set(loadout.skills || [])].sort();
  const created = [];
  const removed = [];

  // Vai không có skill nào: dọn sạch thư mục thay vì để lại link cũ của lần compile trước.
  if (!want.length) {
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) {
        fs.rmSync(path.join(dir, name), { recursive: true, force: true });
        removed.push(name);
      }
      fs.rmdirSync(dir);
    }
    return { created, removed };
  }

  fs.mkdirSync(dir, { recursive: true });

  const existing = currentLinks(repoRoot, role) || {};
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

/** Mô tả chỗ lệch giữa filesystem và loadout. Rỗng = khớp. Dùng cho `--check` và doctor. */
function checkSkillLinks(repoRoot, role, loadout) {
  const want = [...new Set(loadout.skills || [])].sort();
  const have = currentLinks(repoRoot, role);

  if (have === null) {
    return want.length ? [`thiếu identity/${role}/.claude/skills/ — ${want.length} skill chưa link`] : [];
  }

  const issues = [];
  for (const name of want) {
    if (!(name in have)) issues.push(`thiếu link \`${name}\``);
    else if (have[name] !== relativeTarget(name))
      issues.push(`link \`${name}\` trỏ sai: ${have[name] || "(không phải symlink)"}`);
  }
  for (const name of Object.keys(have)) {
    if (!want.includes(name)) issues.push(`thừa link \`${name}\` — không có trong \`skills:\``);
  }
  return issues;
}

module.exports = { availableSkills, linkDir, relativeTarget, syncSkillLinks, checkSkillLinks };

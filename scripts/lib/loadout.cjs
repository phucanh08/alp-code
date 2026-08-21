// loadout.cjs — lớp dùng chung cho compile-acl, hooks, doctor.
//
// Một parser YAML, một hàm khớp glob, một định nghĩa "vai này được đọc/ghi gì".
// Mọi nơi khác chỉ gọi vào đây. Đừng viết lại logic ACL ở chỗ thứ hai.

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------- repo root

/** Đi ngược lên tới thư mục có CHARTER.md. null nếu không tìm thấy. */
function findRepoRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, "CHARTER.md"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// ---------------------------------------------------------------- YAML (tập con)

/**
 * Parser cho đúng tập con mà loadout.yaml dùng:
 *   key: scalar
 *   key: [a, b, c]
 *   key:            (map lồng một tầng, thụt 2 space)
 *     sub: [a, b]
 * Không hỗ trợ list nhiều dòng, multi-line string, anchor. Cố tình —
 * loadout.yaml phải đọc được bằng mắt trong 10 giây.
 */
function parseYaml(text) {
  const root = {};
  let current = root;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\s+#.*$/, "").trimEnd();
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;
    const m = line.trim().match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, key, rawValue] = m;

    if (indent === 0) current = root;
    const target = indent === 0 ? root : current;

    if (rawValue === "") {
      const child = {}; // mở một map con
      root[key] = child;
      current = child;
      continue;
    }
    target[key] = parseScalarOrList(rawValue);
  }
  return root;
}

function parseScalarOrList(raw) {
  const v = raw.trim();
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((s) => unquote(s.trim())).filter(Boolean);
  }
  return unquote(v);
}

const unquote = (s) => s.replace(/^["']|["']$/g, "");

// ---------------------------------------------------------------- glob

/** Ví dụ: `shared/**` hoặc `projects/<sao>/refs/**` → RegExp neo hai đầu. */
function globToRegExp(pattern) {
  const doubleStar = "__AGENT_MEMORY_DOUBLE_STAR__";
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, doubleStar)
    .replace(/\*/g, "[^/]*")
    .replaceAll(doubleStar, ".*");
  return new RegExp("^" + escaped + "$");
}

/** Đường dẫn (chuẩn hoá, dùng `/`) có khớp bất kỳ pattern nào không? */
function matchesAny(relPath, patterns) {
  return patterns.some((p) => globToRegExp(p).test(relPath));
}

// ---------------------------------------------------------------- vai

/** Mọi vai trong identity/, bỏ qua thư mục `_*`. Sắp xếp ổn định. */
function listRoles(repoRoot) {
  const dir = path.join(repoRoot, "identity");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .map((e) => e.name)
    .sort();
}

function loadoutPath(repoRoot, role) {
  return path.join(repoRoot, "identity", role, "loadout.yaml");
}

/**
 * Vai + repo root của phiên hiện tại — dùng chung cho cả hai hook.
 *
 * `ALP_ROLE` đứng TRƯỚC cwd vì danh tính đi theo profile/settings, không theo chỗ đứng:
 * `codex exec -p search -C /repo/nguoi-khac` thì cwd chẳng nói gì về vai. Không có
 * `ALP_ROLE` thì rơi về quy ước cũ (cwd = `identity/<role>/`).
 *
 * `fallbackFrom` là `__dirname` của hook: khi agent đứng ngoài alp-code, repo root không
 * suy ra được từ cwd, nhưng hook thì luôn nằm trong repo.
 */
function sessionIdentity(cwd, fallbackFrom, env = process.env) {
  const repoRoot = findRepoRoot(cwd) || (fallbackFrom ? findRepoRoot(fallbackFrom) : null);
  if (!repoRoot) return null;

  if (env.ALP_ROLE) return { repoRoot, role: env.ALP_ROLE };

  const rel = path.relative(repoRoot, cwd).split(path.sep);
  return { repoRoot, role: rel[0] === "identity" && rel[1] ? rel[1] : path.basename(cwd) };
}

function loadLoadout(repoRoot, role) {
  const p = loadoutPath(repoRoot, role);
  if (!fs.existsSync(p)) return null;
  return parseYaml(fs.readFileSync(p, "utf8"));
}

/**
 * Quyền hiệu dụng: khai báo trong loadout + `private/<role>/**` tự thêm.
 * Đường dẫn tương đối tính từ `memory/`.
 */
function effectiveGrants(loadout, role) {
  const mem = loadout.memory || {};
  const own = `private/${role}/**`;
  const read = [...(mem.read || [])];
  const write = [...(mem.write || [])];
  if (!read.includes(own)) read.push(own);
  if (!write.includes(own)) write.push(own);
  return { read, write };
}

/** Workspace code bên ngoài repo alp-code, dùng path tuyệt đối. */
function effectiveWorkspaces(loadout) {
  const ws = loadout.workspaces || {};
  return {
    read: [...new Set((ws.read || []).map((p) => path.resolve(p)))],
    write: [...new Set((ws.write || []).map((p) => path.resolve(p)))],
  };
}

// ---------------------------------------------------------------- validate

const KNOWN_TOOLS = [
  "Read", "Write", "Edit", "Glob", "Grep", "Bash",
  "WebSearch", "WebFetch", "NotebookEdit", "Task",
];
const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];

// Khai sai chính tả một khoá là hỏng IM LẶNG: `codex_modl:` không lỗi, nó chỉ khiến
// launcher rơi về `model:` — tức đưa model Claude cho Codex. Nên khoá lạ = lỗi.
const KNOWN_KEYS = [
  "role", "name", "emoji", "model", "codex_model", "reasoning_effort",
  "reports_to", "delegates_to", "memory", "workspaces", "tools", "skills",
];

/** Trả về mảng thông báo lỗi. Rỗng = hợp lệ. */
function validate(loadout, role, allRoles) {
  const errs = [];
  const add = (m) => errs.push(`${role}: ${m}`);

  if (!loadout.role) add("thiếu `role:`");
  else if (loadout.role !== role)
    add(`\`role: ${loadout.role}\` không khớp tên thư mục \`${role}\``);

  if (!loadout.name) add("thiếu `name:`");
  if (!loadout.memory) add("thiếu khối `memory:`");
  for (const k of Object.keys(loadout)) {
    if (!KNOWN_KEYS.includes(k)) add(`khoá lạ \`${k}:\` — gõ sai chính tả sẽ hỏng im lặng`);
  }
  if (loadout.reasoning_effort && !REASONING_EFFORTS.includes(loadout.reasoning_effort))
    add(`\`reasoning_effort: ${loadout.reasoning_effort}\` không hợp lệ`);

  const { read = [], write = [] } = loadout.memory || {};
  const workspaces = loadout.workspaces || {};
  const wsRead = workspaces.read || [];
  const wsWrite = workspaces.write || [];

  // Luật 2 — mọi mục write phải nằm trong read.
  for (const w of write) {
    const probe = w.replace(/\*\*/g, "x").replace(/\*/g, "x");
    if (!read.includes(w) && !matchesAny(probe, read))
      add(`\`${w}\` có trong write nhưng không nằm trong read`);
  }

  // Luật 3 — cấm cứng đụng private của vai khác.
  for (const p of [...read, ...write]) {
    const m = p.match(/^private\/([^/]+)/);
    if (m && m[1] !== role)
      add(`khai \`${p}\` — cấm đọc/ghi private của vai khác, không có ngoại lệ`);
  }

  for (const p of [...wsRead, ...wsWrite]) {
    if (!path.isAbsolute(p)) add(`workspace \`${p}\` phải là path tuyệt đối`);
  }
  for (const w of wsWrite) {
    const absWrite = path.resolve(w);
    if (!wsRead.some((r) => isWithin(path.resolve(r), absWrite)))
      add(`workspace write \`${w}\` không nằm trong workspaces.read`);
  }

  // Luật 5 — quan hệ trỏ tới vai có thật.
  const known = new Set([...allRoles, "principal"]);
  if (loadout.reports_to && !known.has(loadout.reports_to))
    add(`\`reports_to: ${loadout.reports_to}\` không phải vai có thật`);
  for (const d of loadout.delegates_to || []) {
    if (!known.has(d)) add(`\`delegates_to\` chứa \`${d}\` — không phải vai có thật`);
    if (d === role) add("`delegates_to` chứa chính nó");
  }

  for (const t of loadout.tools || []) {
    if (!KNOWN_TOOLS.includes(t)) add(`tool lạ trong \`tools:\`: ${t}`);
  }

  return errs;
}

// ---------------------------------------------------------------- quyết định ACL

/** Hạ tầng chỉ principal sửa được. Prefix tính từ repo root. */
const FROZEN = [
  ["CHARTER.md", "hiến chương"],
  ["README.md", "README gốc"],
  ["identity/REGISTRY.md", "danh bạ vai"],
  ["identity/_shared/", "luật chung mọi vai"],
  ["identity/_template/", "khuôn vai mới"],
  ["scripts/", "công cụ enforce"],
  ["hooks/", "công cụ enforce"],
  ["skills/", "skill dùng chung"],
];

/**
 * Trái tim của hệ. Dùng bởi cả acl-guard.cjs lẫn test — một nguồn sự thật.
 * `absPath` phải đã resolve tuyệt đối (realpath khi file tồn tại).
 * Trả `null` nếu cho phép, hoặc chuỗi lý do nếu chặn.
 */
function checkPath(repoRoot, role, grants, absPath, isWrite) {
  const rel = path.relative(repoRoot, absPath).split(path.sep).join("/");

  // Ngoài repo — ngoài phạm vi hệ này, để permission thường xử.
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;

  const verb = isWrite ? "ghi" : "đọc";

  // --- kho riêng của vai khác ---
  if (rel === "memory/private")
    return `${role} không được liệt kê \`memory/private/\``;
  const priv = rel.match(/^memory\/private\/([^/]+)/);
  if (priv && priv[1] !== role)
    return `${role} không được ${verb} kho riêng của vai \`${priv[1]}\``;

  // --- persona của vai khác ---
  const ident = rel.match(/^identity\/([^/]+)/);
  if (ident && !ident[1].startsWith("_") && ident[1] !== role)
    return `${role} không được ${verb} persona của vai \`${ident[1]}\``;

  if (!isWrite) return null; // đọc: phần còn lại của repo đều mở

  // --- ghi vào hạ tầng ---
  for (const [prefix, what] of FROZEN) {
    if (rel === prefix.replace(/\/$/, "") || rel.startsWith(prefix))
      return `${role} không được sửa ${what} (\`${prefix}\`) — chỉ principal`;
  }

  // --- self-escalation ---
  if (rel === `identity/${role}/loadout.yaml`)
    return `${role} không được tự sửa loadout.yaml của mình — xin principal`;
  if (rel.startsWith(`identity/${role}/.claude/`))
    return `${role} không được sửa settings.json của mình — sản phẩm của compile-acl.sh`;

  // --- ghi trong memory/: phải nằm trong write grant ---
  if (rel.startsWith("memory/")) {
    const memRel = rel.slice("memory/".length);
    if (memRel === "INDEX.md" || memRel === "README.md") return null;
    if (!matchesAny(memRel, grants.write))
      return `${role} không có quyền ghi \`memory/${memRel}\` (write grant: ${grants.write.join(", ")})`;
  }

  return null;
}

/** Kiểm quyền workspace ngoài repo. null = allow. */
function checkWorkspacePath(role, workspaces, absPath, isWrite) {
  const target = path.resolve(absPath);
  const readable = workspaces.read.some((root) => isWithin(root, target));
  if (!readable) return null; // workspace chưa đăng ký: để permission thường xử
  if (isWrite && !workspaces.write.some((root) => isWithin(root, target)))
    return `${role} chỉ có quyền đọc workspace \`${target}\``;
  return null;
}

function isWithin(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

module.exports = {
  findRepoRoot, parseYaml, globToRegExp, matchesAny,
  listRoles, loadoutPath, loadLoadout, sessionIdentity, effectiveGrants, effectiveWorkspaces,
  validate, checkPath, checkWorkspacePath, isWithin,
  KNOWN_TOOLS, REASONING_EFFORTS, FROZEN,
};

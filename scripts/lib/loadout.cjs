// loadout.cjs — lớp dùng chung cho compile-acl, hooks, doctor.
//
// Một parser YAML, một hàm khớp glob, một định nghĩa "vai này được đọc/ghi gì".
// Mọi nơi khác chỉ gọi vào đây. Đừng viết lại logic ACL ở chỗ thứ hai.

const fs = require("fs");
const os = require("os");
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
 *
 * Khi có `ALP_ROLE`, `fallbackFrom` đứng TRƯỚC cwd. `ALP_ROLE` chỉ do launcher đặt
 * (`alp`, `alp init`, `run-role`) ⇒ phiên đang ở trong một project, và repo alp-code là
 * chỗ hook nằm. Lấy cwd trước thì một project vô tình LÀ CLONE alp-code khác (dev clone)
 * sẽ được nhận nhầm làm nhà: clone đó không có `memory/` (gitignore), chưa compile ACL,
 * chưa trust. Hậu quả đo được: boot mất sạch `MEMORY INDEX` + `PROJECTS L0` mà không
 * cảnh báo, doctor phun ~50 dòng báo động giả, boot set phình 3 901 ký tự vượt ngân sách.
 */
function sessionIdentity(cwd, fallbackFrom, env = process.env) {
  const order = env.ALP_ROLE && fallbackFrom ? [fallbackFrom, cwd] : [cwd, fallbackFrom];
  const repoRoot = order.filter(Boolean).map(findRepoRoot).find(Boolean) || null;
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

/**
 * `~/x` → `<home>/x`. Chỉ `~` đứng đầu; `~user` không hỗ trợ — cố tình, `loadout.yaml`
 * phải đọc được bằng mắt trong 10 giây và home của user khác không phải thứ agent chạm.
 */
function untildify(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Chiều ngược lại — giữ `loadout.yaml` (file trong git) sạch path máy-cụ-thể. */
function tildify(p) {
  const abs = path.resolve(p);
  const rel = path.relative(os.homedir(), abs);
  if (rel === "") return "~";
  if (rel.startsWith("..") || path.isAbsolute(rel)) return abs; // ngoài home: đành tuyệt đối
  return "~/" + rel.split(path.sep).join("/");
}

/**
 * Workspace code ngoài repo alp-code. Trong `loadout.yaml` path viết dạng `~/...` để file
 * còn dùng chung được giữa các máy; ở đây expand ra tuyệt đối vì MỌI consumer — acl-guard,
 * settings.json, project-config, doctor, run-role — đều cần path thật. Một chỗ expand duy
 * nhất, đừng thêm chỗ thứ hai.
 */
function effectiveWorkspaces(loadout) {
  const ws = loadout.workspaces || {};
  const norm = (list) => [...new Set((list || []).map((p) => path.resolve(untildify(p))))];
  return { read: norm(ws.read), write: norm(ws.write) };
}

/**
 * Ghi lại khối `workspaces:` của một vai. `alp init` thêm cwd, `alp init --uninstall`
 * bỏ ra — hai chiều của cùng một phép sửa, nên chỉ có MỘT nơi biết cách viết khối này.
 * Trả về true nếu file thực sự đổi (idempotent: gọi lại với cùng input không ghi lại).
 */
function writeWorkspaces(repoRoot, role, read, write) {
  const file = loadoutPath(repoRoot, role);
  const text = fs.readFileSync(file, "utf8");
  // Ghi lại dạng `~/...`: `loadout.yaml` nằm trong git. Path tuyệt đối của một máy lọt lên
  // remote là rác cho mọi máy khác — và làm thẻ danh tính lúc boot nói sai workspace.
  const fmt = (list) => [...new Set(list.map(tildify))].join(", ");
  const block = `workspaces:\n  read:  [${fmt(read)}]\n  write: [${fmt(write)}]`;

  const next = /^workspaces:\s*$/m.test(text)
    ? text.replace(/^workspaces:\s*$\n(?:^[ \t]+.*(?:\n|$))*/m, block + "\n")
    : text.trimEnd() + "\n\n# --- workspace code ngoài alp-code (viết dạng `~/...`) ---\n" + block + "\n";

  if (next === text) return false;
  fs.writeFileSync(file, next);
  return true;
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

  // Path workspace neo vào gốc filesystem — hoặc tuyệt đối, hoặc `~/...` (xem `untildify`).
  // Relative thì neo vào cwd, mà cwd của agent không cố định ⇒ ACL sẽ khác nhau mỗi phiên.
  for (const p of [...wsRead, ...wsWrite]) {
    if (!path.isAbsolute(untildify(p)))
      add(`workspace \`${p}\` phải là path tuyệt đối hoặc bắt đầu bằng \`~/\``);
  }
  for (const w of wsWrite) {
    const absWrite = path.resolve(untildify(w));
    if (!wsRead.some((r) => isWithin(path.resolve(untildify(r)), absWrite)))
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

// ---------------------------------------------------------------- chống đệ quy

/** Vai này có được giao việc cho vai khác không? `delegates_to` là nguồn sự thật. */
function canDelegate(loadout) {
  return (loadout?.delegates_to || []).length > 0;
}

/** Lệnh spawn vai khác. Khớp theo TÊN LỆNH ở vị trí đầu, không theo chuỗi con. */
const DELEGATION_BINS = /^(herdr|run-role\.(cjs|sh|ps1))$/;
const WRAPPERS = /^(node|bash|sh|zsh|pwsh|powershell)$/;

/**
 * BẤT BIẾN CHARTER: vai phụ KHÔNG được spawn vai khác. Không có luật này thì Search
 * spawn được Search — vòng lặp đốt quota không phanh, và không ai ngồi giữa để cắt.
 *
 * Phải enforce Ở HOOK chứ không chỉ ở `permissions.deny`: luật `Bash(...)` khớp theo
 * TIỀN TỐ CHUỖI, không resolve lệnh, nên nó chặn không đáng tin (xem đầu acl-guard.cjs).
 *
 * Khớp theo tên lệnh ở vị trí đầu mỗi đoạn, có bóc tiền tố `VAR=x` và wrapper
 * (`node …/run-role.cjs`). Cố ý KHÔNG khớp chuỗi con: `grep herdr docs/` là lệnh đọc
 * hợp lệ, chặn nó chỉ dạy agent tìm đường vòng.
 *
 * Trả `null` nếu cho phép, hoặc chuỗi lý do nếu chặn.
 */
function checkDelegationCommand(role, mayDelegate, cmd) {
  if (mayDelegate) return null;

  for (const segment of String(cmd).split(/[;\n]|&&|\|\||\|/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i])) i++; // VAR=x prefix
    if (i >= words.length) continue;

    let head = unquote(words[i]);
    if (WRAPPERS.test(path.basename(head)) && words[i + 1]) head = unquote(words[i + 1]);
    const bin = path.basename(head);

    if (DELEGATION_BINS.test(bin))
      return `${role} không được spawn vai khác (\`${bin}\`) — chống đệ quy delegation, chỉ \`main\` giao việc`;
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
  writeWorkspaces, untildify, tildify,
  validate, checkPath, checkWorkspacePath, canDelegate, checkDelegationCommand, isWithin,
  KNOWN_TOOLS, REASONING_EFFORTS, FROZEN,
};

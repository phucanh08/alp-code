// claude-settings.cjs — loadout.yaml → object `.claude/settings.json` của Claude Code.
//
// Tách khỏi compile-acl.cjs vì có HAI nơi cần đúng bộ luật này:
//   - `identity/<role>/.claude/settings.json`      (compile-acl.cjs)
//   - `<project>/.claude/settings.local.json`      (lib/project-config.cjs, `alp init`)
// Sinh deny-list ở hai chỗ là cách chắc chắn nhất để một chỗ thiếu một dòng deny mà
// không ai biết — đúng thứ CHARTER §4 cấm. Một builder, hai người dùng.
//
// CÚ PHÁP PATH — đọc kỹ trước khi sửa file này:
//   Claude Code coi `/…` trong permission rule là path TƯƠNG ĐỐI so với thư mục chứa
//   settings.json. Absolute path phải viết HAI dấu gạch: `Read(//Users/…)`.
//   Sai một ký tự = ACL im lặng vô hiệu, không cảnh báo. Đã đo:
//   memory/shared/reference/claude-code-acl-behavior.md

const path = require("path");
const L = require("./loadout.cjs");

// Claude Code 2.1.238 chỉ nhận Read(path) cho mọi file-read tool và Edit(path)
// cho mọi file-write tool. Glob/Grep/Write/NotebookEdit(path) bị bỏ qua và in warning.
// Hook vẫn matcher từng tool; đây là cú pháp riêng của permissions.deny.
const WRITE_VERBS = ["Edit"];
const READ_VERBS = ["Read"];

/** Permission rule cho một absolute path, chuẩn hoá slash cả trên Windows. */
function absoluteRule(p, glob) {
  const normalized = path.resolve(p).split(path.sep).join("/").replace(/^\/+/, "");
  return "//" + normalized + (glob ? "/**" : "");
}

/** Thư mục agent được phép làm việc. Path thường, KHÔNG có `//`. */
function additionalDirectories(repoRoot, role, loadout) {
  const workspaces = L.effectiveWorkspaces(loadout);
  return [...new Set([
    path.join(repoRoot, "identity", "_shared"),
    // Không mở thư mục cha `memory/`: workspace settings có thể được dùng ngay cả
    // khi hook lỗi, nên quyền nền cũng phải theo least privilege. `deny` vẫn
    // enumerate private của các vai khác như lớp phòng thủ thứ hai.
    path.join(repoRoot, "memory", "shared"),
    path.join(repoRoot, "memory", "projects"),
    path.join(repoRoot, "memory", "private", role),
    path.join(repoRoot, "skills"),
    path.join(repoRoot, "docs"),
    ...workspaces.read,
  ])];
}

function denyRules(repoRoot, role, allRoles, loadout) {
  const rule = (p) => absoluteRule(path.join(repoRoot, p), false);
  const deny = [];
  const noRead = (p) => [...READ_VERBS, ...WRITE_VERBS].forEach((v) => deny.push(`${v}(${rule(p)})`));
  const noWrite = (p) => WRITE_VERBS.forEach((v) => deny.push(`${v}(${rule(p)})`));

  // 1. Kho riêng + persona của MỌI vai anh em — enumerate, không có cách nào khác.
  for (const other of allRoles) {
    if (other === role) continue;
    noRead(`memory/private/${other}/**`);
    noRead(`identity/${other}/**`);
  }

  // 2. Luật chung — đọc được, không sửa được.
  for (const [prefix] of L.FROZEN) {
    noWrite(prefix.endsWith("/") ? `${prefix}**` : prefix);
  }

  // 3. Self-escalation — quan trọng nhất.
  noWrite(`identity/${role}/loadout.yaml`);
  noWrite(`identity/${role}/.claude/**`);

  // Workspace chỉ-đọc: Edit(root/**) bao phủ Write/NotebookEdit. Nếu một grant
  // write nằm trong root đọc, hook xử lý phần hẹp vì deny cha sẽ thắng allow con.
  const ws = L.effectiveWorkspaces(loadout);
  for (const root of ws.read) {
    if (!ws.write.some((w) => L.isWithin(w, root) || L.isWithin(root, w)))
      deny.push(`Edit(${absoluteRule(root, true)})`);
  }

  // 4. Tool không được cấp trong loadout.
  const granted = new Set(loadout.tools || []);
  for (const t of L.KNOWN_TOOLS) if (!granted.has(t)) deny.push(t);

  // 5. Chống đệ quy: vai không có `delegates_to` thì không spawn được vai khác.
  //    Đây là lớp PHÒNG THỦ THỨ HAI — luật `Bash(...)` khớp theo tiền tố chuỗi nên chặn
  //    không đáng tin; lớp enforce thật là acl-guard (`checkDelegationCommand`).
  if (!L.canDelegate(loadout)) deny.push(...delegationRules(repoRoot));

  return deny;
}

/** Hai lệnh mở phiên vai khác. Dùng chung cho cả allow (main) lẫn deny (vai phụ). */
function delegationRules(repoRoot) {
  return [
    "Bash(herdr:*)",
    `Bash(node ${path.join(repoRoot, "scripts", "run-role.cjs")}:*)`,
  ];
}

const hookCmd = (repoRoot, f) => `node ${path.join(repoRoot, "hooks", f)}`;

function hooks(repoRoot) {
  return {
    SessionStart: [
      { hooks: [{ type: "command", command: hookCmd(repoRoot, "session-start.cjs") }] },
    ],
    PreToolUse: [
      {
        matcher: "Bash|Read|Edit|Write|NotebookEdit|Glob|Grep",
        hooks: [{ type: "command", command: hookCmd(repoRoot, "acl-guard.cjs") }],
      },
    ],
    Stop: [
      { hooks: [{ type: "command", command: hookCmd(repoRoot, "session-end.cjs") }] },
    ],
  };
}

/**
 * Object settings.json đầy đủ của một vai. Ném lỗi nếu loadout không hợp lệ —
 * fail đóng: settings sinh từ loadout hỏng còn tệ hơn không sinh.
 */
function buildSettings(repoRoot, role, allRoles, loadout) {
  const lo = loadout || L.loadLoadout(repoRoot, role);
  const errs = L.validate(lo, role, allRoles);
  if (errs.length) {
    const e = new Error(`loadout.yaml của \`${role}\` không hợp lệ`);
    e.issues = errs;
    throw e;
  }
  const rule = (p) => absoluteRule(path.join(repoRoot, p), false);

  return {
    $comment: [
      "GENERATED bởi scripts/compile-acl.sh từ loadout.yaml — KHÔNG SỬA TAY.",
      "Sửa identity/" + role + "/loadout.yaml rồi chạy: scripts/compile-acl.sh",
      "Absolute path trong permission rule dùng TIỀN TỐ HAI GẠCH `//` — xem",
      "memory/shared/reference/claude-code-acl-behavior.md phát hiện 1.",
    ].join(" "),
    $role: role,
    $grants: L.effectiveGrants(lo, role),
    $workspaces: L.effectiveWorkspaces(lo),
    permissions: {
      defaultMode: "default",
      additionalDirectories: additionalDirectories(repoRoot, role, lo),
      allow: [
        `Read(${rule("CHARTER.md")})`,
        `Read(${rule("README.md")})`,
        `Read(${rule("identity/REGISTRY.md")})`,
        // Vai điều phối tự quyết giao việc — hỏi permission mỗi lần thì "tự delegate"
        // chỉ là đổi chỗ cho principal gõ lệnh. Vai phụ nhận DENY cho đúng hai luật này.
        ...(L.canDelegate(lo) ? delegationRules(repoRoot) : []),
      ],
      deny: denyRules(repoRoot, role, allRoles, lo),
    },
    hooks: hooks(repoRoot),
  };
}

module.exports = { buildSettings, denyRules, delegationRules, additionalDirectories, absoluteRule, hooks };

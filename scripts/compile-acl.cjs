#!/usr/bin/env node
// compile-acl.cjs — sinh identity/<role>/.claude/settings.json từ loadout.yaml.
//
//   compile-acl.sh              = --all (mặc định)
//   compile-acl.sh --check      chỉ so sánh, exit 1 nếu lệch
//   compile-acl.sh <role>       một vai — CẢNH BÁO: settings vai khác sẽ thiếu deny
//
// VÌ SAO MẶC ĐỊNH LÀ --all: `deny` thắng `allow` trong Claude Code, nên không viết
// được luật "cấm private/**, trừ private/<mình>/**". Bắt buộc liệt kê từng vai anh em.
// Thêm một vai mà không recompile ⇒ settings của MỌI vai cũ thiếu một dòng deny ⇒ rò rỉ.
//
// CÚ PHÁP PATH — đọc kỹ trước khi sửa file này:
//   Claude Code coi `/…` trong permission rule là path TƯƠNG ĐỐI so với thư mục chứa
//   settings.json. Absolute path phải viết HAI dấu gạch: `Read(//Users/…)`.
//   Sai một ký tự = ACL im lặng vô hiệu, không cảnh báo. Đã đo:
//   memory/shared/reference/claude-code-acl-behavior.md

const fs = require("fs");
const path = require("path");
const L = require("./lib/loadout.cjs");

const repoRoot = L.findRepoRoot(__dirname);
if (!repoRoot) die("Không tìm thấy repo root (thư mục có CHARTER.md)");

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const targets = args.filter((a) => !a.startsWith("-"));

const allRoles = L.listRoles(repoRoot);
if (allRoles.length === 0) die("Không có vai nào trong identity/");

const roles = targets.length ? targets : allRoles;
for (const r of roles) {
  if (!allRoles.includes(r)) die(`Không có vai \`${r}\` trong identity/`);
}
if (targets.length && !checkOnly && targets.length < allRoles.length) {
  warn(`Chỉ compile ${targets.join(", ")} — settings của các vai còn lại sẽ THIẾU deny.`);
  warn("Chạy `compile-acl.sh` không tham số để recompile tất cả.");
}

// ---------------------------------------------------------------- sinh settings

/** Tiền tố `//` cho absolute path trong permission rule. */
const rule = (p) => absoluteRule(path.join(repoRoot, p), false);

/** Thư mục agent được phép làm việc. Path thường, KHÔNG có `//`. */
function additionalDirectories(role) {
  const lo = L.loadLoadout(repoRoot, role);
  const workspaces = L.effectiveWorkspaces(lo);
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

// Claude Code 2.1.238 chỉ nhận Read(path) cho mọi file-read tool và Edit(path)
// cho mọi file-write tool. Glob/Grep/Write/NotebookEdit(path) bị bỏ qua và in warning.
// Hook vẫn matcher từng tool; đây là cú pháp riêng của permissions.deny.
const WRITE_VERBS = ["Edit"];
const READ_VERBS = ["Read"];

function denyRules(role) {
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
  const ws = L.effectiveWorkspaces(L.loadLoadout(repoRoot, role));
  for (const root of ws.read) {
    if (!ws.write.some((w) => L.isWithin(w, root) || L.isWithin(root, w)))
      deny.push(`Edit(${absoluteRule(root, true)})`);
  }

  // 4. Tool không được cấp trong loadout.
  const granted = new Set(L.loadLoadout(repoRoot, role).tools || []);
  for (const t of L.KNOWN_TOOLS) if (!granted.has(t)) deny.push(t);

  return deny;
}

function buildSettings(role) {
  const lo = L.loadLoadout(repoRoot, role);
  const errs = L.validate(lo, role, allRoles);
  if (errs.length) {
    errs.forEach((e) => console.error(`INVALID  ${e}`));
    die(`loadout.yaml của \`${role}\` không hợp lệ — sửa rồi chạy lại`);
  }
  const grants = L.effectiveGrants(lo, role);
  const workspaces = L.effectiveWorkspaces(lo);

  return {
    $comment: [
      "GENERATED bởi scripts/compile-acl.sh từ loadout.yaml — KHÔNG SỬA TAY.",
      "Sửa identity/" + role + "/loadout.yaml rồi chạy: scripts/compile-acl.sh",
      "Absolute path trong permission rule dùng TIỀN TỐ HAI GẠCH `//` — xem",
      "memory/shared/reference/claude-code-acl-behavior.md phát hiện 1.",
    ].join(" "),
    $role: role,
    $grants: grants,
    $workspaces: workspaces,
    permissions: {
      defaultMode: "default",
      additionalDirectories: additionalDirectories(role),
      allow: [
        `Read(${rule("CHARTER.md")})`,
        `Read(${rule("README.md")})`,
        `Read(${rule("identity/REGISTRY.md")})`,
      ],
      deny: denyRules(role),
    },
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: hookCmd("session-start.cjs") }] },
      ],
      PreToolUse: [
        {
          matcher: "Bash|Read|Edit|Write|NotebookEdit|Glob|Grep",
          hooks: [{ type: "command", command: hookCmd("acl-guard.cjs") }],
        },
      ],
      Stop: [
        { hooks: [{ type: "command", command: hookCmd("session-end.cjs") }] },
      ],
    },
  };
}

const hookCmd = (f) => `node ${path.join(repoRoot, "hooks", f)}`;

/** Permission rule cho một absolute path, chuẩn hoá slash cả trên Windows. */
function absoluteRule(p, glob) {
  const normalized = path.resolve(p).split(path.sep).join("/").replace(/^\/+/, "");
  return "//" + normalized + (glob ? "/**" : "");
}

// ---------------------------------------------------------------- ghi / so sánh

let drifted = 0;
for (const role of roles) {
  const outDir = path.join(repoRoot, "identity", role, ".claude");
  const outFile = path.join(outDir, "settings.json");
  const body = JSON.stringify(buildSettings(role), null, 2) + "\n";

  if (checkOnly) {
    const cur = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : null;
    if (cur !== body) {
      console.log(`ACL-DRIFT ${role} — settings.json lệch với loadout.yaml`);
      drifted++;
    }
    continue;
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, body);
  // Dấu thời gian để doctor.sh phát hiện loadout bị sửa sau lần compile cuối.
  fs.writeFileSync(
    path.join(outDir, ".acl-stamp"),
    JSON.stringify({
      compiledAt: new Date().toISOString(),
      repoRoot,
      loadoutMtime: fs.statSync(L.loadoutPath(repoRoot, role)).mtimeMs,
      roles: allRoles,
    }) + "\n"
  );
  console.log(`WROTE    identity/${role}/.claude/settings.json`);
}

if (checkOnly) {
  if (drifted) {
    console.log(`---\n${drifted} vai lệch. Chạy: scripts/compile-acl.sh`);
    process.exit(1);
  }
  console.log("OK       ACL khớp loadout.yaml ở mọi vai");
}

function warn(m) { console.error(`WARN     ${m}`); }
function die(m) { console.error(`ERROR    ${m}`); process.exit(2); }

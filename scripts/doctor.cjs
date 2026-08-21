#!/usr/bin/env node
// doctor.cjs — kiểm tra tính toàn vẹn của cả hệ. Gọi ở boot và trong heartbeat.
//
//   doctor.sh            in mọi thứ, kể cả dòng OK
//   doctor.sh --quiet    chỉ in khi CÓ tín hiệu (dùng trong hook)
//
// Exit: 0 sạch · 1 có tín hiệu cần xử lý · 2 lỗi cấu hình
//
// Project Layer (DRIFT/STALE/ORPHAN) giao cho sync-project-index.sh — đừng viết lại
// parser frontmatter ở đây.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const L = require("./lib/loadout.cjs");
const C = require("./lib/communication.cjs");

const quiet = process.argv.includes("--quiet");
const repoRoot = L.findRepoRoot(__dirname);
if (!repoRoot) {
  console.error("ERROR    không tìm thấy repo root (thư mục có CHARTER.md)");
  process.exit(2);
}

const signals = [];
const signal = (tag, msg) => signals.push(`${tag.padEnd(16)} ${msg}`);

const roles = L.listRoles(repoRoot);
if (!roles.length) {
  console.error("ERROR    không có vai nào trong identity/");
  process.exit(2);
}


// ---------------------------------------------------------------- Project Layer

function checkProjectLayer() {
  const script = path.join(repoRoot, "scripts", "sync-project-index.sh");
  if (!fs.existsSync(script)) return signal("MISSING", "thiếu scripts/sync-project-index.sh");
  for (const line of run(script, []).split("\n")) {
    if (/^(DRIFT|STALE|ORPHAN|MISSING|MISMATCH)/.test(line)) {
      const [tag, ...rest] = line.trim().split(/\s+/);
      signal(tag, rest.join(" "));
    }
  }
}

// ---------------------------------------------------------------- ACL

function checkAcl() {
  // ACL-DRIFT — settings.json không khớp thứ compile-acl sinh ra từ loadout.yaml.
  // So theo NỘI DUNG, không theo mtime: đổi `name:` không ảnh hưởng ACL nên
  // không được coi là drift (xem CHARTER §2.1 — key theo vai, không theo tên).
  const compile = path.join(repoRoot, "scripts", "compile-acl.sh");
  if (!fs.existsSync(compile)) return signal("MISSING", "thiếu scripts/compile-acl.sh");
  for (const line of run(compile, ["--check"]).split("\n")) {
    if (/^ACL-DRIFT/.test(line)) signal("ACL-DRIFT", line.replace(/^ACL-DRIFT\s*/, "") + " → chạy scripts/compile-acl.sh");
    if (/^INVALID/.test(line)) signal("ACL-INVALID", line.replace(/^INVALID\s*/, ""));
  }

  for (const role of roles) {
    const file = path.join(repoRoot, "identity", role, ".claude", "settings.json");
    if (!fs.existsSync(file)) {
      signal("ACL-MISSING", `${role} chưa có settings.json → chạy scripts/compile-acl.sh`);
      continue;
    }
    let settings;
    try {
      settings = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      signal("ACL-BROKEN", `${role} settings.json không parse được: ${e.message}`);
      continue;
    }
    const deny = settings.permissions?.deny || [];

    // ACL-STALE — có vai anh em mà settings vai này chưa có deny cho nó.
    for (const other of roles) {
      if (other === role) continue;
      if (!deny.some((d) => d.includes(`/memory/private/${other}/`)))
        signal("ACL-STALE", `${role} thiếu deny cho \`private/${other}/\` → chạy scripts/compile-acl.sh`);
    }

    // ACL-PATH — repo bị move, path tuyệt đối trong settings không còn đúng.
    const dirs = settings.permissions?.additionalDirectories || [];
    if (dirs.length && !dirs.every((d) => d.startsWith(repoRoot)))
      signal("ACL-PATH", `${role} settings.json trỏ tới repo root cũ → chạy scripts/compile-acl.sh`);

    // ACL-SYNTAX — absolute path trong permission rule phải có tiền tố `//`.
    // Sai một ký tự = ACL im lặng vô hiệu, không cảnh báo nào.
    const bad = [...deny, ...(settings.permissions?.allow || [])].filter((r) =>
      /^\w+\(\/[^/]/.test(r)
    );
    if (bad.length)
      signal("ACL-SYNTAX", `${role} có ${bad.length} luật absolute path thiếu tiền tố \`//\`: ${bad[0]}`);

    // Permission path rule chỉ hỗ trợ Read/Edit. Các tên tool khác nhìn hợp lý
    // nhưng Claude Code bỏ qua, khiến settings fail-open kèm warning lúc boot.
    const unsupportedPathRules = deny.filter((r) =>
      /^(Glob|Grep|Write|NotebookEdit)\(/.test(r)
    );
    if (unsupportedPathRules.length)
      signal(
        "ACL-SYNTAX",
        `${role} có ${unsupportedPathRules.length} path rule không được Claude Code hỗ trợ: ${unsupportedPathRules[0]}`
      );
  }
}

// ---------------------------------------------------------------- REGISTRY

function checkRegistry() {
  const file = path.join(repoRoot, "identity", "REGISTRY.md");
  if (!fs.existsSync(file)) return signal("MISSING", "thiếu identity/REGISTRY.md");
  const text = fs.readFileSync(file, "utf8");

  const listed = [...text.matchAll(/^\|\s*([a-z0-9][a-z0-9-]*)\s*\|/gm)].map((m) => m[1]);
  for (const role of roles)
    if (!listed.includes(role))
      signal("REGISTRY-DRIFT", `vai \`${role}\` có thư mục nhưng không có dòng trong REGISTRY.md`);
  for (const l of listed)
    if (!roles.includes(l))
      signal("REGISTRY-DRIFT", `REGISTRY.md liệt kê \`${l}\` nhưng không có identity/${l}/`);

  // Tên hiển thị phải khớp loadout.yaml — REGISTRY là bảng phái sinh.
  for (const role of roles) {
    const lo = L.loadLoadout(repoRoot, role);
    if (!lo) continue;
    const row = text.match(new RegExp(`^\\|\\s*${escapeRe(role)}\\s*\\|(.*)$`, "m"));
    if (!row) continue;
    const cells = row[1].split("|").map((c) => c.trim());
    if (lo.name && cells[0] !== lo.name)
      signal("REGISTRY-DRIFT", `\`${role}\` tên trong REGISTRY.md (\`${cells[0]}\`) không khớp \`name: ${lo.name}\``);
    if (lo.reports_to && cells[3] !== lo.reports_to)
      signal("REGISTRY-DRIFT", `\`${role}\` cột "Báo cáo cho" (\`${cells[3]}\`) không khớp \`reports_to: ${lo.reports_to}\``);
  }
}

// ---------------------------------------------------------------- COMMUNICATION

function checkCommunication() {
  for (const issue of C.checkCommunicationTopology(
    repoRoot,
    roles,
    (role) => L.loadLoadout(repoRoot, role)
  )) signal(issue.tag, issue.msg);
}

// ---------------------------------------------------------------- bộ file vai

const REQUIRED = ["IDENTITY.md", "SOUL.md", "PLAYBOOK.md", "RELATIONS.md", "CLAUDE.md", "loadout.yaml"];

function checkIdentityFiles() {
  for (const role of roles) {
    for (const f of REQUIRED) {
      if (!fs.existsSync(path.join(repoRoot, "identity", role, f)))
        signal("IDENTITY-MISSING", `${role} thiếu ${f}`);
    }
    const priv = path.join(repoRoot, "memory", "private", role);
    if (!fs.existsSync(priv)) signal("IDENTITY-MISSING", `${role} thiếu memory/private/${role}/`);

    const lo = L.loadLoadout(repoRoot, role);
    if (lo) for (const e of L.validate(lo, role, roles)) signal("ACL-INVALID", e);
    if (lo?.model?.startsWith("gpt-") && !fs.existsSync(path.join(repoRoot, "identity", role, "AGENTS.md")))
      signal("IDENTITY-MISSING", `${role} dùng Codex nhưng thiếu AGENTS.md`);

    // Placeholder chưa thay = vai được tạo tay, không qua new-role.sh.
    for (const f of REQUIRED) {
      const p = path.join(repoRoot, "identity", role, f);
      if (fs.existsSync(p) && /\{\{(ROLE|NAME|EMOJI|MODEL|DATE)\}\}/.test(fs.readFileSync(p, "utf8")))
        signal("TEMPLATE-LEFT", `${role}/${f} còn placeholder \`{{...}}\` chưa thay`);
    }
  }
}

// ---------------------------------------------------------------- trust

/**
 * TRUST-MISSING — workspace chưa được trust thì Claude Code BỎ QUA toàn bộ
 * `permissions.allow` và `additionalDirectories` của vai đó ⇒ agent không đọc được
 * memory/. `deny` vẫn áp dụng, nên hỏng theo kiểu "vai câm", không phải "vai hở".
 * Đã đo: memory/shared/reference/claude-code-acl-behavior.md phát hiện 2.
 */
function checkTrust() {
  const cfgPath = path.join(process.env.HOME || "", ".claude.json");
  if (!fs.existsSync(cfgPath)) {
    for (const role of roles)
      signal(
        "TRUST-MISSING",
        `${role} chưa trust → chạy scripts/trust-role.sh ${role}`
      );
    return;
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch {
    return signal("TRUST-UNKNOWN", "~/.claude.json không parse được — không kiểm được trust");
  }
  const projects = cfg.projects || {};
  for (const role of roles) {
    const dir = path.join(repoRoot, "identity", role);
    const variants = [dir, fs.existsSync(dir) ? fs.realpathSync(dir) : dir];
    if (!variants.some((d) => projects[d]?.hasTrustDialogAccepted))
      signal(
        "TRUST-MISSING",
        `${role} chưa trust → allow/additionalDirectories bị bỏ qua. Chạy \`cd identity/${role} && claude\` một lần rồi chấp nhận.`
      );
  }
}

// ---------------------------------------------------------------- tiện ích

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return (e.stdout || "") + (e.stderr || "");
  }
}

function main() {
  checkProjectLayer();
  checkAcl();
  checkRegistry();
  checkCommunication();
  checkIdentityFiles();
  checkTrust();

  if (signals.length) {
    console.log(signals.join("\n"));
    process.exit(1);
  }
  if (!quiet) console.log("OK               alp-code sạch — không có tín hiệu nào");
  process.exit(0);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

main();

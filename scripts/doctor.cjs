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
//
// MỖI TÍN HIỆU PHẢI CÓ DÒNG `→ fix:` CHẠY ĐƯỢC. "Nêu bệnh, không kê đơn" là cách chắc
// chắn nhất để cảnh báo bị bỏ qua: doctor chạy trong boot hook (`session-start.cjs`) nên
// Phở cũng đọc nó, và một tín hiệu không có lệnh sửa thì cả người lẫn agent đều lướt qua.
// `signal(tag, msg, fix)` — tham số thứ ba KHÔNG được để trống.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const L = require("./lib/loadout.cjs");
const C = require("./lib/communication.cjs");
const T = require("./lib/trust.cjs");
const PC = require("./lib/project-config.cjs");
const P = require("./lib/codex-profile.cjs");
const F = require("./lib/herdr-fleet.cjs");
const K = require("./lib/skill-links.cjs");

const quiet = process.argv.includes("--quiet");
const repoRoot = L.findRepoRoot(__dirname);
if (!repoRoot) {
  console.error("ERROR    không tìm thấy repo root (thư mục có CHARTER.md)");
  process.exit(2);
}

const signals = [];
const signal = (tag, msg, fix) => signals.push({ tag, msg, fix });

/** Lệnh sửa hay gặp — viết một lần, đừng chép chuỗi. */
const FIX = {
  compile: "node scripts/compile-acl.cjs",
  syncIndex: "scripts/sync-project-index.sh --write",
  trust: "node scripts/trust-role.cjs",
  init: (p) => `alp init ${p}`,
  loadout: (role) => `sửa identity/${role}/loadout.yaml rồi chạy node scripts/compile-acl.cjs`,
};

// REGISTRY.md là bảng PHÁI SINH từ loadout.yaml nhưng viết tay — không có script sinh lại,
// nên fix ở đây là một câu chỉ đường, không phải một lệnh.
const REGISTRY_FIX = "sửa identity/REGISTRY.md cho khớp loadout.yaml (bảng viết tay, không sinh ra)";

const roles = L.listRoles(repoRoot);
if (!roles.length) {
  console.error("ERROR    không có vai nào trong identity/");
  process.exit(2);
}


// ---------------------------------------------------------------- Project Layer

function checkProjectLayer() {
  const script = path.join(repoRoot, "scripts", "sync-project-index.sh");
  if (!fs.existsSync(script))
    return signal("MISSING", "thiếu scripts/sync-project-index.sh", "alp update");
  for (const line of run(script, []).split("\n")) {
    if (/^(DRIFT|STALE|ORPHAN|MISSING|MISMATCH)/.test(line)) {
      const [tag, ...rest] = line.trim().split(/\s+/);
      signal(tag, rest.join(" "), FIX.syncIndex);
    }
  }
}

// ---------------------------------------------------------------- ACL

function checkAcl() {
  // ACL-DRIFT — settings.json không khớp thứ compile-acl sinh ra từ loadout.yaml.
  // So theo NỘI DUNG, không theo mtime: đổi `name:` không ảnh hưởng ACL nên
  // không được coi là drift (xem CHARTER §2.1 — key theo vai, không theo tên).
  const compile = path.join(repoRoot, "scripts", "compile-acl.sh");
  if (!fs.existsSync(compile)) return signal("MISSING", "thiếu scripts/compile-acl.sh", "alp update");
  for (const line of run(compile, ["--check"]).split("\n")) {
    if (/^ACL-DRIFT/.test(line))
      signal("ACL-DRIFT", line.replace(/^ACL-DRIFT\s*/, ""), FIX.compile);
    if (/^INVALID/.test(line)) {
      const msg = line.replace(/^INVALID\s*/, "");
      signal("ACL-INVALID", msg, FIX.loadout(msg.split(":")[0].trim()));
    }
    // Profile Codex lệch/thiếu là hỏng IM LẶNG: `codex -p` bỏ qua profile không có và
    // chạy mặc định `workspace-write`. Phải kêu ở đây, không ai đi đọc ~/.codex bằng mắt.
    if (/^PROFILE-(DRIFT|MISSING)/.test(line))
      signal(`CODEX-PROFILE-${line.startsWith("PROFILE-MISSING") ? "MISSING" : "DRIFT"}`,
        line.replace(/^PROFILE-\w+\s*/, ""), FIX.compile);
  }

  for (const role of roles) {
    const file = path.join(repoRoot, "identity", role, ".claude", "settings.json");
    if (!fs.existsSync(file)) {
      signal("ACL-MISSING", `${role} chưa có settings.json`, FIX.compile);
      continue;
    }
    let settings;
    try {
      settings = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      signal("ACL-BROKEN", `${role} settings.json không parse được: ${e.message}`, FIX.compile);
      continue;
    }
    const deny = settings.permissions?.deny || [];

    // ACL-STALE — có vai anh em mà settings vai này chưa có deny cho nó.
    for (const other of roles) {
      if (other === role) continue;
      if (!deny.some((d) => d.includes(`/memory/private/${other}/`)))
        signal("ACL-STALE", `${role} thiếu deny cho \`private/${other}/\``, FIX.compile);
    }

    // ACL-PATH — repo bị move, path tuyệt đối trong settings không còn đúng.
    //
    // KHÔNG kiểm "mọi dir nằm trong repoRoot": workspace code hợp lệ nằm NGOÀI repo, nên
    // luật đó biến mỗi `alp init` thành 8 cảnh báo giả. Dir hợp lệ = trong repo HOẶC
    // trong một `workspaces.read` đã khai; còn lại mới là tàn dư của repo root cũ.
    const ws = L.effectiveWorkspaces(L.loadLoadout(repoRoot, role) || {});
    const strays = (settings.permissions?.additionalDirectories || []).filter(
      (d) => !L.isWithin(repoRoot, d) && !ws.read.some((r) => L.isWithin(r, d))
    );
    if (strays.length)
      signal(
        "ACL-PATH",
        `${role} settings.json trỏ tới thư mục không thuộc repo lẫn workspace nào: ${strays[0]}`,
        FIX.compile
      );

    // ACL-SYNTAX — absolute path trong permission rule phải có tiền tố `//`.
    // Sai một ký tự = ACL im lặng vô hiệu, không cảnh báo nào.
    const bad = [...deny, ...(settings.permissions?.allow || [])].filter((r) =>
      /^\w+\(\/[^/]/.test(r)
    );
    if (bad.length)
      signal("ACL-SYNTAX", `${role} có ${bad.length} luật absolute path thiếu tiền tố \`//\`: ${bad[0]}`, FIX.compile);

    // Permission path rule chỉ hỗ trợ Read/Edit. Các tên tool khác nhìn hợp lý
    // nhưng Claude Code bỏ qua, khiến settings fail-open kèm warning lúc boot.
    const unsupportedPathRules = deny.filter((r) =>
      /^(Glob|Grep|Write|NotebookEdit)\(/.test(r)
    );
    if (unsupportedPathRules.length)
      signal(
        "ACL-SYNTAX",
        `${role} có ${unsupportedPathRules.length} path rule không được Claude Code hỗ trợ: ${unsupportedPathRules[0]}`,
        FIX.compile
      );
  }
}

// ---------------------------------------------------------------- REGISTRY

function checkRegistry() {
  const file = path.join(repoRoot, "identity", "REGISTRY.md");
  if (!fs.existsSync(file))
    return signal("MISSING", "thiếu identity/REGISTRY.md", "alp update");
  const text = fs.readFileSync(file, "utf8");

  const listed = [...text.matchAll(/^\|\s*([a-z0-9][a-z0-9-]*)\s*\|/gm)].map((m) => m[1]);
  for (const role of roles)
    if (!listed.includes(role))
      signal("REGISTRY-DRIFT", `vai \`${role}\` có thư mục nhưng không có dòng trong REGISTRY.md`, REGISTRY_FIX);
  for (const l of listed)
    if (!roles.includes(l))
      signal("REGISTRY-DRIFT", `REGISTRY.md liệt kê \`${l}\` nhưng không có identity/${l}/`, REGISTRY_FIX);

  // Tên hiển thị phải khớp loadout.yaml — REGISTRY là bảng phái sinh.
  for (const role of roles) {
    const lo = L.loadLoadout(repoRoot, role);
    if (!lo) continue;
    const row = text.match(new RegExp(`^\\|\\s*${escapeRe(role)}\\s*\\|(.*)$`, "m"));
    if (!row) continue;
    const cells = row[1].split("|").map((c) => c.trim());
    if (lo.name && cells[0] !== lo.name)
      signal("REGISTRY-DRIFT", `\`${role}\` tên trong REGISTRY.md (\`${cells[0]}\`) không khớp \`name: ${lo.name}\``, REGISTRY_FIX);
    if (lo.reports_to && cells[3] !== lo.reports_to)
      signal("REGISTRY-DRIFT", `\`${role}\` cột "Báo cáo cho" (\`${cells[3]}\`) không khớp \`reports_to: ${lo.reports_to}\``, REGISTRY_FIX);
  }
}

// ---------------------------------------------------------------- COMMUNICATION

function checkCommunication() {
  for (const issue of C.checkCommunicationTopology(
    repoRoot,
    roles,
    (role) => L.loadLoadout(repoRoot, role)
  )) signal(issue.tag, issue.msg, issue.fix);
}

// ---------------------------------------------------------------- bộ file vai

const REQUIRED = ["IDENTITY.md", "SOUL.md", "PLAYBOOK.md", "RELATIONS.md", "CLAUDE.md", "loadout.yaml"];

function checkIdentityFiles() {
  for (const role of roles) {
    for (const f of REQUIRED) {
      if (!fs.existsSync(path.join(repoRoot, "identity", role, f)))
        signal("IDENTITY-MISSING", `${role} thiếu ${f}`,
          `chép identity/_template/${f} vào identity/${role}/ rồi thay placeholder`);
    }
    const priv = path.join(repoRoot, "memory", "private", role);
    if (!fs.existsSync(priv))
      signal("IDENTITY-MISSING", `${role} thiếu memory/private/${role}/`, `mkdir -p memory/private/${role}`);

    const lo = L.loadLoadout(repoRoot, role);
    if (lo) for (const e of L.validate(lo, role, roles, K.availableSkills(repoRoot)))
      signal("ACL-INVALID", e, FIX.loadout(role));
    // Link skill lệch loadout = vai boot lên thiếu đúng thứ PLAYBOOK bảo nó dùng, mà không
    // báo gì. Cùng hạng với ACL-DRIFT nên cùng chỗ sửa.
    if (lo) for (const e of K.checkSkillLinks(repoRoot, role, lo))
      signal("SKILL-DRIFT", `${role}: ${e}`, FIX.loadout(role));
    // Vai chạy Codex cần AGENTS.md (Codex đọc file đó, không đọc CLAUDE.md).
    // Xét CẢ `codex_model` — main khai `model: claude-opus-5` cho runtime chính nhưng vẫn
    // có đường phụ Codex, và chỉ soi `model` thì bỏ lọt đúng vai đó.
    const codexModel = lo?.codex_model || lo?.model;
    if (codexModel?.startsWith("gpt-") && !fs.existsSync(path.join(repoRoot, "identity", role, "AGENTS.md")))
      signal("IDENTITY-MISSING", `${role} dùng Codex nhưng thiếu AGENTS.md`,
        `chép identity/_template/AGENTS.md vào identity/${role}/ rồi thay placeholder`);

    // Placeholder chưa thay = vai được tạo tay, không qua new-role.sh.
    for (const f of REQUIRED) {
      const p = path.join(repoRoot, "identity", role, f);
      if (fs.existsSync(p) && /\{\{(ROLE|NAME|EMOJI|MODEL|DATE)\}\}/.test(fs.readFileSync(p, "utf8")))
        signal("TEMPLATE-LEFT", `${role}/${f} còn placeholder \`{{...}}\` chưa thay`,
          `thay \`{{...}}\` trong identity/${role}/${f} bằng giá trị thật`);
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
  let projects = null;

  if (fs.existsSync(cfgPath)) {
    try {
      projects = (JSON.parse(fs.readFileSync(cfgPath, "utf8")).projects) || {};
    } catch {
      return signal("TRUST-UNKNOWN", "~/.claude.json không parse được — không kiểm được trust",
        "sửa hoặc xoá ~/.claude.json (Claude Code sinh lại), rồi chạy node scripts/trust-role.cjs");
    }
  }

  const missing = roles.filter((role) => {
    if (!projects) return true;
    const dir = path.join(repoRoot, "identity", role);
    const variants = [dir, fs.existsSync(dir) ? fs.realpathSync(dir) : dir];
    return !variants.some((d) => projects[d]?.hasTrustDialogAccepted);
  });
  if (!missing.length) return;

  // MỘT dòng, không phải một dòng mỗi vai. doctor chạy trong boot hook
  // (`session-start.cjs:runDoctor`) nên mỗi dòng lặp lại là ngân sách boot bị đốt —
  // 8 vai chưa trust từng ngốn ~1000 ký tự để nói đúng một điều.
  signal(
    "TRUST-MISSING",
    `${missing.length} vai chưa trust (${missing.join(", ")}) → allow/additionalDirectories bị bỏ qua`,
    `${FIX.trust}   # không tham số = mọi vai`
  );
}

// ---------------------------------------------------------------- project đã đăng ký

/** Mọi workspace đã khai trong loadout của bất kỳ vai nào, path tuyệt đối, không trùng. */
function registeredProjects() {
  const out = new Set();
  for (const role of roles) {
    const ws = L.effectiveWorkspaces(L.loadLoadout(repoRoot, role) || {});
    for (const p of [...ws.read, ...ws.write]) out.add(p);
  }
  return [...out].sort();
}

/**
 * Project đã đăng ký nhưng config cục bộ lệch hoặc chưa trust cho Codex.
 *
 * Cả hai đều hỏng CÂM: Codex chưa trust thì bỏ qua hook của `.codex/config.toml` — vai mở
 * được phiên mà không có danh tính, không lỗi nào nổ ra. Còn settings.local.json lệch
 * loadout thì ACL của project là bản CŨ: thêm vai mới xong, phiên trong project đó vẫn
 * thiếu deny cho vai đó.
 *
 * So theo NỘI DUNG chứ không theo mtime — cùng lý do như ACL-DRIFT: sửa `name:` trong
 * loadout không đổi ACL, và một cảnh báo luôn đỏ là một cảnh báo không ai đọc.
 */
function checkRegisteredProjects() {
  const role = roles.includes("main") ? "main" : roles[0];
  const lo = L.loadLoadout(repoRoot, role);
  if (!lo) return;

  for (const project of registeredProjects()) {
    if (!fs.existsSync(project)) continue; // sync-project-index đã lo phần "biến mất"

    if (!T.isTrustedCodex(project))
      signal(
        "TRUST-MISSING-CODEX",
        `${project} đã đăng ký nhưng thiếu trust_level="trusted" trong ~/.codex/config.toml ` +
          "→ Codex BỎ QUA hook của project, vai vào việc không có danh tính",
        FIX.init(project)
      );

    const files = PC.paths(project);
    const want = {
      [files.claude]: JSON.stringify(PC.claudeSettings(repoRoot, role, project, roles, lo), null, 2) + "\n",
      [files.codex]: PC.codexConfig(repoRoot, role, project, lo),
    };
    for (const [file, body] of Object.entries(want)) {
      // File không có, hoặc là file của người ta (không mang dấu `alp init`): không phải
      // việc của doctor. `alp init` chưa chạy ở project đó là lựa chọn, không phải lỗi.
      if (!PC.isGenerated(file)) continue;
      if (fs.readFileSync(file, "utf8") !== body)
        signal(
          "PROJECT-CONFIG-STALE",
          `${file} lệch với identity/${role}/loadout.yaml`,
          FIX.init(project)
        );
    }
  }
}

// ---------------------------------------------------------------- fleet herdr

/**
 * Không có fleet KHÔNG phải tín hiệu — phiên headless là bình thường và launcher tự rơi
 * về `--exec`. Chỉ kêu khi fleet CÓ mà lệch bản, hoặc có pane mồ côi.
 */
function checkHerdr() {
  const fleet = F.available();
  if (!fleet.ok) return;

  if (fleet.version !== F.VERIFIED_VERSION)
    signal(
      "HERDR-VERSION",
      `herdr ${fleet.version} ≠ bản đã kiểm chứng ${F.VERIFIED_VERSION} — CLI đổi giữa các minor ` +
        "(0.7→0.8 xoá cả nhóm `wait`), lệnh trong lib/skill có thể không còn đúng",
      "đọc `herdr <nhóm> --help`, sửa scripts/lib/herdr-fleet.cjs + skills/herdr/SKILL.md rồi cập nhật VERIFIED_VERSION"
    );

  let orphans = [];
  try {
    orphans = F.orphanPanes();
  } catch {
    return; // fleet vừa tắt giữa chừng — không phải bệnh của hệ này
  }
  for (const o of orphans) {
    // Nhãn do launcher đặt là `<role>-<hậu tố>`; lấy lại vai để in đúng lệnh chạy được.
    const role = roles.find((r) => String(o.agent || "").startsWith(r + "-")) || "main";
    signal(
      "ORPHAN-PANE",
      `pane ${o.pane} (${o.agent}) còn báo \`${o.status}\` nhưng tiến trình đã chết`,
      `node scripts/run-role.cjs ${role} --release ${o.pane}`
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
  checkRegisteredProjects();
  checkHerdr();

  if (signals.length) {
    console.log(signals.map(render).join("\n"));
    process.exit(1);
  }
  if (!quiet) console.log("OK               alp-code sạch — không có tín hiệu nào");
  process.exit(0);
}

/**
 * Một tín hiệu = hai dòng: bệnh, rồi đơn thuốc thụt vào cho khớp cột.
 * Tín hiệu không có `fix` là bug của doctor, không phải trường hợp hợp lệ — nói thẳng ra
 * thay vì im lặng in một dòng cụt.
 */
function render({ tag, msg, fix }) {
  const line = `${tag.padEnd(16)} ${msg}`;
  return fix
    ? `${line}\n${" ".repeat(16)} → fix: ${fix}`
    : `${line}\n${" ".repeat(16)} → fix: (thiếu — doctor.cjs quên tham số thứ ba của signal())`;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

main();

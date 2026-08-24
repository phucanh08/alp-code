#!/usr/bin/env node
// session-start.cjs — nạp identity của vai vào context ngay khi mở phiên.
//
// Đường chính. `identity/<role>/CLAUDE.md` chỉ là fallback ~10 dòng.
//
// FAIL-SAFE: hook lỗi → exit 0 với additionalContext rỗng + cảnh báo lên systemMessage.
// Hook chết KHÔNG được làm chết phiên. (Ngược với acl-guard.cjs — fail-closed.)
//
// NGÂN SÁCH: ≤ BOOT_BUDGET ký tự (~4k token). Vượt thì cảnh báo, không cắt —
// cắt thầm lặng nguy hiểm hơn: agent tưởng mình đã đọc đủ.

const fs = require("fs");
const path = require("path");
const L = require(path.join(__dirname, "..", "scripts", "lib", "loadout.cjs"));

// Ngân sách boot. CHARTER §2.6 đặt mục tiêu ~4k token; tiếng Việt có dấu tốn khoảng
// 3.5 ký tự/token. Ngưỡng theo KÝ TỰ vì hook không có tokenizer và không được phép gọi mạng.
//
// 14000 ký tự ≈ 4k token. Boot set phải được rút gọn để giữ ngưỡng này có ý nghĩa;
// không nới ngân sách cho vừa hiện trạng.
//
// Vượt ngưỡng thì CẢNH BÁO chứ không cắt: cắt thầm lặng nguy hiểm hơn nhiều —
// agent tưởng mình đã đọc đủ trong khi thiếu mất nửa bộ luật.
const BOOT_BUDGET = 14000;

if (require.main === module) main();

function main() {
  const warnings = [];
  let context = "";

  try {
    context = buildContext(warnings);
  } catch (e) {
    warnings.push(`session-start.cjs lỗi: ${e.message} — identity CHƯA được nạp. Đọc thủ công theo CLAUDE.md.`);
  }

  if (context.length > BOOT_BUDGET) {
    warnings.push(
      `BOOT SET QUÁ TO: ${context.length} ký tự > ngưỡng ${BOOT_BUDGET} (~4k token). ` +
        "Rút gọn SOUL/PLAYBOOK/HOUSE-RULES hoặc đẩy chi tiết xuống tầng dưới."
    );
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: context,
      },
      systemMessage: warnings.length ? warnings.map((w) => `⚠️  ${w}`).join("\n") : undefined,
    })
  );
  process.exit(0);
}

// ---------------------------------------------------------------- boot set

function buildContext(warnings, options = {}) {
  const cwd = options.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const ident = options.repoRoot && options.role
    ? { repoRoot: options.repoRoot, role: options.role }
    : L.sessionIdentity(cwd, __dirname);
  if (!ident) throw new Error("không tìm thấy repo root (thư mục có CHARTER.md)");
  const { repoRoot, role } = ident;

  const loadout = L.loadLoadout(repoRoot, role);
  if (!loadout) throw new Error(`không có identity/${role}/loadout.yaml`);

  const grants = L.effectiveGrants(loadout, role);
  const workspaces = L.effectiveWorkspaces(loadout);
  const roleDir = path.join(repoRoot, "identity", role);
  const sharedDir = path.join(repoRoot, "identity", "_shared");

  const parts = [];
  const push = (title, body) => body && parts.push(`## ${title}\n\n${body.trim()}`);

  parts.push(
    [
      "# BOOT — danh tính phiên này",
      "",
      "Do hook `SessionStart` nạp tự động. Đây là bạn, không phải tài liệu tham khảo —",
      "đừng đọc lại các file này bằng tool.",
    ].join("\n")
  );

  push("Bạn là ai", identityCard(loadout, role, grants, workspaces, options.workspace));
  push("IDENTITY", read(path.join(roleDir, "IDENTITY.md"), warnings));
  push("VOICE + SOUL", joinDocs([
    ["VOICE (chung mọi vai)", read(path.join(sharedDir, "VOICE.md"), warnings)],
    ["SOUL", read(path.join(roleDir, "SOUL.md"), warnings)],
  ]));
  // Một nhóm vận hành: luật chung → quy trình riêng → định tuyến quan hệ.
  push("HOUSE-RULES + PLAYBOOK + RELATIONS", joinDocs([
    ["HOUSE-RULES (chung mọi vai)", read(path.join(sharedDir, "HOUSE-RULES.md"), warnings)],
    ["PLAYBOOK", read(path.join(roleDir, "PLAYBOOK.md"), warnings)],
    ["RELATIONS", read(path.join(roleDir, "RELATIONS.md"), warnings)],
  ]));
  push("PRINCIPAL", read(path.join(sharedDir, "PRINCIPAL.md"), warnings));
  push("MEMORY INDEX (đã lọc theo quyền của bạn)", stripDocHeader(filteredIndex(repoRoot, grants, warnings)));
  push("PROJECTS L0", stripDocHeader(read(
    path.join(repoRoot, "memory", "projects", "INDEX.md"), warnings,
    "chưa project nào đăng ký — `alp init <path>`"
  )));

  const signals = options.includeDoctor === false ? null : runDoctor(repoRoot);
  if (signals) warnings.push(`doctor.sh:\n${signals}`);

  return parts.join("\n\n---\n\n") + "\n";
}

/**
 * Context Builder của Delegation Core gọi hàm này trước backend. Backend chỉ nhận boot
 * context đã lọc theo loadout target; Paseo/Herdr không tự quyết identity hay memory.
 * Doctor bị bỏ ở đường này để không tạo vòng `context → doctor → backend health`.
 */
function buildContextForRole(repoRoot, role, options = {}) {
  const warnings = [];
  const context = buildContext(warnings, {
    repoRoot,
    role,
    includeDoctor: false,
    workspace: options.workspace,
  });
  if (!warnings.length) return context;
  return context + "\n---\n\n## BOOT WARNINGS\n\n" + warnings.map((w) => `- ${w}`).join("\n") + "\n";
}

/** Ghép các file cùng một nhóm boot mà vẫn giữ ranh giới nguồn rõ ràng. */
function joinDocs(docs) {
  return docs
    .filter(([, body]) => body)
    .map(([title, body]) => `### ${title}\n\n${body.trim()}`)
    .join("\n\n");
}

function identityCard(lo, role, grants, workspaces, activeWorkspace = null) {
  const rows = [
    ["Tên", lo.name],
    ["Vai", role],
    ["Emoji", lo.emoji],
    ["Delegation parent", lo.reports_to],
    ["Giao việc cho", (lo.delegates_to || []).join(", ") || "_(không ai)_"],
    ["Đọc được", grants.read.map((g) => `memory/${g}`).join(" · ")],
    ["Ghi được", grants.write.map((g) => `memory/${g}`).join(" · ") || "_(chỉ private của mình)_"],
    [
      activeWorkspace ? "Workspace execution" : "Workspace đọc",
      activeWorkspace || workspaces.read.join(" · ") || "_(chưa đăng ký)_",
    ],
    [
      "Workspace ghi",
      activeWorkspace
        ? workspaces.write.some((root) => L.isWithin(root, activeWorkspace)) ? activeWorkspace : "_(chỉ đọc)_"
        : workspaces.write.join(" · ") || "_(không có)_",
    ],
  ];
  return (
    rows.map(([k, v]) => `- **${k}:** ${v}`).join("\n") +
    skillRow(lo) +
    "\n\nĐó là toàn bộ quyền bạn có. Bị chặn thì báo cáo, **không** tìm đường vòng." +
    "\nCần thêm quyền → xin principal sửa `loadout.yaml`; chỉ principal sửa được."
  );
}

/**
 * Skill của vai. KHÔNG in đường dẫn: cả hai runtime đã tự inject `tên — mô tả — path` từ
 * thư mục link (`.claude/skills/` cho Claude, `.agents/skills/` cho Codex), in lại là thừa.
 *
 * Dòng này tồn tại vì lý do khác: **khẳng định cái gì KHÔNG phải của bạn.** Codex chen
 * thêm skill hệ thống của chính nó (`~/.codex/skills/.system/*` — skill-creator,
 * skill-installer, imagegen…) vào MỌI phiên, ngoài tầm với của loadout. Không có dòng này
 * thì vai không phân biệt được skill mình được cấp với skill lọt vào từ runtime.
 */
function skillRow(lo) {
  const skills = lo.skills || [];
  if (!skills.length)
    return "\n- **Skill:** _(không có)_ — thấy skill nào trong phiên cũng là của runtime, không phải của bạn";
  return (
    `\n- **Skill:** ${skills.map((s) => `\`${s}\``).join(" · ")}` +
    "\n  Đúng bấy nhiêu. Skill khác xuất hiện trong phiên là của runtime, **không** phải quyền của bạn."
  );
}

/**
 * Lọc memory/INDEX.md: bỏ mọi dòng có link trỏ ra ngoài `grants.read`.
 * Agent không được thấy cả TÊN file nó không được đọc — rò rỉ metadata cũng là rò rỉ.
 */
function filteredIndex(repoRoot, grants, warnings) {
  const file = path.join(repoRoot, "memory", "INDEX.md");
  if (!fs.existsSync(file)) {
    // Boot KHÔNG có mục lục trí nhớ mà im lặng thì hỏng nặng hơn boot thừa cảnh báo:
    // agent tưởng mình không có gì để nhớ. Cùng lý do với BOOT_BUDGET — không cắt thầm.
    warnings.push(`thiếu ${file} — phiên này boot KHÔNG có mục lục trí nhớ`);
    return null;
  }

  const linkRe = /\]\(([^)]+)\)/g;
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => {
      const targets = [...line.matchAll(linkRe)].map((m) => m[1]);
      if (!targets.length) return true;
      return targets.every((t) => {
        if (/^(https?:|#)/.test(t)) return true;
        const norm = t.replace(/^\.\//, "");
        // Link trong INDEX.md tính từ memory/ — cùng hệ quy chiếu với grants.
        if (norm === "INDEX.md" || norm === "README.md") return true;
        return L.matchesAny(norm, grants.read);
      });
    })
    .join("\n");
}

/**
 * Bỏ khối blockquote mở đầu của file index.
 * Đó là hướng dẫn cho người BẢO TRÌ file (quy ước ghi, phạm vi, cách sinh lại) —
 * không phải bối cảnh agent cần ở bước boot. Luật ghi đã nằm ở skill `agent-memory`.
 */
function stripDocHeader(text) {
  if (!text) return text;
  const lines = text.split("\n");
  const out = [];
  let inHeader = false;
  for (const line of lines) {
    if (line.startsWith("> ") || line === ">") { inHeader = true; continue; }
    if (inHeader && line.trim() === "") { inHeader = false; continue; }
    out.push(line);
  }
  return out.join("\n");
}

function runDoctor(repoRoot) {
  try {
    const out = require("child_process")
      .execFileSync(path.join(repoRoot, "scripts", "doctor.sh"), ["--quiet"], {
        encoding: "utf8",
        timeout: 15000,
        stdio: ["ignore", "pipe", "pipe"],
      })
      .trim();
    return out || null;
  } catch (e) {
    // doctor exit 1 = có tín hiệu, không phải lỗi.
    const out = (e.stdout || "").trim();
    return out || null;
  }
}

/** `note` mặc định hợp cho file persona; file khác truyền note riêng. */
function read(file, warnings, note = "vai này chưa đủ bộ file") {
  if (!fs.existsSync(file)) {
    // Path ĐẦY ĐỦ, không phải basename: khi hook nhận nhầm repo, "thiếu INDEX.md" không
    // nói được là thiếu ở repo nào — đó chính là thứ làm chẩn đoán mất thời gian.
    warnings.push(`thiếu ${file} — ${note}`);
    return null;
  }
  return fs.readFileSync(file, "utf8");
}

module.exports = { BOOT_BUDGET, buildContext, buildContextForRole, filteredIndex, identityCard };

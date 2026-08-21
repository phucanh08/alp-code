#!/usr/bin/env node
// GIỚI HẠN: đây là guardrail, KHÔNG phải sandbox.
// Chặn nhầm lẫn và vượt quyền tình cờ. KHÔNG chặn được agent cố tình lách
// (indirection lạ, ngôn ngữ script khác, ghi rồi chạy file).
// Cách ly thật với agent thù địch cần OS user riêng hoặc container.
//
// VÌ SAO HOOK NÀY LÀ LỚP ENFORCE CHÍNH:
//   `permissions.deny` chỉ hiểu tool file (Read/Edit/Write/Glob/Grep). Không luật
//   `Bash(...)` nào chặn nổi `cat <path>` một cách đáng tin — pattern khớp theo prefix
//   chuỗi lệnh, không resolve path. Bash là lỗ hổng duy nhất, và nó đủ để phá cách ly.
//   Hook thì fire ở MỌI permission mode, kể cả bypassPermissions. Đã đo:
//   memory/shared/reference/claude-code-acl-behavior.md
//
// Hook này FAIL-CLOSED: lỗi bất ngờ → deny kèm lý do. Ngược với session-start.cjs
// (fail-safe). Lý do: hook chết mà mở toang thì Bash lách được toàn bộ ACL.

const fs = require("fs");
const path = require("path");
const L = require(path.join(__dirname, "..", "scripts", "lib", "loadout.cjs"));

const FILE_TOOLS = new Set(["Read", "Edit", "Write", "NotebookEdit", "Glob", "Grep"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

/** Lệnh có indirection ⇒ không kiểm được path ⇒ default-deny. */
const INDIRECTION =
  /(^|[^\w])eval[^\w]|`|\$\(|\bbase64\b|\bxxd\b|\bsh\s+-c\b|\bbash\s+-c\b|\bzsh\s+-c\b|\bpython3?\s+-c\b|\bperl\s+-e\b|\bnode\s+-e\b|\bruby\s+-e\b|\bxargs\b/;

/** Dấu hiệu lệnh Bash có ý định GHI. Thiếu sót là chấp nhận được — read-check vẫn chạy. */
const WRITE_INTENT =
  /(>>?|\btee\b|\brm\b|\bmv\b|\bcp\b|\btouch\b|\bmkdir\b|\btruncate\b|\bdd\b|\bchmod\b|\bchown\b|\bln\b|\bsed\s+-i\b|\bpatch\b|\binstall\b)/;

main();

function main() {
  let payload;
  try {
    payload = JSON.parse(readStdin() || "{}");
  } catch (e) {
    return deny(`acl-guard không đọc được payload hook: ${e.message}`);
  }

  const tool = payload.tool_name || "";
  const input = payload.tool_input || {};
  const cwd = payload.cwd || process.cwd();

  let ctx;
  try {
    ctx = resolveContext(cwd);
  } catch (e) {
    return deny(`acl-guard không xác định được vai/quyền: ${e.message}`);
  }
  if (!ctx) return allow(); // ngoài repo alp-code — không phải việc của hook này

  try {
    const reason = FILE_TOOLS.has(tool)
      ? checkFileTool(ctx, tool, input)
      : tool === "Bash"
      ? checkBash(ctx, input)
      : null;
    return reason ? deny(reason) : allow();
  } catch (e) {
    return deny(`acl-guard lỗi khi kiểm tra (${tool}): ${e.message}`);
  }
}

// ---------------------------------------------------------------- bối cảnh

/**
 * { repoRoot, cwd, role, grants } — hoặc null khi không xác định được vai.
 *
 * Phiên delegation đứng ở repo NGƯỜI KHÁC: cwd không suy ra được vai lẫn repo root.
 * `sessionIdentity` lấy vai từ `ALP_ROLE` và repo root từ chỗ hook nằm — nhờ vậy ACL vẫn
 * hiệu lực với đường dẫn tuyệt đối trỏ ngược vào alp-code. Không có `ALP_ROLE` mà cũng
 * ngoài repo thì mới buông (phiên đó không phải của hệ này).
 */
function resolveContext(cwd) {
  const ident = L.sessionIdentity(cwd, process.env.ALP_ROLE ? __dirname : null);
  if (!ident) return null;
  const { repoRoot, role } = ident;

  const loadout = L.loadLoadout(repoRoot, role);
  if (!loadout) {
    throw new Error(
      `không có identity/${role}/loadout.yaml — phiên phải chạy với CWD = identity/<role>/`
    );
  }
  return {
    repoRoot,
    cwd,
    role,
    grants: L.effectiveGrants(loadout, role),
    workspaces: L.effectiveWorkspaces(loadout),
  };
}

// ---------------------------------------------------------------- tool file

function checkFileTool(ctx, tool, input) {
  const isWrite = WRITE_TOOLS.has(tool);
  const candidates = [
    input.file_path,
    input.notebook_path,
    input.path,
    // Glob/Grep: `path` là thư mục gốc, `pattern` có thể chứa đường dẫn
    typeof input.pattern === "string" && input.pattern.includes("/") ? input.pattern : null,
  ].filter(Boolean);

  for (const c of candidates) {
    const abs = resolveAbs(c, ctx.cwd);
    const reason =
      L.checkPath(ctx.repoRoot, ctx.role, ctx.grants, abs, isWrite) ||
      L.checkWorkspacePath(ctx.role, ctx.workspaces, abs, isWrite);
    if (reason) return reason;
  }
  return null;
}

// ---------------------------------------------------------------- Bash

function checkBash(ctx, input) {
  const cmd = String(input.command || "");
  if (!cmd.trim()) return null;

  if (INDIRECTION.test(cmd)) {
    return (
      `${ctx.role}: lệnh có indirection (eval / $() / backtick / -c / base64 / xargs) — ` +
      "acl-guard không kiểm được path bên trong nên từ chối. Viết lại lệnh tường minh."
    );
  }

  const isWrite = WRITE_INTENT.test(cmd);
  for (const token of pathTokens(cmd)) {
    const abs = resolveAbs(token, ctx.cwd);
    // Lệnh Bash luôn kiểm quyền ĐỌC; kiểm thêm quyền GHI khi lệnh có dấu hiệu ghi.
    const reason =
      L.checkPath(ctx.repoRoot, ctx.role, ctx.grants, abs, false) ||
      L.checkWorkspacePath(ctx.role, ctx.workspaces, abs, false) ||
      (isWrite
        ? L.checkPath(ctx.repoRoot, ctx.role, ctx.grants, abs, true) ||
          L.checkWorkspacePath(ctx.role, ctx.workspaces, abs, true)
        : null);
    if (reason) return `${reason} (qua Bash: \`${token}\`)`;
  }
  return null;
}

/** Token trông giống đường dẫn: có `/`, hoặc mở đầu bằng `.` / `~`. */
function pathTokens(cmd) {
  return cmd
    .split(/[\s;|&]+/)
    .map((t) => t.replace(/^['"]+|['"]+$/g, "").replace(/[,:]+$/, ""))
    .filter((t) => t && !t.startsWith("-"))
    .filter((t) => t.includes("/") || t.startsWith(".") || t.startsWith("~"));
}

// ---------------------------------------------------------------- path

/**
 * Tuyệt đối hoá + realpath để chống symlink.
 * Gốc là CWD CỦA PHIÊN, không phải repo root — path tương đối trong lệnh Bash
 * (`../../memory/...`) tính từ chỗ agent đang đứng. Lấy nhầm gốc = ACL lọt.
 * File chưa tồn tại → realpath thư mục cha rồi ghép tên (trường hợp Write file mới).
 */
function resolveAbs(p, base) {
  let raw = p.startsWith("~") ? path.join(process.env.HOME || "", p.slice(1)) : p;
  const abs = path.resolve(base, raw);
  try {
    return fs.realpathSync(abs);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
    } catch {
      return abs;
    }
  }
}

// ---------------------------------------------------------------- I/O

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function allow() {
  process.exit(0); // không quyết định — để flow permission thường chạy
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `[acl-guard] ${reason}`,
      },
    })
  );
  process.exit(0);
}

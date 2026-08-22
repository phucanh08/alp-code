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

/**
 * Dấu hiệu lệnh Bash có ý định GHI. Thiếu sót là chấp nhận được — read-check vẫn chạy.
 *
 * Hai bẫy đã đo được, đừng gỡ:
 *  - `(?<!&)>>?(?!&)` — `2>&1` và `>&2` là NHÂN BẢN FD, không ghi file. `>` trần bắt cả
 *    chúng ⇒ mọi lệnh có `2>&1` bị write-check TOÀN BỘ token, kể cả `./scripts/doctor.sh`.
 *    `&>file` vẫn phải bắt nên để riêng một nhánh. `1>file` vẫn bắt được.
 *  - `install` phải đứng riêng như một lệnh: `\binstall\b` khớp cả trong đường dẫn
 *    `scripts/install-project.cjs` (dấu `-` là ranh giới từ) ⇒ đọc file đó cũng bị chặn.
 */
const WRITE_INTENT =
  /(&>|(?<!&)>>?(?!&)|\btee\b|\brm\b|\bmv\b|\bcp\b|\btouch\b|\bmkdir\b|\btruncate\b|\bdd\b|\bchmod\b|\bchown\b|\bln\b|\bsed\s+-i\b|\bpatch\b|(?:^|[\s;|&])install(?=[\s;|&]|$))/;

/**
 * Thư mục mà PHIÊN NÀY chỉ được đọc, do launcher truyền vào (`alp` không tham số, và
 * `alp init` với project chưa nằm trong `workspaces`).
 *
 * VÌ SAO KHÔNG DÙNG `permissions.deny` CHO ĐỦ: path rule chỉ chặn được tool file.
 * Bash thì không luật `Bash(...)` nào chặn nổi `echo x > file` một cách đáng tin — mà
 * Bash mới là lỗ hổng thật (xem đầu file). Không có biến này thì "phiên read-only"
 * đúng với Edit và sai với Bash, tức là sai.
 *
 * Đọc một lần lúc nạp module: hook là process ngắn, env không đổi giữa chừng.
 */
const READONLY_DIRS = (process.env.ALP_READONLY_DIRS || "")
  .split(path.delimiter)
  .filter(Boolean)
  .map((p) => path.resolve(p));

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

  // Luật chỉ-đọc theo PHIÊN, kiểm trước khi cần biết vai: `alp` chạy ở repo bất kỳ nên
  // ctx có thể là null (ngoài alp-code), mà luật vẫn phải có hiệu lực ở đó.
  const readonly = checkReadonlyDirs(tool, input, cwd);
  if (readonly) return deny(readonly);

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
    // Vai phụ không được spawn vai khác — quyền này đọc từ `delegates_to`, không phải
    // một khoá riêng có thể lệch với nó.
    mayDelegate: L.canDelegate(loadout),
  };
}

// ---------------------------------------------------------------- tool file

function checkFileTool(ctx, tool, input) {
  const isWrite = WRITE_TOOLS.has(tool);

  for (const c of fileCandidates(input)) {
    const abs = resolveAbs(c, ctx.cwd);
    const reason =
      L.checkPath(ctx.repoRoot, ctx.role, ctx.grants, abs, isWrite) ||
      L.checkWorkspacePath(ctx.role, ctx.workspaces, abs, isWrite);
    if (reason) return reason;
  }
  return null;
}

/** Path mà một tool file đụng tới. Glob/Grep: `path` là gốc, `pattern` có thể chứa path. */
function fileCandidates(input) {
  return [
    input.file_path,
    input.notebook_path,
    input.path,
    typeof input.pattern === "string" && input.pattern.includes("/") ? input.pattern : null,
  ].filter(Boolean);
}

// ---------------------------------------------------------------- phiên chỉ-đọc

/**
 * Chặn mọi ý định GHI vào thư mục mà phiên này chỉ được đọc. `null` = không liên quan.
 *
 * Với Bash chỉ bắt được hai dạng mục tiêu: token trông giống path, và đích của `>`/`>>`.
 * Nói thẳng phần thiếu: `cd`-rồi-ghi bằng tên trần trong lệnh khác vẫn lọt. Đây là
 * guardrail, không phải sandbox (CHARTER §6) — bịt kín cần OS user riêng hoặc container.
 */
function checkReadonlyDirs(tool, input, cwd) {
  if (!READONLY_DIRS.length) return null;

  let targets;
  if (WRITE_TOOLS.has(tool)) targets = fileCandidates(input);
  else if (tool === "Bash") {
    const cmd = String(input.command || "");
    if (!WRITE_INTENT.test(cmd)) return null;
    targets = [...pathTokens(cmd), ...redirectTargets(cmd)];
  } else return null;

  for (const t of targets) {
    const abs = resolveAbs(t, cwd);
    const root = READONLY_DIRS.find((r) => within(r, abs));
    if (root)
      return (
        `phiên này CHỈ ĐỌC \`${root}\` nên không ghi được \`${abs}\`. ` +
        "Muốn ghi thì đăng ký project trước: `alp init`."
      );
  }
  return null;
}

/** Đích của `>` / `>>` — bắt được `echo x > out.txt`, dạng mà pathTokens bỏ qua. */
function redirectTargets(cmd) {
  const out = [];
  const re = /(?:^|[^0-9<>])>{1,2}\s*("[^"]+"|'[^']+'|[^\s;|&<>]+)/g;
  for (const m of cmd.matchAll(re)) out.push(m[1].replace(/^['"]|['"]$/g, ""));
  return out;
}

/** `target` nằm trong (hoặc bằng) `root`? So theo đoạn path, không theo tiền tố chuỗi. */
function within(root, target) {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// ---------------------------------------------------------------- Bash

function checkBash(ctx, input) {
  const cmd = String(input.command || "");
  if (!cmd.trim()) return null;

  // Chống đệ quy delegation. Kiểm TRƯỚC indirection: lý do từ chối phải nói đúng bệnh,
  // không phải "lệnh có $()".
  const recursion = L.checkDelegationCommand(ctx.role, ctx.mayDelegate, cmd);
  if (recursion) return recursion;

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

#!/usr/bin/env node
// test-isolation.cjs — test cách ly giữa các vai. Nghiệm thu chính của cả hệ.
//
//   test-isolation.sh              chạy nhanh, gọi thẳng acl-guard.cjs (mặc định)
//   test-isolation.sh --live       chạy thật bằng `claude -p` — chậm (~vài phút), tốn token
//
// VÌ SAO CÓ HAI CHẾ ĐỘ:
//   Chế độ nhanh kiểm ĐÚNG thứ mà hook sẽ quyết định, không phụ thuộc model có chịu gọi
//   tool hay không — chạy được trong CI, chạy được mỗi lần sửa `checkPath`.
//   Chế độ --live kiểm cả chuỗi thật (settings.json + hook + model). Bắt buộc chạy một
//   lần trước khi tin hệ, vì chỉ nó chứng minh `permissions.deny` thật sự có hiệu lực.
//
// NHÓM "CHO PHÉP" QUAN TRỌNG NGANG NHÓM "CHẶN". ACL chặn hết = ACL vô dụng.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const L = require("./lib/loadout.cjs");
const D = require("./lib/delegation/config.cjs");

const repoRoot = L.findRepoRoot(__dirname);
if (!repoRoot) die("không tìm thấy repo root");
const live = process.argv.includes("--live");

const R = (...p) => path.join(repoRoot, ...p);
const SLUG = firstProjectSlug();

// ---------------------------------------------------------------- các ca

const CASES = [
  // --- Nhóm CHẶN, từ phiên librarian ---
  ["librarian", "DENY", "Read", { file_path: R("memory/private/main/x.md") }, "Read kho riêng main"],
  ["librarian", "DENY", "Bash", { command: "cat ../../memory/private/main/x.md" }, "cat kho riêng main"],
  ["librarian", "DENY", "Bash", { command: "cd ../../memory/private/main && cat x.md" }, "cd rồi cat"],
  ["librarian", "DENY", "Bash", { command: "cat $(echo ../../memory/private/main/x.md)" }, "indirection $()"],
  ["librarian", "DENY", "Bash", { command: `cat ${path.join("/tmp", "acl-symlink-probe", "x.md")}` }, "symlink → realpath"],
  ["librarian", "DENY", "Edit", { file_path: R("identity/librarian/loadout.yaml") }, "tự sửa loadout (self-escalation)"],
  ["librarian", "DENY", "Edit", { file_path: R("identity/librarian/.claude/settings.json") }, "tự sửa settings.json"],
  ["librarian", "DENY", "Read", { file_path: R("identity/main/SOUL.md") }, "Read persona vai khác"],
  ["librarian", "DENY", "Edit", { file_path: R("identity/_shared/HOUSE-RULES.md") }, "sửa luật chung"],
  ["librarian", "DENY", "Edit", { file_path: R("memory/projects", SLUG, "PROJECT.md") }, "ghi ngoài write grant"],
  ["librarian", "DENY", "Edit", { file_path: R("hooks/acl-guard.cjs") }, "sửa công cụ enforce"],

  // --- Nhóm CHO PHÉP, từ phiên librarian ---
  ["librarian", "ALLOW", "Read", { file_path: R("memory/shared/reference/deepseek-harness.md") }, "Read shared/reference"],
  ["librarian", "ALLOW", "Write", { file_path: R("memory/shared/reference/moi.md") }, "ghi shared/reference theo grant"],
  ["librarian", "ALLOW", "Write", { file_path: R("memory/projects", SLUG, "refs/moi.md") }, "ghi projects/*/refs theo grant"],
  ["librarian", "ALLOW", "Bash", { command: "touch ../../memory/private/librarian/nhap.md" }, "ghi private của mình"],
  ["librarian", "ALLOW", "Read", { file_path: R("memory/projects/INDEX.md") }, "Read L0"],
  ["librarian", "ALLOW", "Read", { file_path: R("identity/_shared/PRINCIPAL.md") }, "Read PRINCIPAL"],

  // --- Nhóm main: cách ly HAI CHIỀU ---
  ["main", "DENY", "Read", { file_path: R("memory/private/librarian/y.md") }, "main KHÔNG phải root"],
  ["main", "ALLOW", "Edit", { file_path: R("memory/projects", SLUG, "PROJECT.md") }, "ghi L1 — quyền của vai này"],
  ["main", "ALLOW", "Read", { file_path: R("memory/private/main/x.md") }, "Read private của mình"],

  // --- Chống đệ quy delegation ---
  // Không có nhóm này thì Search spawn được Search: vòng lặp đốt quota không có phanh,
  // và không ai ngồi giữa để cắt. `delegates_to` rỗng = không được mở phiên vai nào.
  ["librarian", "DENY", "Bash", { command: "herdr agent start x --kind codex --pane w1:p1" }, "vai phụ spawn agent"],
  ["librarian", "DENY", "Bash", { command: "paseo run --background -- task" }, "vai phụ gọi raw Paseo"],
  ["librarian", "DENY", "mcp__paseo__create_agent", { task: "x" }, "vai phụ gọi raw Paseo MCP tool"],
  ["librarian", "DENY", "Bash", { command: `node ${R("scripts/run-role.cjs")} search -- việc` }, "vai phụ gọi run-role"],
  ["librarian", "DENY", "Bash", { command: `node ${R("scripts/delegate.cjs")} delegate review -- việc` }, "vai phụ gọi Delegation API"],
  ["librarian", "DENY", "Bash", { command: "alp delegation cancel exec_x" }, "vai phụ không quản execution"],
  ["librarian", "DENY", "Bash", { command: "ALP_ROLE=main herdr pane split --pane w1:p1" }, "lách bằng tiền tố env"],
  ["librarian", "ALLOW", "Bash", { command: "grep -rn herdr ../../docs" }, "đọc TÀI LIỆU về herdr vẫn được"],
  ["main", "DENY", "Bash", { command: "herdr agent list" }, "main cũng không bypass Delegation API qua Herdr"],
  ["main", "DENY", "Bash", { command: "paseo run --background -- việc" }, "main cũng không bypass Delegation API qua Paseo"],
  ["main", "DENY", "spawn_agent", { task: "x" }, "main cũng không bypass bằng raw spawn tool"],
  ["main", "ALLOW", "Bash", { command: `node ${R("scripts/run-role.cjs")} search --pane -- việc` }, "main giao đúng target qua facade"],
  ["main", "ALLOW", "Bash", { command: `node ${R("scripts/delegate.cjs")} delegate review -- việc` }, "main dùng Delegation API"],
  ["main", "ALLOW", "Bash", { command: "alp delegation status exec_x" }, "main quản lifecycle generic"],
  ["main", "DENY", "Bash", { command: `node ${R("scripts/delegate.cjs")} delegate not-allowed -- việc` }, "main không được bỏ qua exact delegates_to"],
];

/**
 * Phiên delegation Codex: agent đứng ở repo NGƯỜI KHÁC, vai đến từ `ALP_ROLE` chứ không
 * từ cwd. Trước P1 những ca này lọt hết — acl-guard thấy cwd ngoài repo là buông tay.
 * Luôn chạy qua hook kể cả ở chế độ `--live`: `--live` kiểm đường dây Claude, còn đây là
 * đường dây Codex.
 */
const DELEGATED_CASES = [
  ["librarian", "DENY", "Bash", { command: `cat ${R("memory/private/main/x.md")}` }, "ngoài repo vẫn chặn kho riêng vai khác"],
  ["librarian", "DENY", "Edit", { file_path: R("identity/main/SOUL.md") }, "ngoài repo vẫn chặn persona vai khác"],
  ["librarian", "ALLOW", "Read", { file_path: R("memory/shared/reference/deepseek-harness.md") }, "ngoài repo vẫn đọc được shared"],
  ["librarian", "DENY", "mcp__paseo__create_agent", { task: "x" }, "ALP_DELEGATED_ROLE ngoài repo vẫn chặn raw runtime tool", "ALP_DELEGATED_ROLE"],
];

const SEARCH_WORKSPACES = L.effectiveWorkspaces(L.loadLoadout(repoRoot, "search")).read;
const WORKSPACE_SCOPE_CASES = SEARCH_WORKSPACES.length >= 2 ? [
  ["ALLOW", "Read", { file_path: path.join(SEARCH_WORKSPACES[1], "scope-probe") }, SEARCH_WORKSPACES[1], "đọc đúng workspace của execution"],
  ["DENY", "Read", { file_path: path.join(SEARCH_WORKSPACES[0], "scope-probe") }, SEARCH_WORKSPACES[1], "chặn workspace cũ dù vẫn có trong workspaces.read"],
  ["DENY", "Bash", { command: `rg probe ${SEARCH_WORKSPACES[0]}` }, SEARCH_WORKSPACES[1], "Bash cũng không đọc workspace cũ"],
] : [];

// ---------------------------------------------------------------- chạy
// main() gọi ở CUỐI file: mọi `const` phải khởi tạo xong trước, nếu không
// try/catch trong setupFixtures sẽ nuốt mất ReferenceError và fixture hỏng
// im lặng — biến một ca DENY thành "pass".

function main() {
  setupFixtures();

  assertGeneratedSettings();

  let pass = 0;
  const failures = [];

  for (const [role, expect, tool, input, label] of CASES) {
    const got = live ? runLive(role, tool, input) : runHook(role, tool, input);
    const ok = got === expect;
    ok ? pass++ : failures.push({ role, expect, got, label });
    console.log(`${ok ? " ok " : "FAIL"}  ${role.padEnd(15)} ${expect.padEnd(5)} ${label}`);
  }

  for (const [role, expect, tool, input, label, roleEnv = "ALP_ROLE"] of DELEGATED_CASES) {
    const got = runHook(role, tool, input, { cwd: os.tmpdir(), env: { [roleEnv]: role } });
    const ok = got === expect;
    ok ? pass++ : failures.push({ role, expect, got, label });
    console.log(`${ok ? " ok " : "FAIL"}  ${role.padEnd(15)} ${expect.padEnd(5)} ${label}`);
  }

  for (const [expect, tool, input, workspace, label] of WORKSPACE_SCOPE_CASES) {
    const got = runHook("search", tool, input, {
      cwd: workspace,
      env: {
        ALP_DELEGATED_ROLE: "search",
        ALP_DELEGATION_WORKSPACE: workspace,
        ALP_READONLY_DIRS: workspace,
      },
    });
    const ok = got === expect;
    ok ? pass++ : failures.push({ role: "search", expect, got, label });
    console.log(`${ok ? " ok " : "FAIL"}  ${"search".padEnd(15)} ${expect.padEnd(5)} ${label}`);
  }

  cleanupFixtures();

  console.log("---");
  if (failures.length) {
    console.log(`${pass}/${CASES.length + DELEGATED_CASES.length + WORKSPACE_SCOPE_CASES.length} đúng. ${failures.length} ca SAI:`);
    for (const f of failures) console.log(`  ${f.role} · ${f.label} — cần ${f.expect}, thực tế ${f.got}`);
    console.log("\nMột ca sai = cách ly chưa xong. Không được bỏ qua ca ALLOW.");
    process.exit(1);
  }
  console.log(`${pass}/${CASES.length + DELEGATED_CASES.length + WORKSPACE_SCOPE_CASES.length} đúng — cách ly hoạt động cả hai chiều.`);
  process.exit(0);
}

/**
 * Settings là lớp ACL độc lập với hook. Đừng để một refactor vô tình mở cả
 * `memory/` trong additionalDirectories hoặc quên deny một vai anh em.
 */
function assertGeneratedSettings() {
  const roles = L.listRoles(repoRoot);
  const delegationStateDir = D.loadDelegationConfig(repoRoot).stateDir;
  for (const role of roles) {
    const settingsPath = R("identity", role, ".claude", "settings.json");
    if (!fs.existsSync(settingsPath)) die(`thiếu settings sinh ra cho ${role}`);
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const unsupported = (settings.permissions?.deny || []).filter((r) =>
      /^(Glob|Grep|Write|NotebookEdit)\(/.test(r)
    );
    if (unsupported.length)
      die(`${role}: settings có path rule Claude Code không hỗ trợ: ${unsupported[0]}`);
    const dirs = settings.permissions?.additionalDirectories || [];
    const broadMemory = R("memory");
    if (dirs.includes(broadMemory))
      die(`${role}: additionalDirectories không được mở toàn bộ memory/`);
    for (const required of [
      R("memory", "shared"),
      R("memory", "projects"),
      R("memory", "private", role),
    ]) {
      if (!dirs.includes(required))
        die(`${role}: additionalDirectories thiếu ${path.relative(repoRoot, required)}`);
    }
    for (const other of roles) {
      if (other === role) continue;
      const needle = `Read(//${R("memory", "private", other, "**").replace(/^\/+/, "")})`;
      if (!(settings.permissions?.deny || []).includes(needle))
        die(`${role}: settings thiếu deny private/${other}/**`);
    }

    // Chống đệ quy ở LỚP SETTINGS. Hook mới là lớp enforce thật (luật `Bash(...)` khớp
    // theo tiền tố chuỗi nên chặn không đáng tin), nhưng hai lớp phải nói CÙNG một điều —
    // lệch nhau là lúc không ai biết luật thật là gì.
    const mayDelegate = L.canDelegate(L.loadLoadout(repoRoot, role));
    if (mayDelegate && !dirs.includes(delegationStateDir))
      die(`${role}: additionalDirectories thiếu delegation state ${delegationStateDir}`);
    if (!mayDelegate && dirs.includes(delegationStateDir))
      die(`${role}: role không delegate nhưng lại được mở delegation state`);
    for (const rule of ["Bash(herdr:*)", "Bash(paseo:*)"]) {
      if (!(settings.permissions?.deny || []).includes(rule))
        die(`${role}: settings thiếu deny raw runtime \`${rule}\``);
    }
    for (const rule of [
      `Bash(node ${R("scripts", "run-role.cjs")}:*)`,
      `Bash(node ${R("scripts", "delegate.cjs")}:*)`,
      "Bash(alp delegate:*)",
      "Bash(alp delegation:*)",
    ]) {
      const bucket = mayDelegate ? settings.permissions?.allow : settings.permissions?.deny;
      if (!(bucket || []).includes(rule))
        die(`${role}: settings thiếu ${mayDelegate ? "allow" : "deny"} facade \`${rule}\``);
    }
  }
}

// ---------------------------------------------------------------- chế độ nhanh

/**
 * Env nền cho mọi lần gọi guard: `ALP_ROLE` của PHIÊN ĐANG CHẠY TEST phải bị gỡ.
 *
 * `sessionIdentity` cho `ALP_ROLE` thắng cwd — đúng với phiên delegation, nhưng ở đây nó
 * là lỗ rò: chạy bộ test từ trong một phiên `alp` (luôn có `ALP_ROLE`) thì MỌI ca không tự
 * khai vai bị chấm theo vai của phiên, không phải vai trong ca. Đo được: chạy dưới
 * `ALP_ROLE=main` cho 17/29 với 12 ca librarian sai — báo động giả "cách ly thủng" trong
 * khi ACL nguyên vẹn. Ca nào cần vai từ env thì tự truyền qua `opts.env`.
 */
const {
  ALP_ROLE: _ambientRole,
  ALP_DELEGATED_ROLE: _ambientDelegatedRole,
  ALP_DELEGATION_EXECUTION_ID: _ambientExecution,
  ALP_DELEGATION_WORKSPACE: _ambientWorkspace,
  ALP_READONLY_DIRS: _ambientReadonly,
  ...BASE_ENV
} = process.env;

/** Gọi thẳng acl-guard.cjs với payload hook y như Claude Code gửi. */
function runHook(role, tool, input, opts = {}) {
  const payload = JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: input,
    cwd: opts.cwd || R("identity", role),
  });
  const res = spawnSync("node", [R("hooks/acl-guard.cjs")], {
    input: payload,
    encoding: "utf8",
    env: { ...BASE_ENV, ...opts.env },
  });
  const out = (res.stdout || "").trim();
  if (!out) return "ALLOW";
  try {
    return JSON.parse(out).hookSpecificOutput?.permissionDecision === "deny" ? "DENY" : "ALLOW";
  } catch {
    return "ALLOW";
  }
}

// ---------------------------------------------------------------- chế độ --live

/**
 * Chạy `claude -p` thật từ CWD của vai. Chậm và tốn token, nhưng là thứ DUY NHẤT
 * chứng minh cả chuỗi settings.json + hook + model hoạt động.
 * Chạy ở `default` mode: nếu bạn dùng mode khác trong thực tế, chạy lại với mode đó.
 */
function runLive(role, tool, input) {
  const target = input.file_path || input.command;
  const prompt =
    "Bài test ACL kỹ thuật. Hãy THỰC SỰ gọi tool được yêu cầu, đừng tự phán đoán rồi từ chối. " +
    "Tool bị chặn → in đúng chữ DENIED. Tool chạy được → in đúng chữ ALLOWED. " +
    `Nhiệm vụ: gọi tool ${tool} với ${tool === "Bash" ? "command" : "file_path"}=${target}` +
    (tool === "Write" ? ' và content="probe".' : ".");
  try {
    const out = execFileSync("claude", ["-p", prompt], {
      cwd: R("identity", role),
      env: BASE_ENV, // cùng lý do với runHook: vai đến từ cwd, không từ phiên gọi test
      encoding: "utf8",
      timeout: 200000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return /DENIED/.test(out) ? "DENY" : "ALLOW";
  } catch (e) {
    return /DENIED/.test(e.stdout || "") ? "DENY" : "ALLOW";
  }
}

// ---------------------------------------------------------------- fixture

const SYMLINK = path.join("/tmp", "acl-symlink-probe");

function setupFixtures() {
  write(R("memory/private/main/x.md"), "nháp của main\n");
  write(R("memory/private/librarian/y.md"), "nháp của librarian\n");
  write(R("memory/projects", SLUG, "PROJECT.md"), "---\nslug: acl-test-project\n---\n");

  // Symlink cho ca 5. Fixture hỏng KHÔNG được biến thành ca "pass" —
  // với một test bảo mật, im lặng bỏ qua là chế độ hỏng tệ nhất có thể.
  try {
    fs.unlinkSync(SYMLINK);
  } catch {
    /* chưa tồn tại — bình thường */
  }
  try {
    fs.symlinkSync(R("memory/private/main"), SYMLINK);
  } catch (e) {
    die(`không tạo được symlink fixture ${SYMLINK}: ${e.message}`);
  }
  const resolved = fs.realpathSync(path.join(SYMLINK, "x.md"));
  if (resolved !== fs.realpathSync(R("memory/private/main/x.md")))
    die(`symlink fixture trỏ sai: ${resolved}`);
}

function cleanupFixtures() {
  try {
    fs.rmSync(SYMLINK, { force: true });
  } catch {}
  if (SLUG === ".acl-test-project")
    fs.rmSync(R("memory/projects", SLUG), { recursive: true, force: true });
}

function write(p, body) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (!fs.existsSync(p)) fs.writeFileSync(p, body);
}

function firstProjectSlug() {
  const dir = R("memory/projects");
  const found = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .map((e) => e.name)
    .sort()[0];
  return found || ".acl-test-project";
}

function die(m) {
  console.error(`ERROR    ${m}`);
  process.exit(2);
}

main();

#!/usr/bin/env node
// test-project-config.cjs — nghiệm thu `alp init`.
//
// Khoá lại đúng những chỗ hỏng IM LẶNG (không lỗi, không cảnh báo, chỉ là sai):
//   1. cwd chưa đăng ký mà settings không deny ⇒ bất biến "cwd lạ = read-only" vỡ.
//   2. `alp init` chạy hai lần ra hai kết quả khác nhau ⇒ không ai dám chạy lại.
//   3. `alp deinit` để sót file hoặc sót quyền ⇒ gỡ rồi mà project vẫn ghi được.
//   4. Đè lên `settings.local.json` của người ta ⇒ mất dữ liệu, không phục hồi được.
//
// Chạy trong repo git tạm ở $TMPDIR, và trỏ HOME/CODEX_HOME sang thư mục tạm để
// không đụng `~/.claude.json` lẫn `~/.codex/config.toml` thật.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const L = require("./lib/loadout.cjs");
const PC = require("./lib/project-config.cjs");

const repoRoot = L.findRepoRoot(__dirname);
if (!repoRoot) die("không tìm thấy repo root");
const roles = L.listRoles(repoRoot);
const ROLE = roles.includes("main") ? "main" : roles[0];

const sandbox = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "alp-init-"));
const home = path.join(sandbox, "home");
const project = path.join(sandbox, "repo-thu");
fs.mkdirSync(home);
fs.mkdirSync(project);
git(["init", "-q"]);
fs.writeFileSync(path.join(project, "README.md"), "# repo thử\n");
git(["add", "-A"]);
git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);

const CLEAN_STATUS = status();
assert.strictEqual(CLEAN_STATUS, "", "repo thử phải sạch trước khi bắt đầu");

// Test có ghi vào file THẬT của repo (loadout.yaml, memory/projects/). Chụp nguyên trạng
// TRƯỚC khi chạy và trả lại từ bản chụp đó — không dùng `git checkout`, vì cây làm việc
// của người chạy test có thể đang dở dang và không phải việc của test này.
const ORIGINALS = new Map(
  [...roles.map((r) => L.loadoutPath(repoRoot, r)), path.join(repoRoot, "memory", "projects", "INDEX.md")]
    .filter((f) => fs.existsSync(f))
    .map((f) => [f, fs.readFileSync(f, "utf8")])
);
const PROJECT_CARD = path.join(repoRoot, "memory", "projects", path.basename(project));
assert(!fs.existsSync(PROJECT_CARD), `${PROJECT_CARD} đã tồn tại — test sẽ xoá nhầm của thật`);

let failed = 0;
try {
  testUnregisteredDeniesWrite();
  testReadOnlySession();
  testRegisteredAllowsWrite();
  testIdempotent();
  testGitStatusUnchanged();
  testUninstallRestoresEverything();
  testForeignFileNotClobbered();
} finally {
  restoreRepo();
  fs.rmSync(sandbox, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log("OK               alp init: 7 nhóm ca đều xanh");

// ---------------------------------------------------------------- ca

/**
 * BẪY CHÍNH của phase này. Claude Code mặc nhiên cho ghi thư mục làm việc, nên một
 * project chưa nằm trong `workspaces` PHẢI bị deny tường minh — cả tool file lẫn Bash.
 */
function testUnregisteredDeniesWrite() {
  const s = PC.claudeSettings(repoRoot, ROLE, project, roles);
  check("chưa đăng ký → deny Edit cwd", () => {
    assert(
      s.permissions.deny.some((d) => d.startsWith("Edit(//") && d.includes(project.replace(/^\//, ""))),
      `thiếu deny Edit cho ${project}:\n${s.permissions.deny.slice(-3).join("\n")}`
    );
  });
  check("chưa đăng ký → ALP_READONLY_DIRS cho Bash", () => {
    assert.strictEqual(s.env.ALP_READONLY_DIRS, project);
  });
  check("chưa đăng ký → Codex cũng read-only", () => {
    assert.match(PC.codexConfig(repoRoot, ROLE, project), /^sandbox_mode = "read-only"$/m);
  });

  // Hook là lớp enforce thật: `permissions.deny` không chặn được Bash.
  check("hook chặn Edit trong thư mục chỉ-đọc", () =>
    assert.match(hook("Edit", { file_path: path.join(project, "x.md") }, project), /CHỈ ĐỌC/));
  check("hook chặn ghi qua Bash redirect (tên trần)", () =>
    assert.match(hook("Bash", { command: "echo hi > note.txt" }, project), /CHỈ ĐỌC/));
  check("hook chặn rm trong thư mục chỉ-đọc", () =>
    assert.match(hook("Bash", { command: `rm ${path.join(project, "README.md")}` }, project), /CHỈ ĐỌC/));
  check("hook VẪN cho đọc", () =>
    assert.strictEqual(hook("Read", { file_path: path.join(project, "README.md") }, project), ""));
  check("hook không đụng thư mục khác", () =>
    assert.strictEqual(hook("Bash", { command: `touch ${path.join(sandbox, "ngoai.txt")}` }, project), ""));
}

/**
 * `alp` không tham số. Ba mảnh phải cùng có mặt, thiếu một là hỏng CÂM:
 * `--settings` (nạp hook + ACL), `ALP_ROLE` (hook mới biết vai), `ALP_READONLY_DIRS`
 * (chặn ghi qua Bash). Thay `claude` thật bằng stub in ra argv + env — kiểm cái mình
 * điều khiển được, không kiểm hành vi của Claude Code.
 */
function testReadOnlySession() {
  const bin = path.join(sandbox, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const stub = path.join(bin, "claude");
  fs.writeFileSync(stub, '#!/usr/bin/env bash\necho "ARGV|$*"\necho "ROLE|$ALP_ROLE"\necho "RO|$ALP_READONLY_DIRS"\necho "PWD|$PWD"\n');
  fs.chmodSync(stub, 0o755);

  const r = alp([], { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  const field = (k) => (r.output.match(new RegExp(`^${k}\\|(.*)$`, "m")) || [])[1];

  check("alp không tham số chạy được", () => assert.strictEqual(r.status, 0, r.output));
  check("nạp settings của main từ alp-code", () =>
    assert(
      (field("ARGV") || "").includes(
        `--settings ${path.join(repoRoot, "identity", ROLE, ".claude", "settings.json")}`
      ),
      `argv sai: ${field("ARGV")}`
    ));
  check("giữ nguyên cwd, không nhảy về alp-code", () =>
    assert.strictEqual(fs.realpathSync(field("PWD")), project));
  check("truyền ALP_ROLE cho hook", () => assert.strictEqual(field("ROLE"), ROLE));
  check("đánh dấu cwd là chỉ-đọc", () => assert.strictEqual(field("RO"), project));
  check("không ghi gì vào project", () => {
    for (const f of Object.values(PC.paths(project))) assert(!fs.existsSync(f), `${f} không được sinh ra`);
    assert.strictEqual(status(), CLEAN_STATUS);
  });
}

/** Đăng ký rồi thì phải MỞ ra — ACL chặn hết cũng là ACL hỏng. */
function testRegisteredAllowsWrite() {
  const lo = L.parseYaml(fs.readFileSync(L.loadoutPath(repoRoot, ROLE), "utf8"));
  lo.workspaces = { read: [project], write: [project] };
  const s = PC.claudeSettings(repoRoot, ROLE, project, roles, lo);

  check("đã đăng ký → không deny cwd", () => {
    assert(!s.permissions.deny.some((d) => d.includes(project.replace(/^\//, ""))));
    assert.strictEqual(s.env.ALP_READONLY_DIRS, undefined);
  });
  check("đã đăng ký → Codex workspace-write", () => {
    assert.match(
      PC.codexConfig(repoRoot, ROLE, project, lo),
      /^sandbox_mode = "workspace-write"$/m
    );
  });
  check("đã đăng ký → ALP_ROLE vẫn được truyền", () => assert.strictEqual(s.env.ALP_ROLE, ROLE));
  check("deny của vai anh em không được rơi rụng", () => {
    for (const other of roles.filter((r) => r !== ROLE))
      assert(
        s.permissions.deny.some((d) => d.includes(`/memory/private/${other}/`)),
        `settings.local.json thiếu deny private/${other} — cách ly vỡ ở project`
      );
  });
}

/** Chạy hai lần ra hai file byte-identical, kể cả `workspaces` trong loadout. */
function testIdempotent() {
  const first = alp(["init", project]);
  check("alp init lần 1 chạy được", () => assert.strictEqual(first.status, 0, first.output));

  const snap1 = snapshot();
  const second = alp(["init", project]);
  check("alp init lần 2 chạy được", () => assert.strictEqual(second.status, 0, second.output));
  check("hai lần init cho cùng một kết quả", () =>
    assert.deepStrictEqual(snapshot(), snap1, "alp init không idempotent"));

  check("sinh đủ hai file", () => {
    for (const f of Object.values(PC.paths(project))) assert(fs.existsSync(f), `thiếu ${f}`);
  });
  check("project vào workspaces.write của main", () => {
    const ws = L.effectiveWorkspaces(L.loadLoadout(repoRoot, ROLE));
    assert(ws.write.includes(project), "main không ghi được project vừa init");
  });
  check("init xong → Codex được workspace-write", () =>
    assert.match(fs.readFileSync(PC.paths(project).codex, "utf8"), /^sandbox_mode = "workspace-write"$/m));
  check("trust cả hai runtime", () => {
    const claude = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
    assert(
      Object.entries(claude.projects).some(([k, v]) => k === project && v.hasTrustDialogAccepted),
      "chưa trust cho Claude — pane mới sẽ dừng ở dialog và hook KHÔNG chạy"
    );
    // So bằng chuỗi, không regex: path tạm trên macOS chứa `+` — làm regex thì nó thành
    // lượng từ và ca test xanh/đỏ theo tên thư mục ngẫu nhiên.
    assert(
      fs
        .readFileSync(path.join(home, ".codex", "config.toml"), "utf8")
        .includes(`[projects."${project}"]\ntrust_level = "trusted"`),
      "chưa trust cho Codex — pane Codex sẽ bỏ qua hook của config cấp project"
    );
  });
}

/** Repo của người ta không được bẩn: hai file config phải vô hình với `git status`. */
function testGitStatusUnchanged() {
  check("git status không đổi sau init", () =>
    assert.strictEqual(status(), CLEAN_STATUS, `alp init làm bẩn repo:\n${status()}`));
}

function testUninstallRestoresEverything() {
  const r = alp(["deinit", project]);
  check("alp deinit chạy được", () => assert.strictEqual(r.status, 0, r.output));
  check("xoá sạch hai file", () => {
    for (const f of Object.values(PC.paths(project))) assert(!fs.existsSync(f), `còn sót ${f}`);
  });
  check("dọn cả thư mục rỗng", () => {
    assert(!fs.existsSync(path.join(project, ".claude")));
    assert(!fs.existsSync(path.join(project, ".codex")));
  });
  check("gỡ khỏi workspaces của mọi vai", () => {
    for (const role of roles) {
      const ws = L.effectiveWorkspaces(L.loadLoadout(repoRoot, role));
      assert(!ws.read.includes(project) && !ws.write.includes(project), `${role} còn giữ workspace`);
    }
  });
  check("git status vẫn không đổi", () => assert.strictEqual(status(), CLEAN_STATUS));
}

/** File `settings.local.json` sẵn có của người dùng: không đè, không mất. */
function testForeignFileNotClobbered() {
  const file = PC.paths(project).claude;
  const mine = '{ "permissions": { "allow": ["Bash(ls:*)"] } }\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, mine);

  const r = alp(["init", project]);
  check("init vẫn chạy khi có file lạ", () => assert.strictEqual(r.status, 0, r.output));
  check("file lạ được cất vào .alp-backup", () =>
    assert.strictEqual(fs.readFileSync(file + PC.BACKUP_SUFFIX, "utf8"), mine));

  alp(["init", "--uninstall", project]); // tên cũ: phải còn chạy được
  check("uninstall trả lại nguyên văn file lạ", () => {
    assert.strictEqual(fs.readFileSync(file, "utf8"), mine);
    assert(!fs.existsSync(file + PC.BACKUP_SUFFIX), "backup phải biến mất sau khi trả lại");
  });
  fs.rmSync(path.join(project, ".claude"), { recursive: true, force: true });
}

// ---------------------------------------------------------------- tiện ích

function check(name, fn) {
  try {
    fn();
    console.log(`PASS             ${name}`);
  } catch (e) {
    console.log(`FAIL             ${name}\n                 ${e.message.split("\n").join("\n                 ")}`);
    failed++;
  }
}

/** Chạy alp.cjs với HOME/CODEX_HOME giả — không đụng cấu hình thật của máy. */
function alp(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "alp.cjs"), ...args], {
    encoding: "utf8",
    cwd: project,
    env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, ".codex"), ...extraEnv },
  });
  return { status: r.status, output: (r.stdout || "") + (r.stderr || "") };
}

/** Gọi thẳng hook — kiểm ĐÚNG thứ hook sẽ quyết, không phụ thuộc model có gọi tool hay không. */
function hook(tool, input, cwd) {
  const r = spawnSync(process.execPath, [path.join(repoRoot, "hooks", "acl-guard.cjs")], {
    input: JSON.stringify({ tool_name: tool, tool_input: input, cwd }),
    encoding: "utf8",
    env: { ...process.env, ALP_ROLE: ROLE, ALP_READONLY_DIRS: project },
  });
  if (!r.stdout.trim()) return "";
  return JSON.parse(r.stdout).hookSpecificOutput?.permissionDecisionReason || "";
}

/** Ảnh chụp mọi thứ `alp init` được phép đụng — để so hai lần chạy. */
function snapshot() {
  const files = {};
  for (const f of Object.values(PC.paths(project)))
    files[f] = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
  for (const role of roles)
    files[role] = JSON.stringify(L.effectiveWorkspaces(L.loadLoadout(repoRoot, role)));
  return files;
}

function status() {
  return git(["status", "--porcelain"]).trim();
}

function git(args) {
  return execFileSync("git", args, { cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Trả repo về đúng trạng thái trước test: loadout, L0 index, thẻ project, và settings.json
 * (recompile — quên bước này thì doctor kêu ACL-DRIFT sau mỗi lần chạy test).
 */
function restoreRepo() {
  try {
    for (const [file, body] of ORIGINALS)
      if (fs.readFileSync(file, "utf8") !== body) fs.writeFileSync(file, body);
    fs.rmSync(PROJECT_CARD, { recursive: true, force: true });
    execFileSync(process.execPath, [path.join(repoRoot, "scripts", "compile-acl.cjs")], { stdio: "ignore" });
  } catch (e) {
    console.error(`WARN             không khôi phục được trạng thái repo: ${e.message}`);
  }
}

function die(m) {
  console.error(`ERROR    ${m}`);
  process.exit(2);
}

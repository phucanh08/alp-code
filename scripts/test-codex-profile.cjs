#!/usr/bin/env node
// Profile Codex sinh từ loadout — khoá lại đúng những chỗ hỏng IM LẶNG:
// sandbox mặc định, model của main, web search, và hook có mang ALP_ROLE hay không.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const L = require("./lib/loadout.cjs");
const P = require("./lib/codex-profile.cjs");
const D = require("./lib/delegation/config.cjs");

const repoRoot = L.findRepoRoot(__dirname);
if (!repoRoot) throw new Error("không tìm thấy repo root");
const roles = L.listRoles(repoRoot);
const delegationStateDir = D.loadDelegationConfig(repoRoot).stateDir;
const compiledProfile = (role) => {
  const loadout = L.loadLoadout(repoRoot, role);
  const mayDelegate = L.canDelegate(loadout);
  return P.buildProfile(loadout, role, repoRoot, {
    writableRoots: mayDelegate ? [delegationStateDir] : [],
    networkAccess: mayDelegate,
  });
};

// --- mọi vai: nền phải là read-only + approval never ------------------------------
// `codex exec` mặc định `workspace-write`. Quên dòng này là mất bất biến CHARTER mà
// không có lỗi nào nổ.
for (const role of roles) {
  const toml = compiledProfile(role);
  assert.match(toml, /^sandbox_mode = "read-only"$/m, `${role} phải read-only trong profile`);
  assert.match(toml, /^approval_policy = "never"$/m, `${role} phải approval never`);
  assert.match(
    toml,
    new RegExp(`command = "node [^"]*session-start\\.cjs'? --role '${role}'"`),
    `${role}: hook SessionStart phải pin role bằng argv — cwd không nói được vai`
  );
  const windowsSession =
    `node "${path.join(repoRoot, "hooks", "session-start.cjs")}" --role "${role}"`;
  assert(
    toml.includes(`command_windows = ${JSON.stringify(windowsSession)}`),
    `${role}: hook SessionStart phải có command_windows cho cmd.exe`
  );
  assert.match(toml, /\[\[hooks\.PreToolUse\.hooks\]\]/, `${role} thiếu hook acl-guard`);
}

// --- model: main khai model Claude, profile Codex phải lấy codex_model -------------
const mainToml = compiledProfile("main");
assert.match(mainToml, /^model = "gpt-5\.6-sol"$/m, "main dùng codex_model cho Codex");
assert(!/^model = ".*claude.*"$/mi.test(mainToml), "model Claude không được lọt vào profile Codex");
assert(mainToml.includes(`writable_roots = [${JSON.stringify(delegationStateDir)}]`));
assert.match(mainToml, /^network_access = true$/m);
assert(!/\[sandbox_workspace_write\]/.test(compiledProfile("search")), "Search không được mở runtime state/network");

// --- effort chỉ xuất hiện khi có khai --------------------------------------------
const search = compiledProfile("search");
assert.match(search, /^model_reasoning_effort = "low"$/m);
assert(
  !/model_reasoning_effort/.test(P.buildProfile({ model: "m" }, "librarian", repoRoot)),
  "không khai effort thì không được bịa ra dòng effort"
);

// --- web search: chỉ librarian ----------------------------------------------------
for (const role of roles) {
  const toml = compiledProfile(role);
  assert.match(
    toml,
    new RegExp(`^web_search = ${role === "librarian"}$`, "m"),
    `${role}: web_search sai`
  );
}

// --- ký tự đặc biệt trong path không được phá TOML lẫn shell ----------------------
// Hai tầng escape chồng nhau: shell (nháy đơn) rồi TOML (nháy kép). Giải ngược lại phải
// ra đúng lệnh shell hợp lệ — sai một tầng là hook không chạy, mà không chạy thì im lặng.
const oddRoot = path.join(os.tmpdir(), `a b'c"d`);
const oddHook = path.join(oddRoot, "hooks", "session-start.cjs");
const odd = P.buildProfile({ model: "m" }, "search", oddRoot);
const encoded = odd.match(/^command = "(.*)"$/m)[1];
assert.strictEqual(
  JSON.parse(`"${encoded}"`), // escape của TOML basic string trùng JSON ở tập ký tự này
  `node '${oddHook.replace(/'/g, "'\\''")}' --role 'search'`
);

// Hook phải nhận đúng vai khi cwd là project ngoài alp-code. Chỉ kiểm event name từng để
// lỗi `identity/facepod/loadout.yaml` lọt qua vì SessionStart fail-safe vẫn exit 0.
const externalCwd = os.tmpdir();
const roleSession = spawnSync(
  process.execPath,
  [path.join(repoRoot, "hooks", "session-start.cjs"), "--role", "main"],
  {
    cwd: externalCwd,
    input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: externalCwd }),
    encoding: "utf8",
  }
);
assert.strictEqual(roleSession.status, 0, `SessionStart --role lỗi:\n${roleSession.stderr}`);
const roleSessionOutput = JSON.parse(roleSession.stdout);
assert.match(
  roleSessionOutput.hookSpecificOutput?.additionalContext || "",
  /- \*\*Vai:\*\* main/,
  "SessionStart --role main không nạp identity main khi cwd ở ngoài alp-code"
);
assert(!/identity CHƯA được nạp/.test(roleSessionOutput.systemMessage || ""));

// --- Windows: chạy command override thật qua cmd.exe ------------------------------
// So chuỗi là chưa đủ: command có thể chạy nhưng mất role tùy shell. Cả context identity
// và quyết định deny phải chứng minh `--role main` đã tới được hook.
if (process.platform === "win32") {
  const windowsCommands = [...mainToml.matchAll(/^command_windows = "(.*)"$/gm)]
    .map((m) => JSON.parse(`"${m[1]}"`));
  assert.strictEqual(windowsCommands.length, 2, "main phải có Windows command cho cả hai hook");

  const cleanEnv = { ...process.env };
  delete cleanEnv.NODE_EXTRA_CA_CERTS;

  const session = spawnSync(windowsCommands[0], {
    shell: process.env.ComSpec || "cmd.exe",
    cwd: externalCwd,
    input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: externalCwd }),
    encoding: "utf8",
    env: cleanEnv,
  });
  assert.strictEqual(session.status, 0, `SessionStart command_windows lỗi:\n${session.stderr}`);
  const sessionOutput = JSON.parse(session.stdout);
  assert.match(
    sessionOutput.hookSpecificOutput?.additionalContext || "",
    /- \*\*Vai:\*\* main/,
    "SessionStart command_windows không nạp identity main"
  );

  const preTool = spawnSync(windowsCommands[1], {
    shell: process.env.ComSpec || "cmd.exe",
    cwd: externalCwd,
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: path.join(repoRoot, "identity", "search", "IDENTITY.md") },
      cwd: externalCwd,
    }),
    encoding: "utf8",
    env: cleanEnv,
  });
  assert.strictEqual(preTool.status, 0, `PreToolUse command_windows lỗi:\n${preTool.stderr}`);
  assert.match(
    JSON.parse(preTool.stdout).hookSpecificOutput?.permissionDecisionReason || "",
    /main không được đọc persona của vai `search`/,
    "PreToolUse command_windows không giữ ACL của main khi cwd ở ngoài alp-code"
  );
}


// --- compile-acl --check phải BẮT được profile thiếu/lệch -------------------------
const home = fs.mkdtempSync(path.join(os.tmpdir(), "alp-codex-"));
const env = { ...process.env, CODEX_HOME: home };
const check = () => spawnSync(process.execPath, [path.join(repoRoot, "scripts", "compile-acl.cjs"), "--check"], { env, encoding: "utf8" });

let r = check();
assert.strictEqual(r.status, 1, "profile chưa sinh mà --check vẫn xanh");
assert.match(r.stdout, /PROFILE-MISSING/, "thiếu profile phải báo PROFILE-MISSING");

spawnSync(process.execPath, [path.join(repoRoot, "scripts", "compile-acl.cjs")], { env, encoding: "utf8" });
for (const role of roles)
  assert(fs.existsSync(P.profilePath(home, role)), `chưa sinh profile cho ${role}`);

r = check();
assert.strictEqual(r.status, 0, `--check phải xanh ngay sau compile:\n${r.stdout}`);

fs.appendFileSync(P.profilePath(home, "search"), 'sandbox_mode = "danger-full-access"\n');
r = check();
assert.strictEqual(r.status, 1, "profile bị sửa tay mà --check vẫn xanh");
assert.match(r.stdout, /PROFILE-DRIFT search/);

fs.rmSync(home, { recursive: true, force: true });

console.log("OK               Codex profile tests passed");

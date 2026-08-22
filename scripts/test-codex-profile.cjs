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

const repoRoot = L.findRepoRoot(__dirname);
if (!repoRoot) throw new Error("không tìm thấy repo root");
const roles = L.listRoles(repoRoot);

// --- mọi vai: nền phải là read-only + approval never ------------------------------
// `codex exec` mặc định `workspace-write`. Quên dòng này là mất bất biến CHARTER mà
// không có lỗi nào nổ.
for (const role of roles) {
  const toml = P.buildProfile(L.loadLoadout(repoRoot, role), role, repoRoot);
  assert.match(toml, /^sandbox_mode = "read-only"$/m, `${role} phải read-only trong profile`);
  assert.match(toml, /^approval_policy = "never"$/m, `${role} phải approval never`);
  assert.match(
    toml,
    new RegExp(`command = "ALP_ROLE=${role} node [^"]*session-start\\.cjs'?"`),
    `${role}: hook SessionStart phải mang ALP_ROLE — cwd không nói được vai`
  );
  assert.match(toml, /\[\[hooks\.PreToolUse\.hooks\]\]/, `${role} thiếu hook acl-guard`);
}

// --- model: main khai model Claude, profile Codex phải lấy codex_model -------------
const mainToml = P.buildProfile(L.loadLoadout(repoRoot, "main"), "main", repoRoot);
assert.match(mainToml, /^model = "gpt-5\.6-sol"$/m, "main dùng codex_model cho Codex");
assert(!/^model = ".*claude.*"$/mi.test(mainToml), "model Claude không được lọt vào profile Codex");

// --- effort chỉ xuất hiện khi có khai --------------------------------------------
const search = P.buildProfile(L.loadLoadout(repoRoot, "search"), "search", repoRoot);
assert.match(search, /^model_reasoning_effort = "low"$/m);
assert(
  !/model_reasoning_effort/.test(P.buildProfile({ model: "m" }, "librarian", repoRoot)),
  "không khai effort thì không được bịa ra dòng effort"
);

// --- web search: chỉ librarian ----------------------------------------------------
for (const role of roles) {
  const toml = P.buildProfile(L.loadLoadout(repoRoot, role), role, repoRoot);
  assert.match(
    toml,
    new RegExp(`^web_search = ${role === "librarian"}$`, "m"),
    `${role}: web_search sai`
  );
}

// --- ký tự đặc biệt trong path không được phá TOML lẫn shell ----------------------
// Hai tầng escape chồng nhau: shell (nháy đơn) rồi TOML (nháy kép). Giải ngược lại phải
// ra đúng lệnh shell hợp lệ — sai một tầng là hook không chạy, mà không chạy thì im lặng.
const odd = P.buildProfile({ model: "m" }, "search", `/tmp/a b'c"d`);
const encoded = odd.match(/^command = "(.*)"$/m)[1];
assert.strictEqual(
  JSON.parse(`"${encoded}"`), // escape của TOML basic string trùng JSON ở tập ký tự này
  `ALP_ROLE=search node '/tmp/a b'\\''c"d/hooks/session-start.cjs'`
);


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

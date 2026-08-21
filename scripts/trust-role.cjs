#!/usr/bin/env node
// trust-role.cjs — đánh dấu workspace của một vai là "trusted" trong ~/.claude.json.
//
//   trust-role.sh            mọi vai
//   trust-role.sh <role>...  vai chỉ định
//
// VÌ SAO CẦN: workspace chưa trust thì Claude Code BỎ QUA toàn bộ `permissions.allow`
// và `additionalDirectories` của vai đó — agent mở được phiên nhưng không đọc nổi
// memory/. `deny` vẫn áp dụng, nên vai hỏng theo kiểu "câm", không phải "hở".
// Đã đo: memory/shared/reference/claude-code-acl-behavior.md phát hiện 2.
//
// Cơ chế ghi nằm ở lib/trust.cjs — `alp init` trust project bằng đúng hàm đó.

const fs = require("fs");
const path = require("path");
const L = require("./lib/loadout.cjs");
const T = require("./lib/trust.cjs");

const repoRoot = L.findRepoRoot(__dirname);
if (!repoRoot) die("không tìm thấy repo root (thư mục có CHARTER.md)");

const allRoles = L.listRoles(repoRoot);
const targets = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const roles = targets.length ? targets : allRoles;
for (const r of roles) if (!allRoles.includes(r)) die(`không có vai \`${r}\``);

const dirs = roles.map((role) => {
  const dir = path.join(repoRoot, "identity", role);
  if (!fs.existsSync(dir)) die(`không thấy ${dir}`);
  return dir;
});

let added;
try {
  added = T.trustClaude(dirs);
} catch (e) {
  die(e.message);
}

if (added.length) added.forEach((key) => console.log(`TRUSTED  ${key}`));
else console.log("OK       mọi vai đã trusted");

function die(m) {
  console.error(`ERROR    ${m}`);
  process.exit(2);
}

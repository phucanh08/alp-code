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
// macOS: /tmp là symlink tới /private/tmp và Claude Code dùng CẢ HAI dạng path làm key.
// Vì vậy ghi cả path thường lẫn realpath.

const fs = require("fs");
const path = require("path");
const L = require("./lib/loadout.cjs");

const repoRoot = L.findRepoRoot(__dirname);
if (!repoRoot) die("không tìm thấy repo root (thư mục có CHARTER.md)");

const allRoles = L.listRoles(repoRoot);
const targets = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const roles = targets.length ? targets : allRoles;
for (const r of roles) if (!allRoles.includes(r)) die(`không có vai \`${r}\``);

const cfgPath = path.join(process.env.HOME || "", ".claude.json");
let cfg;
if (!fs.existsSync(cfgPath)) {
  // Máy mới chưa chạy Claude Code vẫn phải tạo vai được. Claude Code chấp nhận
  // object tối thiểu này và sẽ bổ sung các key khác khi khởi động lần đầu.
  cfg = {};
} else {
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch (e) {
    die(`${cfgPath} không parse được: ${e.message}`);
  }
}
cfg.projects = cfg.projects || {};

let changed = 0;
for (const role of roles) {
  const dir = path.join(repoRoot, "identity", role);
  if (!fs.existsSync(dir)) die(`không thấy ${dir}`);
  for (const key of new Set([dir, fs.realpathSync(dir)])) {
    if (cfg.projects[key]?.hasTrustDialogAccepted) continue;
    cfg.projects[key] = { ...cfg.projects[key], hasTrustDialogAccepted: true };
    console.log(`TRUSTED  ${key}`);
    changed++;
  }
}

if (changed) {
  // Ghi qua file tạm rồi rename — ~/.claude.json là state sống của Claude Code,
  // ghi dở dang là hỏng cấu hình của mọi phiên.
  const tmp = cfgPath + ".agent-memory.tmp";
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
  fs.renameSync(tmp, cfgPath);
} else {
  console.log("OK       mọi vai đã trusted");
}

function die(m) {
  console.error(`ERROR    ${m}`);
  process.exit(2);
}

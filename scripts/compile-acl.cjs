#!/usr/bin/env node
// compile-acl.cjs — sinh từ loadout.yaml ra HAI sản phẩm:
//   identity/<role>/.claude/settings.json   (Claude Code)
//   $CODEX_HOME/<role>.config.toml          (Codex, xem lib/codex-profile.cjs)
//
//   compile-acl.sh              = --all (mặc định)
//   compile-acl.sh --check      chỉ so sánh, exit 1 nếu lệch
//   compile-acl.sh <role>       một vai — CẢNH BÁO: settings vai khác sẽ thiếu deny
//
// VÌ SAO MẶC ĐỊNH LÀ --all: `deny` thắng `allow` trong Claude Code, nên không viết
// được luật "cấm private/**, trừ private/<mình>/**". Bắt buộc liệt kê từng vai anh em.
// Thêm một vai mà không recompile ⇒ settings của MỌI vai cũ thiếu một dòng deny ⇒ rò rỉ.
//
// Nội dung settings.json nằm ở lib/claude-settings.cjs — `alp init` sinh
// `<project>/.claude/settings.local.json` từ CÙNG builder đó. File này chỉ còn phần I/O:
// chọn vai, ghi file, so sánh khi `--check`.

const fs = require("fs");
const path = require("path");
const L = require("./lib/loadout.cjs");
const P = require("./lib/codex-profile.cjs");
const S = require("./lib/claude-settings.cjs");
const K = require("./lib/skill-links.cjs");
const D = require("./lib/delegation/config.cjs");

const repoRoot = L.findRepoRoot(__dirname);
if (!repoRoot) die("Không tìm thấy repo root (thư mục có CHARTER.md)");

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const targets = args.filter((a) => !a.startsWith("-"));

const allRoles = L.listRoles(repoRoot);
if (allRoles.length === 0) die("Không có vai nào trong identity/");

const roles = targets.length ? targets : allRoles;
const delegationConfig = D.loadDelegationConfig(repoRoot);
for (const r of roles) {
  if (!allRoles.includes(r)) die(`Không có vai \`${r}\` trong identity/`);
}
if (targets.length && !checkOnly && targets.length < allRoles.length) {
  warn(`Chỉ compile ${targets.join(", ")} — settings của các vai còn lại sẽ THIẾU deny.`);
  warn("Chạy `compile-acl.sh` không tham số để recompile tất cả.");
}

// ---------------------------------------------------------------- sinh settings

function buildSettings(role) {
  try {
    return S.buildSettings(repoRoot, role, allRoles, L.loadLoadout(repoRoot, role), {
      delegationStateDir: delegationConfig.stateDir,
    });
  } catch (e) {
    (e.issues || []).forEach((i) => console.error(`INVALID  ${i}`));
    die(`${e.message} — sửa rồi chạy lại`);
  }
}

// ---------------------------------------------------------------- ghi / so sánh

// Profile Codex nằm NGOÀI repo (`$CODEX_HOME`, mặc định `~/.codex`) vì `codex -p <name>`
// chỉ tìm ở đó. Đây là chỗ duy nhất script này ghi ra ngoài repo.
const CODEX_HOME = P.codexHome();

let drifted = 0;
for (const role of roles) {
  const outDir = path.join(repoRoot, "identity", role, ".claude");
  const outFile = path.join(outDir, "settings.json");
  const body = JSON.stringify(buildSettings(role), null, 2) + "\n";

  const profileFile = P.profilePath(CODEX_HOME, role);
  const loadout = L.loadLoadout(repoRoot, role);
  const mayDelegate = L.canDelegate(loadout);
  const profileBody = P.buildProfile(loadout, role, repoRoot, {
    writableRoots: mayDelegate ? [delegationConfig.stateDir] : [],
    // Backend CLI cần kết nối Herdr Unix socket hoặc Paseo daemon local. ACL hook vẫn
    // chặn gọi raw runtime command; network chỉ phục vụ Delegation API đã authorize.
    networkAccess: mayDelegate,
  });

  if (checkOnly) {
    const cur = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : null;
    if (cur !== body) {
      console.log(`ACL-DRIFT ${role} — settings.json lệch với loadout.yaml`);
      drifted++;
    }
    const curProfile = fs.existsSync(profileFile) ? fs.readFileSync(profileFile, "utf8") : null;
    if (curProfile !== profileBody) {
      console.log(
        curProfile === null
          ? `PROFILE-MISSING ${role} — ${profileFile} chưa sinh; \`codex -p ${role}\` sẽ IM LẶNG chạy mặc định (workspace-write)`
          : `PROFILE-DRIFT ${role} — ${path.basename(profileFile)} lệch với loadout.yaml`
      );
      drifted++;
    }
    for (const issue of K.checkSkillLinks(repoRoot, role, L.loadLoadout(repoRoot, role))) {
      console.log(`SKILL-DRIFT ${role} — ${issue}`);
      drifted++;
    }
    continue;
  }

  fs.mkdirSync(path.dirname(profileFile), { recursive: true });
  fs.writeFileSync(profileFile, profileBody);
  console.log(`WROTE    ${profileFile}`);

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, body);
  // Dấu thời gian để doctor.sh phát hiện loadout bị sửa sau lần compile cuối.
  fs.writeFileSync(
    path.join(outDir, ".acl-stamp"),
    JSON.stringify({
      compiledAt: new Date().toISOString(),
      repoRoot,
      loadoutMtime: fs.statSync(L.loadoutPath(repoRoot, role)).mtimeMs,
      roles: allRoles,
    }) + "\n"
  );
  console.log(`WROTE    identity/${role}/.claude/settings.json`);

  // Symlink skill sinh CÙNG lúc với settings, không phải bước riêng: hai artifact cùng
  // derive từ một loadout, tách ra là mở đường cho chúng lệch nhau.
  const links = K.syncSkillLinks(repoRoot, role, L.loadLoadout(repoRoot, role));
  for (const name of links.removed) console.log(`UNLINK   identity/${role}/${name}`);
  for (const name of links.created) console.log(`LINK     identity/${role}/${name}`);
}

if (checkOnly) {
  if (drifted) {
    console.log(`---\n${drifted} chỗ lệch. Chạy: scripts/compile-acl.sh`);
    process.exit(1);
  }
  console.log("OK       ACL + profile Codex khớp loadout.yaml ở mọi vai");
}

function warn(m) { console.error(`WARN     ${m}`); }
function die(m) { console.error(`ERROR    ${m}`); process.exit(2); }

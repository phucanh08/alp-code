#!/usr/bin/env node
// Symlink skill là thứ QUYẾT ĐỊNH vai nạp được skill nào. Hỏng ở đây thì vai vẫn boot,
// vẫn in ra thẻ danh tính đầy đủ, chỉ là không có skill — đúng loại hỏng im lặng mà
// CHARTER §2 bắt phải bắt sớm. Nên test chạy trên thư mục tạm, không đụng repo thật.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const L = require("./lib/loadout.cjs");
const K = require("./lib/skill-links.cjs");

let pass = 0;
const ok = (label, cond) => {
  assert(cond, label);
  console.log(`PASS             ${label}`);
  pass++;
};

// --- repo giả: CHARTER.md để findRepoRoot nhận ra, vài skill, một vai --------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), "alp-skill-links-"));
fs.writeFileSync(path.join(root, "CHARTER.md"), "# giả\n");
for (const name of ["agent-memory", "code-review", "chua-dung"]) {
  fs.mkdirSync(path.join(root, "skills", name), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`);
}
// Thư mục không có SKILL.md không phải skill — không được lọt vào danh sách hợp lệ.
fs.mkdirSync(path.join(root, "skills", "rac"), { recursive: true });
fs.mkdirSync(path.join(root, "identity", "probe"), { recursive: true });

const lo = (skills) => ({ role: "probe", name: "Probe", memory: { read: [], write: [] }, skills });
const linkPath = (name) => path.join(root, "identity", "probe", ".claude", "skills", name);

// --- danh sách skill có thật ------------------------------------------------------
ok("thư mục thiếu SKILL.md không tính là skill",
  JSON.stringify(K.availableSkills(root)) === JSON.stringify(["agent-memory", "chua-dung", "code-review"]));

// --- sinh link --------------------------------------------------------------------
K.syncSkillLinks(root, "probe", lo(["agent-memory", "code-review"]));
ok("sinh đúng số link", fs.readdirSync(path.dirname(linkPath("x"))).length === 2);
ok("link là symlink, không phải bản sao", fs.lstatSync(linkPath("code-review")).isSymbolicLink());
ok("link resolve tới skills/ của repo",
  fs.readFileSync(path.join(linkPath("code-review"), "SKILL.md"), "utf8").includes("name: code-review"));

// Target tuyệt đối chết khi repo bị clone sang máy khác — cùng lớp lỗi với path tuyệt
// đối trong `workspaces:`. Phải tương đối, và phải tương đối ĐÚNG số cấp.
ok("target tương đối, không tuyệt đối", !path.isAbsolute(fs.readlinkSync(linkPath("code-review"))));
ok("target đúng số cấp `../`", fs.readlinkSync(linkPath("code-review")) === path.join("..", "..", "..", "..", "skills", "code-review"));

// --- idempotent -------------------------------------------------------------------
const again = K.syncSkillLinks(root, "probe", lo(["agent-memory", "code-review"]));
ok("chạy lại không tạo/xoá gì", again.created.length === 0 && again.removed.length === 0);

// --- bỏ skill khỏi loadout thì link phải BIẾN MẤT ----------------------------------
// Link thừa nguy hiểm hơn link thiếu: vai nạp được skill principal đã gỡ mà không ai biết.
const shrunk = K.syncSkillLinks(root, "probe", lo(["agent-memory"]));
ok("gỡ skill khỏi loadout thì link bị dọn", shrunk.removed.includes("code-review") && !fs.existsSync(linkPath("code-review")));

// --- loadout rỗng thì dọn sạch cả thư mục ------------------------------------------
K.syncSkillLinks(root, "probe", lo([]));
ok("skills rỗng → không còn thư mục link", !fs.existsSync(path.dirname(linkPath("x"))));
ok("skills rỗng → không báo lệch", K.checkSkillLinks(root, "probe", lo([])).length === 0);

// --- phát hiện lệch ---------------------------------------------------------------
K.syncSkillLinks(root, "probe", lo(["agent-memory", "code-review"]));
fs.rmSync(linkPath("code-review"));
ok("thiếu link → báo lệch", K.checkSkillLinks(root, "probe", lo(["agent-memory", "code-review"]))
  .some((m) => m.includes("thiếu link `code-review`")));

K.syncSkillLinks(root, "probe", lo(["agent-memory", "code-review"]));
fs.rmSync(linkPath("code-review"));
fs.writeFileSync(linkPath("code-review"), "không phải symlink");
ok("file thường chiếm chỗ link → báo lệch", K.checkSkillLinks(root, "probe", lo(["agent-memory", "code-review"]))
  .some((m) => m.includes("trỏ sai")));
K.syncSkillLinks(root, "probe", lo(["agent-memory", "code-review"]));
ok("sync sửa được file thường chiếm chỗ", fs.lstatSync(linkPath("code-review")).isSymbolicLink());

fs.symlinkSync(path.join("..", "..", "..", "..", "skills", "chua-dung"), linkPath("chua-dung"));
ok("link thừa → báo lệch", K.checkSkillLinks(root, "probe", lo(["agent-memory", "code-review"]))
  .some((m) => m.includes("thừa link `chua-dung`")));

// --- validate loadout --------------------------------------------------------------
const known = K.availableSkills(root);
ok("skill có thật → không lỗi", L.validate(lo(["agent-memory"]), "probe", ["probe"], known).length === 0);
ok("skill không có thật → lỗi", L.validate(lo(["khong-ton-tai"]), "probe", ["probe"], known)
  .some((m) => m.includes("skill lạ")));
ok("skill trùng → lỗi", L.validate(lo(["agent-memory", "agent-memory"]), "probe", ["probe"], known)
  .some((m) => m.includes("skill trùng")));
// Bỏ trống `knownSkills` = caller cũ chưa truyền; không được vì thế mà báo lỗi giả.
ok("không truyền knownSkills → bỏ qua phần kiểm skill",
  L.validate(lo(["khong-ton-tai"]), "probe", ["probe"]).length === 0);

fs.rmSync(root, { recursive: true, force: true });
console.log(`OK               skill links: ${pass} ca đều xanh`);

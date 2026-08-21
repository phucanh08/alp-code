#!/usr/bin/env node
// new-role.cjs — con đường DUY NHẤT để thêm một vai.
//
//   new-role.sh <role-slug> [--name <Tên>] [--emoji <e>] [--model <id>]
//
// VÌ SAO KHÔNG ĐƯỢC TẠO TAY: `deny` thắng `allow` trong Claude Code, nên không viết được
// luật "cấm private/**, trừ private/<mình>/**". Phải liệt kê từng vai anh em trong
// deny-list của MỌI vai. Tạo thư mục bằng `cp -r` mà quên bước 6 ⇒ settings của mọi vai cũ
// thiếu một dòng deny ⇒ vai mới bị đọc trộm ngay từ phút đầu. Xem CHARTER.md §4.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const L = require("./lib/loadout.cjs");

const repoRoot = L.findRepoRoot(__dirname);
if (!repoRoot) die("không tìm thấy repo root (thư mục có CHARTER.md)");

// ---------------------------------------------------------------- tham số

const argv = process.argv.slice(2);
const slug = argv.find((a) => !a.startsWith("--") && !isFlagValue(argv, a));
if (!slug) die("thiếu <role-slug>. Ví dụ: new-role.sh qa --name QA --emoji 🧪");

const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const name = opt("name", capitalize(slug));
const emoji = opt("emoji", "🤖");
const model = opt("model", "claude-opus-5");

// 1. validate slug
if (!/^[a-z][a-z0-9-]*$/.test(slug)) die(`slug \`${slug}\` phải là kebab-case, bắt đầu bằng chữ thường`);
if (slug.startsWith("_")) die("slug không được bắt đầu bằng `_` (dành cho _shared/_template)");
const roleDir = path.join(repoRoot, "identity", slug);
if (fs.existsSync(roleDir)) die(`vai \`${slug}\` đã tồn tại tại identity/${slug}/`);

// ---------------------------------------------------------------- dựng vai

// 2. copy khuôn
const templateDir = path.join(repoRoot, "identity", "_template");
if (!fs.existsSync(templateDir)) die("thiếu identity/_template/");
copyDir(templateDir, roleDir);

// 3. thay placeholder
const today = new Date().toISOString().slice(0, 10);
const vars = { ROLE: slug, NAME: name, EMOJI: emoji, MODEL: model, DATE: today };
for (const file of walk(roleDir)) {
  if (!/\.(md|yaml|yml)$/.test(file)) continue;
  let text = fs.readFileSync(file, "utf8");
  for (const [k, v] of Object.entries(vars)) text = text.split(`{{${k}}}`).join(v);
  fs.writeFileSync(file, text);
}
console.log(`WROTE    identity/${slug}/ (từ _template)`);

// 4. kho riêng
const privDir = path.join(repoRoot, "memory", "private", slug);
fs.mkdirSync(privDir, { recursive: true });
fs.writeFileSync(path.join(privDir, ".gitkeep"), "");
console.log(`WROTE    memory/private/${slug}/`);

// 5. ghi vào REGISTRY
addToRegistry(slug, name, emoji, model);

// 6. RECOMPILE MỌI VAI — bước không được bỏ. Thiếu nó = rò rỉ.
console.log("---");
runNode("compile-acl.cjs", []);

// 7. trust workspace của vai mới — chưa trust thì allow/additionalDirectories bị bỏ qua
runNode("trust-role.cjs", [slug]);

// 8. kiểm tra lại
console.log("---");
// doctor exit 1 = có finding — vai mới CHẮC CHẮN còn TEMPLATE-LEFT nên đó là
// kết quả mong đợi, không phải lỗi. Chỉ exit 2 mới là doctor tự gãy.
runNode("doctor.cjs", [], { allow: [0, 1] });

console.log(
  [
    "---",
    `Vai \`${slug}\` (${name} ${emoji}) sẵn sàng.`,
    "",
    `  cd identity/${slug} && claude`,
    "",
    "TIẾP THEO — khuôn còn placeholder mô tả, phải viết nội dung thật:",
    `  1. identity/${slug}/SOUL.md      — vai này là NGƯỜI thế nào (khác các vai đang có)`,
    `  2. identity/${slug}/PLAYBOOK.md  — quy trình riêng`,
    `  3. identity/${slug}/RELATIONS.md — nhận việc từ ai, giao cho ai`,
    `  4. identity/${slug}/loadout.yaml — memory.read / memory.write / tools / skills`,
    `  5. scripts/compile-acl.sh        — chạy lại sau khi sửa loadout.yaml`,
    "",
    "doctor.sh sẽ báo TEMPLATE-LEFT cho tới khi thay hết placeholder.",
  ].join("\n")
);

// ---------------------------------------------------------------- tiện ích

function addToRegistry(slug, name, emoji, model) {
  const file = path.join(repoRoot, "identity", "REGISTRY.md");
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");

  // Chèn sau dòng cuối cùng của bảng đầu tiên.
  let last = -1;
  for (let i = 0; i < lines.length; i++) if (/^\|/.test(lines[i])) last = i;
  if (last < 0) die("REGISTRY.md không có bảng nào để chèn");

  const lo = L.loadLoadout(repoRoot, slug) || {};
  lines.splice(last + 1, 0, `| ${slug} | ${name} | ${emoji} | ${model} | ${lo.reports_to || "principal"} | ACTIVE |`);
  fs.writeFileSync(file, lines.join("\n"));
  console.log(`WROTE    identity/REGISTRY.md — thêm dòng \`${slug}\``);
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    e.isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d);
  }
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

// Gọi script chị em qua process.execPath, KHÔNG qua wrapper .sh — bash không có
// trên Windows, mà new-role.ps1 vẫn phải chạy được.
function runNode(script, args, { allow = [0] } = {}) {
  const file = path.join(repoRoot, "scripts", script);
  try {
    process.stdout.write(
      execFileSync(process.execPath, [file, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    );
  } catch (e) {
    process.stdout.write((e.stdout || "") + (e.stderr || ""));
    if (allow.includes(e.status)) return;
    die(`bước bắt buộc \`${script} ${args.join(" ")}\` thất bại (exit ${e.status ?? "?"})`);
  }
}

function isFlagValue(argv, token) {
  const i = argv.indexOf(token);
  return i > 0 && argv[i - 1].startsWith("--");
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function die(m) {
  console.error(`ERROR    ${m}`);
  process.exit(2);
}

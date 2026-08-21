#!/usr/bin/env node
// Đăng ký một project code có sẵn vào alp-code — chạy trên macOS/Linux/Windows.
// Node là implementation duy nhất; install-project.sh và .ps1 chỉ là wrapper.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const L = require("./lib/loadout.cjs");

const repoRoot = L.findRepoRoot(__dirname);
if (!repoRoot) die("không tìm thấy repo alp-code");

const argv = process.argv.slice(2);
if (!argv.length || argv.includes("--help") || argv.includes("-h")) usage(argv.length ? 0 : 2);
const projectArg = argv[0];
if (projectArg.startsWith("--")) die("tham số đầu tiên phải là đường dẫn project");

const projectPath = realOrResolved(projectArg);
if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory())
  die(`project không tồn tại hoặc không phải thư mục: ${projectPath}`);
if (L.isWithin(repoRoot, projectPath) || L.isWithin(projectPath, repoRoot))
  die("project code và alp-code không được chứa lẫn nhau");
if (/[,#\[\]]/.test(projectPath))
  die("path chứa một trong các ký tự chưa được loadout parser hỗ trợ: , # [ ]");

const slug = option("slug", slugify(path.basename(projectPath)));
const name = option("name", path.basename(projectPath));
const summary = option("summary", `Workspace code tại ${projectPath}`);
if (!/^[a-z][a-z0-9-]*$/.test(slug)) die(`slug không hợp lệ: ${slug}`);

const roles = L.listRoles(repoRoot);
const explicitRead = options("read-role");
const explicitWrite = options("write-role");
// Read Thread chỉ đọc memory; không tự động mở source workspace cho vai này.
const defaultReaders = roles.filter((r) => r !== "read-thread");
const readRoles = new Set(explicitRead.length ? explicitRead : defaultReaders);
const defaultWriter = roles.includes("main") ? "main" : roles[0];
const writeRoles = new Set(explicitWrite.length ? explicitWrite : [defaultWriter]);
for (const role of writeRoles) readRoles.add(role);
for (const role of [...readRoles, ...writeRoles])
  if (!roles.includes(role)) die(`không có vai \`${role}\``);

installProjectCard();
for (const role of roles) updateLoadout(role, readRoles.has(role), writeRoles.has(role));
runNode("scripts/compile-acl.cjs", []);

console.log("---");
console.log(`INSTALLED project \`${slug}\``);
console.log(`CODE      ${projectPath}`);
console.log(`MEMORY    ${path.join(repoRoot, "memory", "projects", slug, "PROJECT.md")}`);
console.log(`READ      ${[...readRoles].join(", ")}`);
console.log(`WRITE     ${[...writeRoles].join(", ") || "(không vai nào)"}`);
console.log("");
// `alp init` gọi script này rồi in hướng dẫn của riêng nó — chỉ nhắc khi chạy trần,
// nếu không principal đọc hai lời khuyên khác nhau cho cùng một bước.
if (!process.env.ALP_INIT)
  console.log(`Còn thiếu config cục bộ: chạy \`alp init ${projectPath}\` để gõ \`claude\` ngay trong project.`);

function installProjectCard() {
  const dir = path.join(repoRoot, "memory", "projects", slug);
  const card = path.join(dir, "PROJECT.md");
  if (fs.existsSync(card)) {
    const current = fs.readFileSync(card, "utf8");
    const currentPath = current.match(/^path:\s*(.+)$/m)?.[1]?.trim();
    if (currentPath && path.resolve(currentPath) !== projectPath)
      die(`slug \`${slug}\` đã trỏ tới project khác: ${currentPath}`);
    console.log(`KEEP      memory/projects/${slug}/PROJECT.md đã tồn tại`);
  } else {
    fs.mkdirSync(path.join(dir, "decisions"), { recursive: true });
    fs.mkdirSync(path.join(dir, "log"), { recursive: true });
    fs.mkdirSync(path.join(dir, "refs"), { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(card, projectCard(today));
    console.log(`WROTE     memory/projects/${slug}/PROJECT.md`);
  }
  updateProjectIndex();
}

function projectCard(today) {
  return `---\nslug: ${slug}\nname: ${name}\nstatus: ACTIVE\npriority: P1\nsummary: ${summary}\npath: ${projectPath}\nupdated: ${today}\n---\n\n# ${name}\n\n## Mục tiêu\n\nBổ sung mục tiêu của project.\n\n## Trạng thái hiện tại\n\nProject hiện có đã được đăng ký vào alp-code.\n\n## Việc tiếp theo\n\n1. Đọc codebase và cập nhật hồ sơ này.\n\n## Đang chặn\n\n_(không có)_\n\n## Stack & lệnh\n\n| | |\n|---|---|\n| Stack | Bổ sung sau khi khảo sát |\n| Chạy | \`<bổ sung>\` |\n| Test | \`<bổ sung>\` |\n| Deploy | \`<bổ sung>\` |\n\n## Quyết định\n\n_(chưa có)_\n\n## Nhật ký\n\n- [${today.slice(0, 7)}](log/${today.slice(0, 7)}.md)\n`;
}

function updateProjectIndex() {
  const file = path.join(repoRoot, "memory", "projects", "INDEX.md");
  let text = fs.readFileSync(file, "utf8");
  const row = `| ${slug} | P1 | ACTIVE | ${summary.replace(/\|/g, "-")} | ${new Date().toISOString().slice(0, 10)} |`;
  const lines = text.split("\n").filter((line) => !line.startsWith(`| ${slug} |`));
  const end = lines.findIndex((line) => line.includes("<!-- END:INDEX -->"));
  if (end < 0) die("memory/projects/INDEX.md thiếu marker END:INDEX");
  lines.splice(end, 0, row);
  fs.writeFileSync(file, lines.join("\n"));
  console.log("WROTE     memory/projects/INDEX.md");
}

function updateLoadout(role, canRead, canWrite) {
  if (!canRead && !canWrite) return;
  const ws = L.effectiveWorkspaces(L.loadLoadout(repoRoot, role));
  const changed = L.writeWorkspaces(
    repoRoot,
    role,
    [...ws.read, ...(canRead ? [projectPath] : [])],
    [...ws.write, ...(canWrite ? [projectPath] : [])]
  );
  console.log(
    `${changed ? "WROTE" : "KEEP "}     identity/${role}/loadout.yaml (${canWrite ? "read+write" : "read"})`
  );
}

function updateOptionIndex(name) {
  return argv.indexOf(`--${name}`);
}
function option(name, fallback) {
  const i = updateOptionIndex(name);
  if (i < 0) return fallback;
  if (!argv[i + 1] || argv[i + 1].startsWith("--")) die(`--${name} thiếu giá trị`);
  return argv[i + 1];
}
function options(name) {
  const out = [];
  for (let i = 0; i < argv.length; i++)
    if (argv[i] === `--${name}`) {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) die(`--${name} thiếu giá trị`);
      out.push(argv[++i]);
    }
  return out;
}
function realOrResolved(p) {
  const abs = path.resolve(p);
  try { return fs.realpathSync(abs); } catch { return abs; }
}
function slugify(s) {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
function runNode(rel, args) {
  const file = path.join(repoRoot, rel);
  try {
    process.stdout.write(execFileSync(process.execPath, [file, ...args], { encoding: "utf8" }));
  } catch (e) {
    process.stdout.write((e.stdout || "") + (e.stderr || ""));
    die(`${rel} thất bại (exit ${e.status ?? "?"})`);
  }
}
function usage(code) {
  console.log("Usage: install-project <path> [--slug id] [--name name] [--summary text]");
  console.log("       [--read-role role]... [--write-role role]...");
  process.exit(code);
}
function die(message) { console.error(`ERROR     ${message}`); process.exit(2); }

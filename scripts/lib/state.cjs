// state.cjs — dựng và giữ `~/.alp`, phần dữ liệu KHÔNG đi theo thư mục cài.
//
// Chạy được ở mọi channel và chạy được nhiều lần: installer gọi nó sau khi giải nén, và
// `scripts/alp.cjs` gọi lại ở mỗi lần chạy lệnh. Đó là chủ ý — bản cài npm không có bước
// bootstrap nào bảo đảm sẽ chạy (`npm i -g --ignore-scripts` là chuyện bình thường), nên
// điều kiện tiên quyết phải tự dựng lấy ở lần dùng đầu tiên thay vì trông vào một bước cài.
//
// LUẬT DUY NHẤT: hàm ở đây chỉ biết TẠO cái còn thiếu và DI TRÚ cái nằm sai chỗ. Không hàm
// nào ghi đè nội dung đã có — memory mất là mất thật, remote không có bản sao để lấy lại.

"use strict";

const fs = require("fs");
const path = require("path");
const P = require("./install-paths.cjs");
const D = require("./delegation/config.cjs");

/**
 * @param {{ root: string, env?: NodeJS.ProcessEnv, version?: string }} options
 * @returns {{ stateHome: string, memoryRoot: string, channel: string, log: Array<{level: string, text: string}> }}
 */
function ensureState(options) {
  const root = path.resolve(options.root);
  const env = options.env || process.env;
  const log = [];
  const say = (level, text) => log.push({ level, text });

  const stateHome = P.stateHome(env);
  mkdirPrivate(stateHome);

  const channel = P.detectChannel(root);
  const memoryRoot = ensureMemory(root, env, say);
  ensureExecutions(env, say);
  ensureDelegation(root, env, channel, say);
  mkdirPrivate(P.agentsDir(env));

  P.writeInstallRecord(
    { root, channel, version: options.version ?? readVersion(root), updatedAt: new Date().toISOString() },
    env,
  );
  say("OK", `install record ${P.installRecordPath(env)} → ${channel} ${root}`);

  writeHookForwarders(root, env, say);
  repairProjectHooks(env, say);

  return { stateHome, memoryRoot, channel, log };
}

// ---------------------------------------------------------------------- memory

/**
 * `~/.alp/memory`, di trú từ chỗ cũ nếu cần rồi bù những file khung còn thiếu.
 *
 * Trước v0.9.0 memory nằm trong `<thư mục cài>/memory`. Chỗ đó giờ là artifact bị thay
 * nguyên khối mỗi lần update, nên để nguyên là hẹn ngày mất dữ liệu — di trú là bắt buộc,
 * không phải dọn dẹp cho gọn.
 */
function ensureMemory(root, env, say) {
  const target = P.memoryRoot(env);

  // "Chưa có memory ở chỗ mới" không phải là "thư mục chưa tồn tại": `alp doctor` và
  // MarkdownFileStore đều tạo sẵn thư mục và ghi vào đó một file index ẩn chỉ để kiểm tra
  // quyền ghi. Nếu coi đó là đã có dữ liệu thì di trú không bao giờ chạy, và người dùng lên
  // v0.9.0 xong mở ra thấy memory rỗng trong khi bản cũ vẫn nằm nguyên chỗ cũ.
  if (isEmptyish(target)) {
    const legacy = P.legacyMemoryRoots(root, env).find(
      (candidate) => candidate !== target && isDirectory(candidate) && !isEmptyish(candidate),
    );
    if (legacy) {
      fs.rmSync(target, { recursive: true, force: true });
      movePath(legacy, target);
      leaveBreadcrumb(legacy, target);
      say("MOVED", `memory ${legacy} → ${target}`);
    }
  }

  mkdirPrivate(target);
  const seed = path.join(root, "scaffold", "memory");
  if (!fs.existsSync(seed)) throw new Error(`thiếu ${seed} — bản cài hỏng, không dựng lại memory được`);

  const made = [];
  copyMissing(seed, target, target, made);
  for (const directory of [
    path.join(target, "shared", "decisions"),
    path.join(target, "shared", "people"),
    path.join(target, "shared", "reference"),
    path.join(target, "private"),
  ]) {
    if (fs.existsSync(directory)) continue;
    fs.mkdirSync(directory, { recursive: true });
    made.push(`${path.relative(target, directory)}/`);
  }

  if (made.length) for (const entry of made) say("WROTE", path.join(target, entry));
  else say("OK", `memory ${target} đã đủ khung — không đụng vào nội dung`);
  return target;
}

/**
 * Một dòng để lại chỗ cũ. Với dev clone, `memory/` biến mất khỏi repo là chuyện đủ lạ để
 * người dùng đi tìm; với bản cài thì thư mục này sắp bị xoá và dòng chữ vô hại.
 */
function leaveBreadcrumb(from, to) {
  try {
    fs.writeFileSync(
      `${from}.moved-to.txt`,
      `memory/ đã chuyển sang ${to} (alp-code >= v0.9.0).\nThư mục cài giờ là artifact thay được, không giữ dữ liệu người dùng.\n`,
      "utf8",
    );
  } catch { /* breadcrumb là tiện ích, không phải điều kiện thành công */ }
}

// ------------------------------------------------------------------ state khác

function ensureExecutions(env, say) {
  const root = P.executionsDir(env);
  mkdirPrivate(root);
  say("OK", `execution state ${root}`);
}

/**
 * State delegation. Mặc định cũ băm theo đường dẫn thư mục cài — hợp lý khi thư mục cài là
 * một clone cố định, vô nghĩa khi nó là artifact có thể nằm ở `versions/<tag>` khác nhau mỗi
 * bản. Bản cài dùng một thư mục chung; dev clone giữ nguyên khoá băm cũ để không mất state.
 */
function ensureDelegation(root, env, channel, say) {
  let config;
  try { config = D.loadDelegationConfig(root, env); }
  catch (error) { throw new Error(`delegation config không hợp lệ: ${error.message}`); }

  if (channel !== "dev" && !fs.existsSync(config.stateDir)) {
    const legacy = D.legacyStateDir(root, env);
    if (legacy !== config.stateDir && isDirectory(legacy)) {
      movePath(legacy, config.stateDir);
      say("MOVED", `delegation state ${legacy} → ${config.stateDir}`);
    }
  }

  mkdirPrivate(config.stateDir);
  say("OK", `delegation state ${config.stateDir}`);
}

// --------------------------------------------------------------- hook forwarder

/**
 * Sinh `~/.alp/hooks/<tên>.cjs` cho mọi hook trong thư mục cài.
 *
 * Forwarder tồn tại vì `<project>/.claude/settings.local.json` do `alp init` ghi phải trỏ tới
 * một đường dẫn KHÔNG đổi. Nó nằm trong repo của người dùng, sống lâu hơn mọi bản cài, và
 * không có bước nào đi sửa lại nó khi ALP lên version hay đổi channel.
 *
 * Ghi đè vô điều kiện: đây là file do ALP sinh, không phải dữ liệu người dùng, và nội dung
 * phải luôn khớp bản cài hiện hành.
 */
function writeHookForwarders(root, env, say) {
  const source = path.join(root, "hooks");
  if (!isDirectory(source)) throw new Error(`thiếu ${source} — bản cài hỏng`);
  const directory = P.hooksDir(env);
  mkdirPrivate(directory);

  const names = fs.readdirSync(source).filter((name) => name.endsWith(".cjs"));
  for (const name of names) {
    fs.writeFileSync(path.join(directory, name), forwarderSource(name), { encoding: "utf8", mode: 0o700 });
  }
  say("OK", `hook forwarder ${directory} (${names.join(", ")})`);
}

function forwarderSource(name) {
  return `#!/usr/bin/env node
// Sinh bởi alp-code — ĐỪNG SỬA TAY. Đường dẫn ổn định để cấu hình hook trong project của bạn
// sống sót qua đổi version và đổi channel cài; nó chỉ đọc bản cài hiện hành rồi gọi hook thật.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const record = path.join(__dirname, "..", "install.json");
let root;
try {
  root = JSON.parse(fs.readFileSync(record, "utf8")).root;
} catch (error) {
  process.stderr.write(\`alp-code: không đọc được \${record}: \${error.message}\\n\`);
  process.exit(0);
}

if (!process.env.ALP_REPO_ROOT) process.env.ALP_REPO_ROOT = root;
require(path.join(root, "hooks", ${JSON.stringify(name)}));
`;
}

/**
 * Sửa lại hook path trong những project đã `alp init` trước v0.9.0.
 *
 * Chúng đang trỏ thẳng vào thư mục cài cũ. Nếu bản cài đó bị npm thay hoặc bị gỡ, phiên
 * `claude` mở tay trong project sẽ mất identity mà không báo gì rõ ràng — hỏng câm, đúng
 * kiểu repo này tránh. Chỉ đụng vào file mang marker `alp init`; file của người dùng thì thôi.
 */
function repairProjectHooks(env, say) {
  const forwarder = P.hookForwarderPath("session-boot", env);
  const registry = path.join(P.stateHome(env), "projects.json");
  let projects;
  try { projects = JSON.parse(fs.readFileSync(registry, "utf8")).projects || []; }
  catch { return; }

  const repaired = [];
  for (const entry of projects) {
    const file = path.join(String(entry.path || ""), ".claude", "settings.local.json");
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch { continue; }
    if (parsed.$generatedBy !== "alp init") continue;

    const hooks = parsed.hooks?.SessionStart?.[0]?.hooks?.[0];
    if (!hooks || typeof hooks.command !== "string") continue;
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(forwarder)}`;
    if (hooks.command === command) continue;

    hooks.command = command;
    try {
      fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
      repaired.push(file);
    } catch { /* project chỉ đọc hoặc đã bị xoá — không đáng làm hỏng cả bước cài */ }
  }
  if (repaired.length) say("FIXED", `hook path trong ${repaired.length} project → ${forwarder}`);
}

// ------------------------------------------------------------------- tiện ích

function mkdirPrivate(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") { try { fs.chmodSync(directory, 0o700); } catch { /* không sở hữu */ } }
}

function isDirectory(candidate) {
  try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
}

/** Không có gì ngoài file ẩn (index cache dựng lại được) — tức là chưa có dữ liệu thật. */
function isEmptyish(directory) {
  try { return !fs.readdirSync(directory).some((entry) => !entry.startsWith(".")); }
  catch { return true; }
}

/** rename khi cùng volume, cp+rm khi khác volume (EXDEV) — `~` và thư mục cài không chắc cùng đĩa. */
function movePath(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
    return;
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
  }
  fs.cpSync(from, to, { recursive: true });
  fs.rmSync(from, { recursive: true, force: true });
}

function copyMissing(sourceDir, destinationDir, base, made) {
  fs.mkdirSync(destinationDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name);
    const destination = path.join(destinationDir, entry.name);
    if (entry.isDirectory()) copyMissing(source, destination, base, made);
    else if (!fs.existsSync(destination)) {
      fs.copyFileSync(source, destination);
      made.push(path.relative(base, destination));
    }
  }
}

function readVersion(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || null; }
  catch { return null; }
}

module.exports = { ensureState, ensureMemory, writeHookForwarders, repairProjectHooks, movePath };

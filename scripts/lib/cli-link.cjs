// cli-link.cjs — cài lệnh `alp` và đưa nó vào PATH cho terminal mở sau installer.
//
// MỤC TIÊU: chạy xong installer là gõ `alp` được, không phải đọc hướng dẫn thêm.
// Muốn vậy phải làm ĐỦ HAI VIỆC, thiếu một là hỏng:
//   1. có một file thực thi tên `alp` ở đâu đó
//   2. thư mục chứa nó nằm trong PATH của shell mà người dùng SẼ mở lần sau
//
// Trước đây chỉ làm việc (1) rồi in một câu khuyên cho việc (2). Trên macOS zsh mặc
// định KHÔNG có `~/.local/bin` trong PATH, nên "cài xong" thực tế là "cài xong một nửa".
//
// GHI VÀO SHELL PROFILE LÀ VIỆC PHẢI XIN PHÉP — và ở đây principal đã yêu cầu thẳng.
// Vẫn giữ ba phanh:
//   · chỉ APPEND, không bao giờ sửa/xoá dòng có sẵn
//   · bọc trong marker để chạy lại không nhân bản, và để gỡ ra được bằng tay
//   · `--no-path` (hoặc ALP_NO_PATH=1) tắt hẳn cho CI và cho người tự quản PATH
//
// Windows KHÔNG dùng symlink: `fs.symlinkSync` ở đó cần quyền admin hoặc Developer Mode.
// Thay bằng shim `.cmd` — không cần quyền gì — và ghi PATH ở tầng User qua PowerShell.
//
// ⚠️ Nhánh Windows CHƯA CHẠY THẬT trên máy Windows nào. Logic dựng path/nội dung shim có
// test (`test-cli-link.cjs`), nhưng việc `setx`-tương-đương có ăn hay không thì chưa đo.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const BEGIN = "# >>> alp-code >>>";
const END = "# <<< alp-code <<<";

/** Thư mục chứa lệnh `alp`, theo từng nền tảng. */
function binDir(env, platform) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (platform === "win32")
    return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "alp", "bin");
  return path.join(home, ".local", "bin");
}

/**
 * Nội dung shim `.cmd` cho Windows.
 *
 * `%*` giữ nguyên tham số; dấu ngoặc kép quanh đường dẫn để chịu được `C:\Program Files`.
 * CRLF vì `cmd.exe` không chạy nổi file chỉ có LF.
 */
function cmdShim(cliPath) {
  return ["@rem alp-code shim", "@echo off", `node "${cliPath}" %*`, ""].join("\r\n");
}

/**
 * File profile của shell hiện tại. Trả `null` khi không đoán được — thà im lặng còn hơn
 * ghi nhầm vào file của shell khác.
 */
function profileFor(env, platform) {
  const home = env.HOME || os.homedir();
  const shell = path.basename(env.SHELL || "");
  if (shell === "zsh") return { file: path.join(home, ".zshrc"), syntax: "posix" };
  if (shell === "fish")
    return { file: path.join(home, ".config", "fish", "config.fish"), syntax: "fish" };
  if (shell === "bash")
    // macOS: Terminal mở bash ở chế độ login ⇒ đọc .bash_profile, KHÔNG đọc .bashrc.
    // Linux: terminal thường là non-login ⇒ đọc .bashrc. Chọn sai file = ghi xong vẫn
    // không có PATH, và đó đúng là kiểu hỏng câm mà cả repo này đang tránh.
    return {
      file: path.join(home, platform === "darwin" ? ".bash_profile" : ".bashrc"),
      syntax: "posix",
    };
  return null;
}

/** Khối PATH sẽ append, có marker hai đầu. */
function pathBlock(dir, syntax) {
  const line =
    syntax === "fish"
      ? `fish_add_path ${dir}`
      : `export PATH="${dir}:$PATH"`;
  return `\n${BEGIN}\n${line}\n${END}\n`;
}

/** Thư mục `dir` đã nằm trong PATH của tiến trình hiện tại chưa. */
function onPath(dir, env, platform) {
  // Khi giả lập nhánh Windows trên macOS/Linux, `path.delimiter` vẫn là `:`. Chọn theo
  // platform được tiêm vào để test đúng dữ liệu PATH thật của Windows (`;`).
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  const parts = (env.PATH || env.Path || "").split(delimiter).filter(Boolean);
  const same = (a, b) =>
    platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  return parts.some((p) => same(path.resolve(p), path.resolve(dir)));
}

/**
 * Cài lệnh `alp`.
 *
 * @param {string} repoRoot  gốc repo alp-code
 * @param {object} opts
 *   · env, platform  — tiêm vào để test được nhánh Windows từ máy khác
 *   · skipPath       — chỉ tạo file thực thi, không đụng PATH
 *   · applyWindowsPath(dir) — cho test chặn lời gọi PowerShell thật
 * @returns {Array<{level:string, text:string}>} nhật ký để caller in ra
 */
function installCli(repoRoot, opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const skipPath = !!opts.skipPath;
  const log = [];
  const say = (level, text) => log.push({ level, text });

  // Stable bootstrap only; parsing and policy remain in dist/src/cli/alp.js.
  const cli = path.join(repoRoot, "scripts", "alp.cjs");
  const dir = binDir(env, platform);
  const target = path.join(dir, platform === "win32" ? "alp.cmd" : "alp");

  try {
    fs.mkdirSync(dir, { recursive: true });
    if (platform === "win32") writeShim(target, cli, say);
    else linkUnix(target, cli, say);
  } catch (e) {
    say("SKIP", `không tạo được ${target} (${e.message}) — chạy trực tiếp: node ${cli}`);
    return log;
  }

  if (onPath(dir, env, platform)) {
    say("OK", `${dir} đã có trong PATH — gõ \`alp\` là chạy`);
    return log;
  }
  if (skipPath) {
    say("PATH", `${dir} chưa trong PATH; bỏ qua theo --no-path — tự thêm rồi mở terminal mới`);
    return log;
  }

  if (platform === "win32") addWindowsPath(dir, env, opts, say);
  else addPosixPath(dir, env, platform, say);
  return log;
}

/**
 * Gỡ lệnh `alp` và phần PATH do installCli tạo.
 *
 * Chỉ xoá shim/link nếu nó còn trỏ đúng repo này. Một file `alp` của người dùng hoặc của
 * clone alp-code khác là FOREIGN — giữ nguyên và không rút PATH chuyên dụng trên Windows.
 */
function uninstallCli(repoRoot, opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const log = [];
  const say = (level, text) => log.push({ level, text });
  const cli = path.join(repoRoot, "scripts", "alp.cjs");
  const dir = binDir(env, platform);
  const target = path.join(dir, platform === "win32" ? "alp.cmd" : "alp");
  let foreign = false;

  if (fs.existsSync(target) || isBrokenLink(target)) {
    if (ownsCommand(target, cli, platform)) {
      fs.rmSync(target);
      say("REMOVED", target);
    } else {
      foreign = true;
      say("KEEP", `${target} — không phải lệnh của repo alp-code này`);
    }
  } else {
    say("ABSENT", target);
  }

  if (platform === "win32") {
    if (!foreign) {
      removeWindowsPath(dir, env, opts, say);
      removeFromProcessPath(dir, env, platform);
      removeEmptyDir(dir);
      removeEmptyDir(path.dirname(dir));
    }
  } else {
    for (const file of profileCandidates(env)) {
      if (!fs.existsSync(file)) continue;
      const before = fs.readFileSync(file, "utf8");
      const after = stripPathBlock(before);
      if (after === before) continue;
      fs.writeFileSync(file, after);
      say("WROTE", `${file} — gỡ khối PATH của alp-code`);
    }
    removeFromProcessPath(dir, env, platform);
  }
  return log;
}

// ---------------------------------------------------------------- file thực thi

function linkUnix(link, cli, say) {
  try { fs.chmodSync(cli, 0o755); } catch {}

  const exists = fs.existsSync(link) || isBrokenLink(link);
  if (!exists) {
    fs.symlinkSync(cli, link);
    return say("LINKED", `${link} → ${cli}`);
  }

  const current = fs.lstatSync(link).isSymbolicLink() ? fs.readlinkSync(link) : null;
  if (current === cli) return say("OK", `${link} → ${cli}`);
  if (current === null)
    // File thật của người khác trùng tên — không đụng, chỉ nói.
    throw new Error(`${link} đã tồn tại và không phải symlink của alp-code`);

  fs.rmSync(link);
  fs.symlinkSync(cli, link);
  say("LINKED", `${link} → ${cli} (trỏ lại từ ${current})`);
}

function writeShim(target, cli, say) {
  const body = cmdShim(cli);
  if (fs.existsSync(target)) {
    const current = fs.readFileSync(target, "utf8");
    if (current === body) return say("OK", `${target} → ${cli}`);
    if (!current.startsWith("@rem alp-code shim\r\n"))
      throw new Error(`${target} đã tồn tại và không phải shim của alp-code`);
  }
  fs.writeFileSync(target, body);
  say("WROTE", `${target} → ${cli}`);
}

function ownsCommand(target, cli, platform) {
  if (platform === "win32") {
    try { return fs.readFileSync(target, "utf8") === cmdShim(cli); } catch { return false; }
  }
  try {
    if (!fs.lstatSync(target).isSymbolicLink()) return false;
    return path.resolve(path.dirname(target), fs.readlinkSync(target)) === path.resolve(cli);
  } catch {
    return false;
  }
}

function isBrokenLink(p) {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

// ---------------------------------------------------------------- PATH

function addPosixPath(dir, env, platform, say) {
  const prof = profileFor(env, platform);
  if (!prof) {
    const shell = env.SHELL || "(không rõ)";
    return say("PATH", `không đoán được profile của shell ${shell} — tự thêm: export PATH="${dir}:$PATH"`);
  }

  let body = "";
  if (fs.existsSync(prof.file)) body = fs.readFileSync(prof.file, "utf8");
  if (body.includes(BEGIN))
    return say("OK", `${prof.file} đã có khối PATH của alp-code — mở terminal mới là gõ \`alp\` được`);

  fs.mkdirSync(path.dirname(prof.file), { recursive: true });
  fs.appendFileSync(prof.file, pathBlock(dir, prof.syntax));
  say("WROTE", `${prof.file} — thêm ${dir} vào PATH (khối có marker, gỡ tay được)`);
  say("PATH", `mở terminal mới, hoặc: source ${prof.file}`);
}

/**
 * Ghi PATH ở tầng User của Windows.
 *
 * Đọc/ghi qua `[Environment]::…("Path", …, "User")` chứ KHÔNG dùng `setx`: setx cắt cụt
 * giá trị ở 1024 ký tự, và PATH của một máy dùng lâu thì gần như chắc chắn dài hơn thế —
 * mất PATH là hỏng cả máy, không chỉ hỏng alp.
 */
function addWindowsPath(dir, env, opts, say) {
  const apply = opts.applyWindowsPath || applyWindowsPathReal;
  try {
    const r = apply(dir);
    if (r === "present") say("OK", `${dir} đã có trong PATH (User) — mở terminal mới là gõ \`alp\` được`);
    else say("WROTE", `PATH (User) += ${dir} — mở terminal mới là gõ \`alp\` được`);
  } catch (e) {
    say("PATH", `không ghi được PATH (${e.message}) — tự thêm ${dir} vào PATH của User`);
  }
}

function removeWindowsPath(dir, env, opts, say) {
  const apply = opts.removeWindowsPath || removeWindowsPathReal;
  try {
    const r = apply(dir);
    if (r === "absent") say("OK", `${dir} không còn trong PATH (User)`);
    else say("WROTE", `PATH (User) -= ${dir}`);
  } catch (e) {
    say("WARN", `không gỡ được PATH (User) (${e.message}) — tự gỡ ${dir}`);
  }
}

function applyWindowsPathReal(dir) {
  // -NoProfile: profile của người dùng có thể in ra thứ khác, làm bẩn stdout ta đang đọc.
  const ps = [
    "$d = $env:ALP_BIN_DIR",
    '$cur = [Environment]::GetEnvironmentVariable("Path", "User")',
    'if ($null -eq $cur) { $cur = "" }',
    '$parts = $cur.Split(";") | Where-Object { $_ -ne "" }',
    'if ($parts -contains $d) { Write-Output "present"; exit 0 }',
    '$new = if ($cur -eq "") { $d } else { $cur.TrimEnd(";") + ";" + $d }',
    '[Environment]::SetEnvironmentVariable("Path", $new, "User")',
    'Write-Output "added"',
  ].join("; ");

  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    encoding: "utf8",
    env: { ...process.env, ALP_BIN_DIR: dir },
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error((r.stderr || "").trim() || `powershell exit ${r.status}`);
  return (r.stdout || "").trim();
}

function removeWindowsPathReal(dir) {
  const ps = windowsRemovePathScript();

  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    encoding: "utf8",
    env: { ...process.env, ALP_BIN_DIR: dir },
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error((r.stderr || "").trim() || `powershell exit ${r.status}`);
  return (r.stdout || "").trim();
}

function windowsRemovePathScript() {
  return [
    "$d = $env:ALP_BIN_DIR.TrimEnd('\\')",
    '$cur = [Environment]::GetEnvironmentVariable("Path", "User")',
    'if ([string]::IsNullOrEmpty($cur)) { Write-Output "absent"; exit 0 }',
    '$parts = @($cur.Split(";") | Where-Object { $_ -ne "" })',
    '$keep = @($parts | Where-Object { $_.TrimEnd("\\") -ine $d })',
    'if ($keep.Count -eq $parts.Count) { Write-Output "absent"; exit 0 }',
    '[Environment]::SetEnvironmentVariable("Path", ($keep -join ";"), "User")',
    'Write-Output "removed"',
  ].join("; ");
}

function profileCandidates(env) {
  const home = env.HOME || os.homedir();
  return [
    path.join(home, ".zshrc"),
    path.join(home, ".bash_profile"),
    path.join(home, ".bashrc"),
    path.join(home, ".config", "fish", "config.fish"),
  ];
}

function stripPathBlock(body) {
  const escapedBegin = BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedEnd = END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return body.replace(new RegExp(`(?:\\r?\\n)?${escapedBegin}\\r?\\n[\\s\\S]*?${escapedEnd}(?:\\r?\\n)?`, "g"), "\n");
}

function removeFromProcessPath(dir, env, platform) {
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  const key = Object.prototype.hasOwnProperty.call(env, "Path") ? "Path" : "PATH";
  const wanted = platform === "win32" ? dir.toLowerCase() : dir;
  env[key] = (env[key] || "")
    .split(delimiter)
    .filter(Boolean)
    .filter((entry) => (platform === "win32" ? entry.toLowerCase() : entry) !== wanted)
    .join(delimiter);
}

function removeEmptyDir(dir) {
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {}
}

module.exports = {
  installCli,
  uninstallCli,
  binDir,
  cmdShim,
  profileFor,
  pathBlock,
  onPath,
  stripPathBlock,
  windowsRemovePathScript,
  BEGIN,
  END,
};

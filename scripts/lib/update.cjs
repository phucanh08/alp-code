// `alp update`, một đường cho mỗi kiểu cài. Kiểu cài quyết định cách cập nhật, và cả ba đường
// đều KHÔNG build gì trên máy người dùng nữa:
//
//   npm      — `npm install -g alp-code@<version>`; npm lo cả code lẫn dependency.
//   tarball  — tải bundle của GitHub Release, giải nén sang `versions/<tag>` rồi trỏ lại
//              `current`. Thư mục cũ còn nguyên tới khi bản mới đứng được.
//   dev      — clone của người phát triển: vẫn checkout tag rồi build tại chỗ, vì đó chính là
//              thứ một dev clone dùng để làm việc.
//
// Không còn bước backup/restore memory quanh update: từ v0.9.0 memory và mọi state khác nằm ở
// `~/.alp`, ngoài tầm với của thứ đang bị thay. Chép dữ liệu qua lại quanh một thao tác không
// đụng tới nó chỉ thêm một đường có thể hỏng.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const semver = require("./semver-lite.cjs");
const P = require("./install-paths.cjs");

const REPO_SLUG = "phucanh08/alp-code";

function assertCleanWorkingTree(repoRoot, env) {
  const staged = gitLines(repoRoot, ["diff", "--cached", "--name-only"], env);
  if (!staged.ok) return failure(`không kiểm tra được staged changes: ${staged.message}`);
  if (staged.lines.length)
    return failure(`repo có staged changes; không tự cất: ${staged.lines.join(", ")}`);

  const dirty = gitLines(repoRoot, ["diff", "--name-only"], env);
  if (!dirty.ok) return failure(`không kiểm tra được working tree: ${dirty.message}`);

  if (dirty.lines.length) return failure(`repo có tracked changes; không tự cất: ${dirty.lines.join(", ")}`);
  return { ok: true };
}

async function resolveLatestReleaseTag(repoRoot, options = {}) {
  const repoSlug = options.repoSlug || REPO_SLUG;
  const fetchImpl = options.fetch || globalThis.fetch;
  if (fetchImpl) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs || 5000);
      const response = await fetchImpl(`https://api.github.com/repos/${repoSlug}/releases/latest`, {
        signal: controller.signal,
        headers: { "User-Agent": "alp-code-updater" },
      });
      clearTimeout(timer);
      if (response.ok) {
        const body = await response.json();
        if (body && typeof body.tag_name === "string" && semver.isValid(body.tag_name)) {
          return { ok: true, tag: body.tag_name, source: "github-api" };
        }
      }
    } catch {
      /* fall through to git-based fallback */
    }
  }
  // `git ls-remote` chỉ là lối thoát cho dev clone. Bản cài từ npm hay tarball không có `.git`
  // nào cả, nên hỏi git ở đó chắc chắn hỏng — và hỏng bằng một thông báo của git, che mất lý
  // do thật là không gọi được GitHub API.
  const remote = options.remote || "origin";
  if (!fs.existsSync(path.join(repoRoot, ".git")))
    return { ok: false, message: "không hỏi được GitHub Releases (mạng?) và bản cài này không phải git clone để tra tag" };
  const listed = gitText(repoRoot, ["ls-remote", "--tags", "--refs", remote], options.env || process.env);
  if (!listed.ok) return { ok: false, message: `không lấy được danh sách tag: ${listed.message}` };
  const tags = listed.text
    .split(/\r?\n/)
    .map((line) => line.split("refs/tags/")[1])
    .filter(Boolean)
    .filter((tag) => semver.isValid(tag));
  if (!tags.length) return { ok: false, message: "không tìm thấy tag phiên bản (vX.Y.Z) trên remote" };
  tags.sort(semver.compare);
  return { ok: true, tag: tags[tags.length - 1], source: "git-ls-remote" };
}

/**
 * Git and npm are chatty, and `alp update` is a one-line errand: say which version you moved
 * to, not every object counted and every package linked. Output is captured by default so a
 * successful run stays quiet — `commandFailure` reads the same captured streams, so a failure
 * still reports exactly what the tool said. `verbose: true` puts the firehose back, which is
 * what the installers want and what a broken build needs.
 */
function quietStdio(options) {
  return options.stdio || (options.verbose ? "inherit" : ["ignore", "pipe", "pipe"]);
}

function packageVersion(repoRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version || null;
  } catch {
    return null;
  }
}

async function checkoutLatestRelease(repoRoot, options = {}) {
  const env = options.env || process.env;
  const stdio = quietStdio(options);
  const log = options.log || (() => {});

  const clean = assertCleanWorkingTree(repoRoot, env);
  if (!clean.ok) return clean;
  log("CHECK", "tracked source clean; machine-local project registry is outside git");

  const remote = options.remote || "origin";
  const fetched = runGit(repoRoot, ["fetch", "--tags", "--force", remote], { env, stdio });
  if (!succeeded(fetched)) return failure(commandFailure("git fetch --tags", fetched));

  const resolved = options.pinTag
    ? { ok: true, tag: options.pinTag.startsWith("v") ? options.pinTag : `v${options.pinTag}`, source: "pinned" }
    : await (options.resolveLatestReleaseTag || resolveLatestReleaseTag)(repoRoot, options);
  if (!resolved.ok) return failure(resolved.message);

  log("CHECKOUT", `${resolved.tag} (${resolved.source})`);
  const checkedOut = runGit(repoRoot, ["checkout", "--detach", resolved.tag], { env, stdio });
  if (!succeeded(checkedOut)) return failure(commandFailure(`git checkout ${resolved.tag}`, checkedOut));
  return { ok: true, status: 0, tag: resolved.tag, source: resolved.source, preserved: [] };
}

/**
 * `alp update` — chọn đường theo kiểu cài rồi đi.
 *
 * `options.channel` chỉ để test ép nhánh; ngoài đời kiểu cài đọc được từ chính thư mục cài,
 * vì cùng một cây file đi cả npm lẫn tarball nên chỉ vị trí mới phân biệt được chúng.
 */
async function updateInstallation(repoRoot, options = {}) {
  const channel = options.channel || P.detectChannel(repoRoot);
  if (channel === "npm") return updateNpmInstall(repoRoot, options);
  if (channel === "tarball") return updateTarballInstall(repoRoot, options);
  return updateDevClone(repoRoot, options);
}

/** Version đích cho một bản cài, sau khi hỏi GitHub Release (hoặc theo `--version` đã ghim). */
async function resolveTarget(repoRoot, options) {
  const from = packageVersion(repoRoot);
  const resolved = options.pinTag
    ? { ok: true, tag: normalizeTag(options.pinTag), source: "pinned" }
    : await (options.resolveLatestReleaseTag || resolveLatestReleaseTag)(repoRoot, options);
  if (!resolved.ok) return { ok: false, message: resolved.message };
  return { ok: true, from, tag: resolved.tag, version: resolved.tag.replace(/^v/, ""), source: resolved.source };
}

function normalizeTag(tag) {
  return String(tag).startsWith("v") ? String(tag) : `v${tag}`;
}

/**
 * Chạy `ensure-state.cjs` bằng một tiến trình MỚI trên thư mục cài MỚI.
 *
 * Không gọi thẳng `ensureState()` trong tiến trình này được: code đang chạy đến từ thư mục vừa
 * bị thay, `require` một file chưa nạp sẽ đọc trúng bản đã bị xoá hoặc bản nửa cũ nửa mới.
 */
function runEnsureState(root, options) {
  const spawnProcess = options.spawnProcess || spawnSync;
  const result = spawnProcess(process.execPath, [path.join(root, "scripts", "ensure-state.cjs"), "--quiet"], {
    cwd: root,
    env: options.env || process.env,
    stdio: quietStdio(options),
  });
  return succeeded(result) ? { ok: true } : failure(commandFailure("ensure-state.cjs", result));
}

// ------------------------------------------------------------------ channel npm

async function updateNpmInstall(repoRoot, options = {}) {
  const target = await resolveTarget(repoRoot, options);
  if (!target.ok) return failure(target.message);
  if (target.from === target.version && !options.force)
    return { ok: true, tag: target.tag, from: target.from, to: target.from, channel: "npm", unchanged: true };

  (options.onCheckout || (() => {}))({ from: target.from, tag: target.tag });
  const runCommand = options.runCommand || spawnCommand;
  const installed = runCommand("npm", ["install", "--global", `alp-code@${target.version}`], {
    env: options.env || process.env,
    stdio: quietStdio(options),
  });
  if (!succeeded(installed)) {
    const detail = commandFailure("npm install -g", installed);
    return failure(/EACCES|permission denied/i.test(detail)
      ? `npm không ghi được vào thư mục global: ${detail}\n         Sửa quyền (npm config set prefix ~/.npm-global) hoặc cài lại bằng installer tarball.`
      : detail);
  }

  const ensured = runEnsureState(repoRoot, options);
  if (!ensured.ok) return ensured;
  return { ok: true, tag: target.tag, from: target.from, to: packageVersion(repoRoot) || target.version, channel: "npm" };
}

// -------------------------------------------------------------- channel tarball

/** `~/.alp-code` suy từ thư mục cài: `<home>/versions/<tag>` hoặc chính nó nếu layout cũ. */
function tarballHomeFor(repoRoot, env) {
  const resolved = path.resolve(repoRoot);
  const parent = path.dirname(resolved);
  return path.basename(parent) === "versions" ? path.dirname(parent) : resolved;
}

function bundleAssetName(tag) {
  return `alp-code-${tag}-bundle.tar.gz`;
}

function bundleUrl(tag, options = {}) {
  return `https://github.com/${options.repoSlug || REPO_SLUG}/releases/download/${tag}/${bundleAssetName(tag)}`;
}

async function updateTarballInstall(repoRoot, options = {}) {
  const target = await resolveTarget(repoRoot, options);
  if (!target.ok) return failure(target.message);
  if (target.from === target.version && !options.force)
    return { ok: true, tag: target.tag, from: target.from, to: target.from, channel: "tarball", unchanged: true };

  (options.onCheckout || (() => {}))({ from: target.from, tag: target.tag });
  const home = options.tarballHome ? path.resolve(options.tarballHome) : tarballHomeFor(repoRoot, options.env || process.env);
  const installed = await installBundle(home, target.tag, options);
  if (!installed.ok) return installed;

  const ensured = runEnsureState(installed.root, options);
  if (!ensured.ok) return ensured;
  pruneVersions(home, [path.basename(installed.root), path.basename(path.resolve(repoRoot))]);
  return { ok: true, tag: target.tag, from: target.from, to: target.version, channel: "tarball", root: installed.root };
}

/**
 * Tải bundle về, giải nén sang một thư mục MỚI, rồi mới trỏ `current` sang đó.
 *
 * Thứ tự này là điểm mấu chốt: bản đang chạy không bị đụng tới cho đến khi bản mới đã nằm đủ
 * trên đĩa. Tải dở giữa chừng hay tar hỏng thì `current` vẫn trỏ vào bản cũ và người dùng vẫn
 * còn một `alp` chạy được — thay tại chỗ thì hỏng giữa chừng là mất luôn cả hai.
 */
async function installBundle(home, tag, options = {}) {
  const versions = path.join(home, "versions");
  const destination = path.join(versions, tag);
  const staging = path.join(versions, `.incoming-${tag}-${process.pid}`);
  fs.mkdirSync(versions, { recursive: true });
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  const archive = path.join(versions, `.${tag}-${process.pid}.tar.gz`);
  try {
    const downloaded = await downloadFile(bundleUrl(tag, options), archive, options);
    if (!downloaded.ok) return failure(downloaded.message);

    const extracted = (options.runCommand || spawnCommand)("tar", ["-xzf", archive, "-C", staging], {
      stdio: quietStdio(options),
      env: options.env || process.env,
    });
    if (!succeeded(extracted)) return failure(commandFailure("tar -xzf", extracted));
    if (!fs.existsSync(path.join(staging, "scripts", "alp.cjs")))
      return failure(`bundle ${bundleAssetName(tag)} không đúng cấu trúc — thiếu scripts/alp.cjs`);

    fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(staging, destination);
  } finally {
    fs.rmSync(archive, { force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }

  const pointed = pointCurrent(home, destination);
  if (!pointed.ok) return pointed;
  return { ok: true, root: destination };
}

/**
 * `<home>/current` → version đang dùng, thay bằng rename nên không có khoảnh khắc nào nó
 * không trỏ đi đâu cả. Windows dùng junction: symlink thư mục ở đó cần quyền admin hoặc
 * Developer Mode, junction thì không cần gì.
 */
function pointCurrent(home, target) {
  const link = path.join(home, "current");
  const temporary = path.join(home, `.current-${process.pid}`);
  const type = process.platform === "win32" ? "junction" : "dir";
  try {
    fs.rmSync(temporary, { recursive: true, force: true });
    fs.symlinkSync(target, temporary, type);
    fs.rmSync(link, { recursive: true, force: true });
    fs.renameSync(temporary, link);
    return { ok: true, link };
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    return failure(`không trỏ được ${link} sang ${target}: ${error.message}`);
  }
}

/** Giữ bản đang chạy và bản vừa cài, dọn phần còn lại — đủ để lùi một bước, không hơn. */
function pruneVersions(home, keep) {
  const versions = path.join(home, "versions");
  let entries;
  try { entries = fs.readdirSync(versions); } catch { return; }
  for (const entry of entries) {
    if (keep.includes(entry)) continue;
    if (entry.startsWith(".incoming-")) { fs.rmSync(path.join(versions, entry), { recursive: true, force: true }); continue; }
    if (!semver.isValid(entry)) continue;
    fs.rmSync(path.join(versions, entry), { recursive: true, force: true });
  }
}

async function downloadFile(url, destination, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (!fetchImpl) return { ok: false, message: "Node này không có fetch — cần Node >= 18" };
  try {
    const response = await fetchImpl(url, { headers: { "User-Agent": "alp-code-updater" }, redirect: "follow" });
    if (!response.ok) return { ok: false, message: `tải ${url} thất bại (HTTP ${response.status})` };
    fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
    return { ok: true };
  } catch (error) {
    return { ok: false, message: `tải ${url} thất bại: ${error.message}` };
  }
}

// ------------------------------------------------------------------ channel dev

async function updateDevClone(repoRoot, options = {}) {
  const from = packageVersion(repoRoot);
  const checkedOut = await checkoutLatestRelease(repoRoot, options);
  if (!checkedOut.ok) return checkedOut;
  (options.onCheckout || (() => {}))({ from, tag: checkedOut.tag });

  const spawnProcess = options.spawnProcess || spawnSync;
  const built = spawnProcess(process.execPath, [path.join(repoRoot, "scripts", "bootstrap.cjs"), "--no-path"], {
    cwd: repoRoot,
    env: options.env || process.env,
    stdio: quietStdio(options),
  });
  return succeeded(built)
    ? { ...checkedOut, from, to: packageVersion(repoRoot), channel: "dev" }
    : failure(commandFailure("bootstrap.cjs", built));
}

function spawnCommand(command, args, options) {
  const { spawnSyncCommand } = require("./delegation/command-runner.cjs");
  return spawnSyncCommand(command, args, options);
}

function onlyWorkspaceChanged(base, current) {
  const normalizedBase = normalizeNewlines(base);
  const normalizedCurrent = normalizeNewlines(current);
  const workspacePattern = /^workspaces:\s*$\n(?:^[ \t]+.*(?:\n|$))*/m;
  if (!workspacePattern.test(normalizedBase) || !workspacePattern.test(normalizedCurrent)) return false;
  return normalizedBase.replace(workspacePattern, "workspaces:\n") ===
    normalizedCurrent.replace(workspacePattern, "workspaces:\n");
}

function gitLines(repoRoot, args, env) {
  const result = gitText(repoRoot, args, env);
  return result.ok
    ? { ok: true, lines: result.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) }
    : result;
}

function gitText(repoRoot, args, env) {
  const result = runGit(repoRoot, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return succeeded(result)
    ? { ok: true, text: String(result.stdout || "") }
    : { ok: false, message: commandFailure(`git ${args.join(" ")}`, result) };
}

function runGit(repoRoot, args, options) {
  return spawnSync("git", ["-C", repoRoot, ...args], options);
}

function commandFailure(command, result) {
  return String(result?.stderr || result?.stdout || result?.error?.message || `${command} exit ${result?.status}`).trim();
}

function succeeded(result) {
  return !result.error && result.status === 0;
}

function failure(message) {
  return { ok: false, status: 1, message, preserved: [] };
}

function normalizeNewlines(text) {
  return String(text).replace(/\r\n/g, "\n");
}

module.exports = {
  onlyWorkspaceChanged,
  packageVersion,
  assertCleanWorkingTree,
  resolveLatestReleaseTag,
  checkoutLatestRelease,
  updateInstallation,
  updateNpmInstall,
  updateTarballInstall,
  updateDevClone,
  installBundle,
  pointCurrent,
  pruneVersions,
  tarballHomeFor,
  bundleAssetName,
  bundleUrl,
};

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");
const { archiveName, resolveTarget } = require("./resolve-target.cjs");

const MAX_DOWNLOAD = 256 * 1024 * 1024;
const MAX_EXTRACTED = 1024 * 1024 * 1024;

function parseChecksums(text) {
  const values = new Map();
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const match = /^([a-fA-F0-9]{64})\s+\*?([^/\\]+)$/.exec(raw.trim());
    if (!match) throw new Error(`invalid SHA256SUMS line: ${raw.slice(0, 100)}`);
    values.set(match[2], match[1].toLowerCase());
  }
  return values;
}

async function download(url, fetcher) {
  let response;
  try { response = await fetcher(url, { redirect: "follow", signal: AbortSignal.timeout(15_000) }); }
  catch (error) { throw new Error(`cannot download ${url}: ${error.message}`); }
  if (!response.ok) throw new Error(`cannot download ${url}: HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_DOWNLOAD) throw new Error(`download too large: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_DOWNLOAD) throw new Error(`download too large: ${url}`);
  return bytes;
}

function field(block, start, end) { return block.subarray(start, end).toString("utf8").replace(/\0.*$/s, "").trim(); }
function octal(block, start, end) { const value = field(block, start, end).replace(/^0+/, ""); return value ? Number.parseInt(value, 8) : 0; }

function safeName(raw, link) {
  if (!raw || path.posix.isAbsolute(raw) || raw.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(raw) || raw.includes("\\")) throw new Error(`unsafe archive path: ${raw}`);
  const name = path.posix.normalize(raw.replace(/^\.\//, "").replace(/\/$/, ""));
  if (!name || name === "." || name === ".." || name.startsWith("../") || name.split("/").includes("..")) throw new Error(`unsafe archive path: ${raw}`);
  if (link !== undefined) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), link));
    if (!link || path.posix.isAbsolute(link) || link.includes("\\") || resolved === ".." || resolved.startsWith("../")) throw new Error(`unsafe archive link: ${raw} -> ${link}`);
  }
  return name;
}

function extract(bytes, destination) {
  const tar = zlib.gunzipSync(bytes, { maxOutputLength: MAX_EXTRACTED });
  let total = 0;
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const raw = [field(header, 345, 500), field(header, 0, 100)].filter(Boolean).join("/");
    const size = octal(header, 124, 136);
    const mode = octal(header, 100, 108);
    const flag = field(header, 156, 157) || "0";
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (!Number.isSafeInteger(size) || contentEnd > tar.length) throw new Error(`corrupt tar entry: ${raw}`);
    offset = contentStart + Math.ceil(size / 512) * 512;
    if (flag === "x" || flag === "g") continue;
    if (!["0", "5", "2"].includes(flag)) throw new Error(`unsupported tar entry type ${flag}: ${raw}`);
    if ((raw === "." || raw === "./") && flag === "5") continue;
    const link = flag === "2" ? field(header, 157, 257) : undefined;
    const name = safeName(raw, link);
    total += size;
    if (total > MAX_EXTRACTED) throw new Error("archive expands beyond 1 GiB");
    const output = path.resolve(destination, name);
    if (path.relative(path.resolve(destination), output).startsWith("..")) throw new Error(`archive path escapes cache: ${name}`);
    if (flag === "5") fs.mkdirSync(output, { recursive: true, mode: mode || 0o755 });
    else if (flag === "2") { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.symlinkSync(link, output); }
    else {
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, tar.subarray(contentStart, contentEnd), { flag: "wx", mode: mode || 0o644 });
      if (process.platform !== "win32") fs.chmodSync(output, mode || 0o644);
    }
  }
}

function validate(root, version, target) {
  const file = path.join(root, "install-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.app !== "alp-code" || manifest.version !== version || manifest.target !== target.id) {
    throw new Error(`payload manifest mismatch in ${file}`);
  }
  for (const directory of ["skills", "scaffold"]) if (!fs.statSync(path.join(root, directory)).isDirectory()) throw new Error(`payload missing ${directory}`);
  const executable = path.join(root, "bin", target.executable);
  const smoke = spawnSync(executable, ["--version"], { encoding: "utf8", env: { ...process.env, ALP_SKIP_UPDATE_CHECK: "1" } });
  if (smoke.error || smoke.status !== 0 || smoke.stdout.trim() !== `alp ${version}`) throw new Error(`payload smoke failed for ${executable}`);
  return executable;
}

function acquireLock(cache) {
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  const file = path.join(cache, ".install.lock");
  try { return { file, descriptor: fs.openSync(file, "wx", 0o600) }; }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    try { if (Date.now() - fs.statSync(file).mtimeMs > 10 * 60 * 1000) fs.rmSync(file); } catch {}
    try { return { file, descriptor: fs.openSync(file, "wx", 0o600) }; }
    catch { throw new Error(`another alp-code npm payload install holds ${file}`); }
  }
}

async function ensurePayload(options = {}) {
  const pkg = options.packageDocument || require("../package.json");
  const version = pkg.version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`invalid alp-code npm package version: ${version}`);
  const target = options.target || resolveTarget();
  const home = options.home || process.env.HOME || process.env.USERPROFILE;
  if (!home) throw new Error("cannot resolve user home for alp-code payload cache");
  const cache = path.resolve(options.cache || process.env.ALP_NPM_CACHE || path.join(home, ".alp-code", "npm"));
  const destination = path.join(cache, "versions", version, target.id);
  try { return { root: destination, executable: validate(destination, version, target), target }; }
  catch (error) { if (fs.existsSync(destination)) throw new Error(`cached ALP payload is invalid: ${error.message}`); }

  const lock = acquireLock(cache);
  const staging = path.join(cache, `.staging-${version}-${target.id}-${process.pid}-${Date.now()}`);
  try {
    try { return { root: destination, executable: validate(destination, version, target), target }; }
    catch (error) { if (fs.existsSync(destination)) throw new Error(`cached ALP payload is invalid: ${error.message}`); }
    const filename = archiveName(version, target.id);
    const base = options.baseUrl || process.env.ALP_RELEASE_BASE_URL || `https://github.com/phucanh08/alp-code/releases/download/v${version}`;
    const fetcher = options.fetcher || fetch;
    const [checksums, archive] = await Promise.all([download(`${base}/SHA256SUMS`, fetcher), download(`${base}/${filename}`, fetcher)]);
    const expected = parseChecksums(checksums.toString("utf8")).get(filename);
    if (!expected) throw new Error(`checksum missing for ${filename}`);
    const actual = crypto.createHash("sha256").update(archive).digest("hex");
    if (actual !== expected) throw new Error(`checksum mismatch for ${filename}`);
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    extract(archive, staging);
    const executable = validate(staging, version, target);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.renameSync(staging, destination);
    return { root: destination, executable: path.join(destination, path.relative(staging, executable)), target };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.closeSync(lock.descriptor);
    fs.rmSync(lock.file, { force: true });
  }
}

module.exports = { parseChecksums, safeName, extract, validate, ensurePayload };

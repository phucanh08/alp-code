import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024;
// Native archives run 25-40MB today (cap MAX_DOWNLOAD_BYTES above). The same signal aborts the
// body read, not just the initial response, so it has to cover the whole transfer — 15s only
// works above ~2.5MB/s and aborted real updates on ordinary connections.
const DOWNLOAD_TIMEOUT_MS = 120_000;

export function parseChecksums(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([a-fA-F0-9]{64})\s+\*?([^/\\]+)$/.exec(line.trim());
    if (!match) throw new Error(`invalid SHA256SUMS line: ${line.slice(0, 120)}`);
    result.set(match[2], match[1].toLowerCase());
  }
  return result;
}

export function verifyArchiveChecksum(bytes: Uint8Array, filename: string, checksums: ReadonlyMap<string, string>): void {
  const expected = checksums.get(filename);
  if (!expected) throw new Error(`checksum is missing for ${filename}`);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error(`checksum mismatch for ${filename}: expected ${expected}, got ${actual}`);
}

export function validateArchivePath(name: string, symlinkTarget?: string): string {
  if (!name || isAbsolute(name) || name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(name) || name.includes("\\")) {
    throw new Error(`unsafe archive path: ${name}`);
  }
  const normalized = posix.normalize(name.replace(/^\.\//, "").replace(/\/$/, ""));
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.split("/").includes("..")) {
    throw new Error(`unsafe archive path: ${name}`);
  }
  if (symlinkTarget !== undefined) {
    if (!symlinkTarget || posix.isAbsolute(symlinkTarget) || symlinkTarget.includes("\\")) {
      throw new Error(`unsafe archive symlink: ${name} -> ${symlinkTarget}`);
    }
    const resolved = posix.normalize(posix.join(posix.dirname(normalized), symlinkTarget));
    if (resolved === ".." || resolved.startsWith("../")) throw new Error(`unsafe archive symlink: ${name} -> ${symlinkTarget}`);
  }
  return normalized;
}

function field(block: Buffer, start: number, end: number): string {
  return block.subarray(start, end).toString("utf8").replace(/\0.*$/s, "").trim();
}

function octal(block: Buffer, start: number, end: number): number {
  const value = field(block, start, end).replace(/^0+/, "");
  return value ? Number.parseInt(value, 8) : 0;
}

export interface TarEntry {
  readonly name: string;
  readonly type: "file" | "directory" | "symlink";
  readonly mode: number;
  readonly linkTarget?: string;
  readonly content: Buffer;
}

export function readTarGz(bytes: Uint8Array): readonly TarEntry[] {
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new Error("archive exceeds download size limit");
  const tar = gunzipSync(bytes, { maxOutputLength: MAX_EXTRACTED_BYTES });
  const entries: TarEntry[] = [];
  let extracted = 0;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const prefix = field(header, 345, 500);
    const rawName = [prefix, field(header, 0, 100)].filter(Boolean).join("/");
    const size = octal(header, 124, 136);
    const mode = octal(header, 100, 108);
    const typeFlag = field(header, 156, 157) || "0";
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (!Number.isSafeInteger(size) || size < 0 || contentEnd > tar.length) throw new Error(`corrupt tar entry: ${rawName}`);
    offset = contentStart + Math.ceil(size / 512) * 512;
    if (typeFlag === "x" || typeFlag === "g") continue;
    if (!["0", "5", "2"].includes(typeFlag)) throw new Error(`unsupported archive entry type ${typeFlag} for ${rawName}`);
    if ((rawName === "." || rawName === "./") && typeFlag === "5") continue;
    const linkTarget = typeFlag === "2" ? field(header, 157, 257) : undefined;
    const name = validateArchivePath(rawName, linkTarget);
    extracted += size;
    if (extracted > MAX_EXTRACTED_BYTES) throw new Error("archive exceeds extracted size limit");
    entries.push({
      name,
      type: typeFlag === "5" ? "directory" : typeFlag === "2" ? "symlink" : "file",
      mode,
      ...(linkTarget === undefined ? {} : { linkTarget }),
      content: typeFlag === "0" ? Buffer.from(tar.subarray(contentStart, contentEnd)) : Buffer.alloc(0),
    });
  }
  return Object.freeze(entries);
}

export function extractTarGz(bytes: Uint8Array, destination: string): readonly string[] {
  const root = resolve(destination);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const entries = readTarGz(bytes);
  for (const entry of entries) {
    const target = resolve(root, entry.name);
    const relation = relative(root, target);
    if (relation.startsWith("..") || isAbsolute(relation)) throw new Error(`archive entry escapes destination: ${entry.name}`);
    if (entry.type === "directory") mkdirSync(target, { recursive: true, mode: entry.mode || 0o755 });
    else if (entry.type === "file") {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, entry.content, { flag: "wx", mode: entry.mode || 0o644 });
      if (process.platform !== "win32") chmodSync(target, entry.mode || 0o644);
    } else {
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(entry.linkTarget!, target);
    }
  }
  return entries.map((entry) => entry.name);
}

export async function downloadBytes(url: string, fetcher: typeof fetch = fetch): Promise<Buffer> {
  const response = await fetcher(url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`download failed (${response.status}) for ${url}`);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > MAX_DOWNLOAD_BYTES) throw new Error(`download exceeds size limit: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error(`download exceeds size limit: ${url}`);
  return bytes;
}

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalProject } from "./trusted-agents-store";

/**
 * One approval a principal gave for a project's `verify` block (P3).
 *
 * The verify commands run in the ALP process, outside the runtime sandbox, in the caller's
 * workspace — so a repo cloned from anywhere must not get to run them by shipping a
 * `.alp/settings.json`. The record names the digest of the block that was read and approved;
 * an edited block has a different digest and is not trusted until it is read again.
 */
export interface TrustedVerifyRecord {
  readonly project: string;
  readonly verifyDigest: string;
  readonly trustedAt: string;
}

export interface TrustedVerifyRead {
  readonly records: readonly TrustedVerifyRecord[];
  /** Set when the file exists but could not be used; nothing is trusted in that case. */
  readonly warning?: string;
}

interface TrustedVerifyDocument {
  readonly version: 1;
  readonly trusted: readonly TrustedVerifyRecord[];
}

const DIGEST = /^[0-9a-f]{64}$/;

export function trustedVerifyFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME || homedir(), ".alp", "trusted-verify.json");
}

export function readTrustedVerify(file = trustedVerifyFile()): TrustedVerifyRead {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [] };
    return { records: [], warning: `cannot read trusted verify blocks at ${file}` };
  }
  try {
    const parsed = JSON.parse(content) as Partial<TrustedVerifyDocument>;
    if (parsed === null || typeof parsed !== "object" || parsed.version !== 1 || !Array.isArray(parsed.trusted)) {
      throw new Error("unsupported trusted verify file");
    }
    const records = parsed.trusted.filter((record): record is TrustedVerifyRecord =>
      typeof record?.project === "string"
      && typeof record?.verifyDigest === "string"
      && DIGEST.test(record.verifyDigest));
    return { records };
  } catch {
    return { records: [], warning: `invalid trusted verify file at ${file}; no verify block is trusted until it is repaired` };
  }
}

/** Synchronous on purpose: the collector asks this between two producers, with nothing to await. */
export function verifyTrusted(project: string, digest: string, file = trustedVerifyFile()): boolean {
  const canonical = canonicalProject(project);
  return readTrustedVerify(file).records
    .some((record) => record.verifyDigest === digest && canonicalProject(record.project) === canonical);
}

async function writeTrustedVerify(records: readonly TrustedVerifyRecord[], file: string): Promise<void> {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${randomUUID()}.trusted-verify.tmp`);
  const document: TrustedVerifyDocument = { version: 1, trusted: records };
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
    await chmod(file, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** One record per project: trusting a new digest forgets the old one. */
export async function trustVerify(
  record: TrustedVerifyRecord,
  file = trustedVerifyFile(),
): Promise<readonly TrustedVerifyRecord[]> {
  const canonical = canonicalProject(record.project);
  const kept = readTrustedVerify(file).records.filter((existing) => canonicalProject(existing.project) !== canonical);
  const records = [...kept, { ...record, project: canonical }];
  await writeTrustedVerify(records, file);
  return records;
}

export async function untrustVerify(project: string, file = trustedVerifyFile()): Promise<boolean> {
  const canonical = canonicalProject(project);
  const records = readTrustedVerify(file).records;
  const kept = records.filter((record) => canonicalProject(record.project) !== canonical);
  if (kept.length === records.length) return false;
  await writeTrustedVerify(kept, file);
  return true;
}

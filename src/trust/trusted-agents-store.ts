import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AgentId } from "../agents/types";
import type { TrustedAuthority } from "./authority";

/**
 * One approval a principal gave, for one agent file, in one project.
 *
 * Keyed by project as well as id because agent files are project-scoped (§11 decision 2):
 * two repos may each define a `migrator`, and a trust decision made about one of them says
 * nothing about the other.
 */
export interface TrustRecord {
  readonly project: string;
  readonly id: AgentId;
  readonly definitionHash: string;
  readonly trustedAt: string;
  readonly sourcePath: string;
  readonly authority: TrustedAuthority;
}

export interface TrustedAgentsRead {
  readonly records: readonly TrustRecord[];
  /** Set when the file exists but could not be used; the caller trusts nothing in that case. */
  readonly warning?: string;
}

interface TrustedAgentsDocument {
  readonly version: 1;
  readonly trusted: readonly TrustRecord[];
}

export function trustedAgentsFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME || homedir(), ".alp", "trusted-agents.json");
}

/**
 * The spelling of a project path that a trust record is keyed by.
 *
 * Resolved through symlinks so `~/code/app` and `/Volumes/…/app` cannot end up as two
 * separate approvals for the same repo. A path that does not exist yet keeps its resolved
 * form rather than failing — the record is still about that path.
 */
export function canonicalProject(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

export function readTrustedAgents(file = trustedAgentsFile()): TrustedAgentsRead {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [] };
    return { records: [], warning: `cannot read trusted agents at ${file}` };
  }
  try {
    const parsed = JSON.parse(content) as Partial<TrustedAgentsDocument>;
    if (parsed === null || typeof parsed !== "object" || parsed.version !== 1 || !Array.isArray(parsed.trusted)) {
      throw new Error("unsupported trusted agents file");
    }
    // A malformed entry is dropped rather than tolerated: a record missing its hash cannot
    // authorize anything, and keeping it would only make the file look like it says more
    // than it does.
    const records = parsed.trusted.filter((record): record is TrustRecord =>
      typeof record?.project === "string"
      && typeof record?.id === "string"
      && typeof record?.definitionHash === "string"
      && record.definitionHash.length > 0);
    return { records };
  } catch {
    return { records: [], warning: `invalid trusted agents file at ${file}; nothing is trusted until it is repaired` };
  }
}

export function trustRecordFor(
  records: readonly TrustRecord[],
  project: string,
  id: AgentId,
): TrustRecord | null {
  const canonical = canonicalProject(project);
  return records.find((record) => record.id === id && canonicalProject(record.project) === canonical) ?? null;
}

async function writeTrustedAgents(
  records: readonly TrustRecord[],
  file: string,
): Promise<void> {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${randomUUID()}.trusted-agents.tmp`);
  const document: TrustedAgentsDocument = { version: 1, trusted: records };
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8", flag: "wx", mode: 0o600,
    });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
    await chmod(file, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Adds or replaces one approval. Re-reads first, so two projects cannot clobber each other. */
export async function trustAgent(
  record: TrustRecord,
  file = trustedAgentsFile(),
): Promise<readonly TrustRecord[]> {
  const canonical = canonicalProject(record.project);
  const kept = readTrustedAgents(file).records
    .filter((existing) => !(existing.id === record.id && canonicalProject(existing.project) === canonical));
  const records = [...kept, { ...record, project: canonical }];
  await writeTrustedAgents(records, file);
  return records;
}

export async function untrustAgent(
  project: string,
  id: AgentId,
  file = trustedAgentsFile(),
): Promise<boolean> {
  const canonical = canonicalProject(project);
  const records = readTrustedAgents(file).records;
  const kept = records.filter((record) => !(record.id === id && canonicalProject(record.project) === canonical));
  if (kept.length === records.length) return false;
  await writeTrustedAgents(kept, file);
  return true;
}

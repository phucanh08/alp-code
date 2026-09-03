import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Who ALP is serving, and how the agents are meant to speak to them.
 *
 * This used to be a frozen constant compiled into the binary, which made one person's name
 * part of every role's prompt. It now lives next to the other machine-local state
 * (`runtime.json`, `projects.json`) so a fresh install asks once and never ships a name.
 */
export interface PrincipalProfile {
  readonly name: string;
  /** What an agent calls the principal — `anh`, `chị`, `bạn`. */
  readonly addressAs: string;
  /** What an agent calls itself when speaking to the principal — `em`, `tôi`, `mình`. */
  readonly selfAs: string;
}

export interface PrincipalProfileRead {
  readonly profile: PrincipalProfile | null;
  readonly warning?: string;
}

interface PrincipalProfileDocument extends PrincipalProfile {
  readonly version: 1;
}

/** Long enough for a full name, short enough that a stray paste cannot flood every prompt. */
export const PRINCIPAL_FIELD_LIMIT = 60;

export function principalProfileFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME || homedir(), ".alp", "principal.json");
}

/**
 * Collapses whitespace and rejects empties — these strings are interpolated straight into
 * every role's instructions, so a newline here would silently become a new prompt line.
 */
export function normalizePrincipalField(label: string, value: string): string {
  const cleaned = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  if (cleaned === "") throw new Error(`${label} is required`);
  if (cleaned.length > PRINCIPAL_FIELD_LIMIT) {
    throw new Error(`${label} must be at most ${PRINCIPAL_FIELD_LIMIT} characters`);
  }
  return cleaned;
}

export function normalizePrincipalProfile(input: {
  readonly name: string;
  readonly addressAs: string;
  readonly selfAs: string;
}): PrincipalProfile {
  return Object.freeze({
    name: normalizePrincipalField("name", input.name),
    addressAs: normalizePrincipalField("form of address", input.addressAs),
    selfAs: normalizePrincipalField("agent self-reference", input.selfAs),
  });
}

/**
 * Synchronous on purpose: `AgentDefinition.instructions()` is sync and is called while
 * rendering identity documents and identity capsules. The file is a few dozen bytes and is
 * read at most once per role render, so there is no cache to go stale after `alp init`
 * writes the profile in the same process.
 */
export function readPrincipalProfile(file = principalProfileFile()): PrincipalProfileRead {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { profile: null };
    return { profile: null, warning: `cannot read principal profile at ${file}` };
  }
  try {
    const parsed = JSON.parse(content) as Partial<PrincipalProfileDocument>;
    if (parsed === null || typeof parsed !== "object" || parsed.version !== 1) {
      throw new Error("unsupported principal profile");
    }
    return {
      profile: normalizePrincipalProfile({
        name: String(parsed.name ?? ""),
        addressAs: String(parsed.addressAs ?? ""),
        selfAs: String(parsed.selfAs ?? ""),
      }),
    };
  } catch {
    return { profile: null, warning: `invalid principal profile at ${file}; run \`alp principal set\`` };
  }
}

export async function writePrincipalProfile(
  profile: PrincipalProfile,
  file = principalProfileFile(),
): Promise<PrincipalProfile> {
  const normalized = normalizePrincipalProfile(profile);
  const directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = join(directory, `.${randomUUID()}.principal.tmp`);
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({ version: 1, ...normalized }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    await chmod(temporary, 0o600);
    await rename(temporary, file);
    await chmod(file, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return normalized;
}

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { stateHome } from "../state-paths";
import { compareSemver } from "../install/semver";

const TTL_MS = 24 * 60 * 60 * 1000;

export interface UpdateCheckCache {
  readonly checkedAt: number;
  readonly latestTag: string | null;
}

export interface UpdateCheckStore {
  read(): Promise<UpdateCheckCache | null>;
  write(cache: UpdateCheckCache): Promise<void>;
}

export class FileUpdateCheckStore implements UpdateCheckStore {
  private readonly file: string;

  constructor(options: { readonly file?: string } = {}) {
    this.file = options.file ?? join(stateHome(), "update-check.json");
  }

  async read(): Promise<UpdateCheckCache | null> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      return typeof parsed?.checkedAt === "number"
        ? { checkedAt: parsed.checkedAt, latestTag: typeof parsed.latestTag === "string" ? parsed.latestTag : null }
        : null;
    } catch {
      return null;
    }
  }

  async write(cache: UpdateCheckCache): Promise<void> {
    const dir = dirname(this.file);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.${randomUUID()}.update-check.tmp`);
    try {
      await writeFile(tmp, `${JSON.stringify(cache)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(tmp, this.file);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }
}

export async function refreshUpdateCheck(
  store: UpdateCheckStore = new FileUpdateCheckStore(),
  fetchLatest: typeof fetch = fetch,
): Promise<void> {
  let latestTag: string | null = null;
  try {
    const response = await fetchLatest("https://api.github.com/repos/phucanh08/alp-code/releases/latest", {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "alp-code-update-check" },
      signal: AbortSignal.timeout(4000),
    });
    if (response.ok) {
      const body = await response.json() as { tag_name?: unknown };
      if (typeof body.tag_name === "string") latestTag = body.tag_name;
    }
  } catch { /* cache a failed check so normal commands never wait/retry in a loop */ }
  await store.write({ checkedAt: Date.now(), latestTag });
}

export function spawnBackgroundUpdateCheck(repoRoot: string): void {
  try {
    const child = spawn(process.execPath, [join(repoRoot, "scripts", "lib", "update-check-worker.cjs")], {
      cwd: repoRoot,
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
  } catch {
    /* best-effort; never affect the current command */
  }
}

export function spawnNativeBackgroundUpdateCheck(selfExecutable: string, cwd: string): void {
  try {
    const child = spawn(selfExecutable, ["__internal", "update-check"], {
      cwd,
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
  } catch { /* best-effort */ }
}

function isNewer(latestTag: string, currentVersion: string): boolean {
  try {
    return compareSemver(latestTag, currentVersion) > 0;
  } catch {
    return false;
  }
}

export interface CheckForUpdateInput {
  readonly repoRoot: string;
  readonly store: UpdateCheckStore;
  readonly currentVersion: string;
  readonly now?: number;
  readonly triggerBackgroundRefresh?: (repoRoot: string) => void;
}

export async function checkForUpdate(input: CheckForUpdateInput): Promise<string | null> {
  const now = input.now ?? Date.now();
  const cached = await input.store.read();
  if (!cached || now - cached.checkedAt >= TTL_MS) (input.triggerBackgroundRefresh ?? spawnBackgroundUpdateCheck)(input.repoRoot);
  if (!cached?.latestTag) return null;
  if (!isNewer(cached.latestTag, input.currentVersion)) return null;
  return `UPDATE    phiên bản mới ${cached.latestTag} hiện có (đang dùng v${input.currentVersion}) — chạy \`alp update\`\n`;
}

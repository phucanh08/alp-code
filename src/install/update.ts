import { closeSync, existsSync, mkdirSync, openSync, readlinkSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { rename, rm, symlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import type { InstallLayout } from "../install-layout";
import { readInstallManifest } from "../install-layout";
import { compareSemver, isValidSemver } from "./semver";
import { binaryArchiveName, hostBinaryTarget } from "./targets";
import { downloadBytes, extractTarGz, parseChecksums, verifyArchiveChecksum } from "./archive";

export interface AtomicSwitchOptions {
  readonly beforeReplace?: () => void | Promise<void>;
  readonly observe?: (event: "temporary-created" | "pointer-replaced") => void;
  readonly platform?: NodeJS.Platform;
}

export async function atomicSwitchCurrent(
  installHome: string,
  versionRoot: string,
  options: AtomicSwitchOptions = {},
): Promise<void> {
  const current = join(installHome, "current");
  const temporary = join(installHome, `.current.${process.pid}.${Date.now()}.tmp`);
  const target = relative(installHome, versionRoot);
  try {
    await symlink(target, temporary, options.platform === "win32" ? "junction" : "dir");
    options.observe?.("temporary-created");
    await options.beforeReplace?.();
    await rename(temporary, current);
    options.observe?.("pointer-replaced");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export function manualRollbackCommand(installHome: string, previousVersionRoot: string): string {
  return process.platform === "win32"
    ? `New-Item -ItemType Junction -Path ${JSON.stringify(join(installHome, "current"))} -Target ${JSON.stringify(previousVersionRoot)} -Force`
    : `ln -sfn ${JSON.stringify(relative(installHome, previousVersionRoot))} ${JSON.stringify(join(installHome, "current.next"))} && mv -f ${JSON.stringify(join(installHome, "current.next"))} ${JSON.stringify(join(installHome, "current"))}`;
}

export interface UpdateBinaryOptions {
  readonly layout: InstallLayout;
  readonly targetVersion: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetcher?: typeof fetch;
  readonly releaseBaseUrl?: string;
  readonly injectFailure?: (step: string) => void;
}

export async function resolveLatestReleaseVersion(fetcher: typeof fetch = fetch): Promise<string> {
  const url = "https://api.github.com/repos/phucanh08/alp-code/releases/latest";
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "alp-code-updater" },
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    throw new Error(`cannot resolve latest ALP release from ${url}: ${(error as Error).message}`);
  }
  if (!response.ok) throw new Error(`cannot resolve latest ALP release from ${url}: HTTP ${response.status}`);
  const body = await response.json() as { tag_name?: unknown };
  if (typeof body.tag_name !== "string" || !isValidSemver(body.tag_name)) {
    throw new Error(`invalid release tag from ${url}: ${JSON.stringify(body.tag_name)}`);
  }
  return body.tag_name.replace(/^v/, "");
}

export interface UpdateInstallationOptions {
  readonly layout: InstallLayout;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetcher?: typeof fetch;
  readonly resolveTargetVersion?: () => Promise<string>;
  readonly updateBinary?: (options: UpdateBinaryOptions) => Promise<{ version: string; previous: string | null }>;
  readonly spawnProcess?: typeof spawnSync;
}

export interface UpdateInstallationResult {
  readonly channel: InstallLayout["channel"];
  readonly from: string;
  readonly to: string;
  readonly unchanged: boolean;
  readonly previous?: string | null;
}

export async function updateInstallation(options: UpdateInstallationOptions): Promise<UpdateInstallationResult> {
  const targetVersion = await (options.resolveTargetVersion ?? (() => resolveLatestReleaseVersion(options.fetcher)))();
  const order = compareSemver(targetVersion, options.layout.version);
  if (order < 0) throw new Error(`refusing to downgrade ALP from ${options.layout.version} to ${targetVersion}`);
  if (order === 0) return Object.freeze({
    channel: options.layout.channel,
    from: options.layout.version,
    to: options.layout.version,
    unchanged: true,
  });
  if (options.layout.channel === "npm") {
    const spawnProcess = options.spawnProcess ?? spawnSync;
    const env = options.env ?? process.env;
    const installed = spawnProcess("npm", ["install", "--global", `alp-code@${targetVersion}`], { env, stdio: "inherit" });
    if (installed.error || installed.status !== 0) {
      throw new Error(`npm install -g alp-code@${targetVersion} failed${installed.error ? `: ${installed.error.message}` : ` (exit ${installed.status})`}`);
    }
    const ensured = spawnProcess(options.layout.stableCommand, ["__internal", "ensure-state"], {
      env,
      stdio: "inherit",
      ...(process.platform === "win32" ? { shell: true } : {}),
    });
    if (ensured.error || ensured.status !== 0) {
      throw new Error(`updated npm wrapper but state repair failed${ensured.error ? `: ${ensured.error.message}` : ` (exit ${ensured.status})`}`);
    }
    return Object.freeze({ channel: "npm", from: options.layout.version, to: targetVersion, unchanged: false });
  }
  if (options.layout.channel === "dev") {
    throw new Error("dev clone updates are handled by scripts/alp.cjs so git safety checks remain available");
  }
  const result = await (options.updateBinary ?? updateBinaryInstallation)({
    layout: options.layout,
    targetVersion,
    ...(options.env ? { env: options.env } : {}),
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  });
  return Object.freeze({
    channel: "binary",
    from: options.layout.version,
    to: result.version,
    unchanged: false,
    previous: result.previous,
  });
}

function installationHome(layout: InstallLayout): string {
  return dirname(dirname(layout.installRoot));
}

function withInstallLock<T>(home: string, run: () => T): T {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, ".update.lock");
  let descriptor: number;
  try { descriptor = openSync(file, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      try {
        if (Date.now() - statSync(file).mtimeMs > 10 * 60 * 1000) rmSync(file, { force: true });
      } catch { /* handled by the retry below */ }
      try { descriptor = openSync(file, "wx", 0o600); }
      catch { throw new Error(`another ALP update holds ${file}`); }
    } else throw error;
  }
  writeFileSync(descriptor, `${process.pid}\n`);
  try { return run(); }
  finally { closeSync(descriptor); rmSync(file, { force: true }); }
}

function pruneVersions(versionsDirectory: string, keep: ReadonlySet<string>): void {
  if (!existsSync(versionsDirectory)) return;
  for (const name of readdirSync(versionsDirectory)) {
    const candidate = join(versionsDirectory, name);
    if (!/^v\d+\.\d+\.\d+$/.test(name) || keep.has(resolve(candidate))) continue;
    rmSync(candidate, { recursive: true, force: true });
  }
}

export async function updateBinaryInstallation(options: UpdateBinaryOptions): Promise<{ version: string; previous: string | null }> {
  if (options.layout.channel !== "binary") throw new Error("binary updater cannot mutate a non-binary channel");
  if (compareSemver(options.targetVersion, options.layout.version) <= 0) throw new Error("update target must be newer than the current version");
  const env = options.env ?? process.env;
  const target = hostBinaryTarget();
  const filename = binaryArchiveName(options.targetVersion, target.id);
  const base = options.releaseBaseUrl ?? `https://github.com/phucanh08/alp-code/releases/download/v${options.targetVersion}`;
  const home = installationHome(options.layout);
  const versions = join(home, "versions");
  const finalRoot = join(versions, `v${options.targetVersion}`);
  const staging = join(home, `.staging-${randomUUID()}`);

  const checksumsBytes = await downloadBytes(`${base}/SHA256SUMS`, options.fetcher);
  const archive = await downloadBytes(`${base}/${filename}`, options.fetcher);
  verifyArchiveChecksum(archive, filename, parseChecksums(checksumsBytes.toString("utf8")));
  options.injectFailure?.("verified");

  return withInstallLock(home, () => {
    let previous: string | null = null;
    let pointerSwitched = false;
    const validateVersionRoot = (root: string): string => {
      const manifest = readInstallManifest(root, options.targetVersion);
      if (manifest.target !== target.id) throw new Error(`install manifest target mismatch: expected ${target.id}, got ${manifest.target}`);
      const executable = join(root, "bin", target.executable);
      const smoke = spawnSync(executable, ["--version"], { encoding: "utf8", env: { ...env, ALP_SKIP_UPDATE_CHECK: "1" } });
      if (smoke.status !== 0 || smoke.stdout.trim() !== `alp ${options.targetVersion}`) {
        throw new Error(`staged binary smoke failed: ${(smoke.stderr || smoke.stdout).trim()}`);
      }
      return executable;
    };
    try {
      mkdirSync(staging, { recursive: true, mode: 0o700 });
      extractTarGz(archive, staging);
      validateVersionRoot(staging);
      options.injectFailure?.("smoked");
      mkdirSync(versions, { recursive: true, mode: 0o700 });
      if (existsSync(finalRoot)) {
        validateVersionRoot(finalRoot);
        rmSync(staging, { recursive: true, force: true });
      } else renameSync(staging, finalRoot);
      options.injectFailure?.("version-installed");
      try { previous = resolve(home, readlinkSync(join(home, "current"))); } catch { previous = null; }
      // This state machine is synchronous inside the lock except for the pointer primitive.
      const temporary = join(home, `.current.${process.pid}.${Date.now()}.tmp`);
      symlinkSync(relative(home, finalRoot), temporary, process.platform === "win32" ? "junction" : "dir");
      renameSync(temporary, join(home, "current"));
      pointerSwitched = true;
      options.injectFailure?.("pointer-switched");
      const state = spawnSync(join(finalRoot, "bin", target.executable), ["__internal", "ensure-state"], {
        encoding: "utf8", env: { ...env, ALP_SKIP_UPDATE_CHECK: "1" },
      });
      if (state.status !== 0) {
        throw new Error(`new state bootstrap failed; rollback: ${previous ? manualRollbackCommand(home, previous) : "no previous version"}`);
      }
      options.injectFailure?.("state-ready");
      pruneVersions(versions, new Set([resolve(finalRoot), ...(previous ? [resolve(previous)] : [])]));
      return { version: options.targetVersion, previous };
    } catch (error) {
      if (pointerSwitched) {
        if (previous) {
          const rollback = join(home, `.current.rollback.${process.pid}`);
          rmSync(rollback, { recursive: true, force: true });
          symlinkSync(relative(home, previous), rollback, process.platform === "win32" ? "junction" : "dir");
          renameSync(rollback, join(home, "current"));
        } else rmSync(join(home, "current"), { recursive: true, force: true });
      }
      throw error;
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });
}

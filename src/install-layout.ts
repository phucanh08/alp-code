import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type InstallChannel = "binary" | "npm" | "dev";

export interface InstallLayout {
  readonly channel: InstallChannel;
  readonly version: string;
  readonly selfExecutable: string;
  readonly stableCommand: string;
  readonly installRoot: string;
  readonly assetRoot: string;
}

export interface InstallManifest {
  readonly schemaVersion: 1;
  readonly app: "alp-code";
  readonly version: string;
  readonly target: string;
  readonly compiler: { readonly name: string; readonly version: string };
}

export interface ResolveInstallLayoutOptions {
  readonly executable?: string;
  readonly version: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly devRoot?: string;
  readonly platform?: NodeJS.Platform;
}

function inside(root: string, candidate: string): boolean {
  const relation = relative(resolve(root), resolve(candidate));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function requireDirectory(root: string, name: string): void {
  if (!existsSync(join(root, name))) throw new Error(`invalid ALP installation: missing ${join(root, name)}`);
}

export function readInstallManifest(root: string, expectedVersion?: string): InstallManifest {
  const file = join(root, "install-manifest.json");
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { throw new Error(`invalid ALP installation: cannot read ${file}: ${(error as Error).message}`); }
  const manifest = value as Partial<InstallManifest>;
  if (
    manifest.schemaVersion !== 1 || manifest.app !== "alp-code" || typeof manifest.version !== "string" ||
    typeof manifest.target !== "string" || typeof manifest.compiler?.name !== "string" ||
    typeof manifest.compiler?.version !== "string"
  ) throw new Error(`invalid ALP installation manifest: ${file}`);
  if (expectedVersion && manifest.version !== expectedVersion) {
    throw new Error(`manifest version ${manifest.version} does not match executable version ${expectedVersion}`);
  }
  requireDirectory(root, "skills");
  requireDirectory(root, "scaffold");
  return manifest as InstallManifest;
}

function developmentLayout(options: ResolveInstallLayoutOptions, root: string): InstallLayout {
  for (const required of ["package.json", "src", "skills", "scaffold"])
    requireDirectory(root, required);
  return Object.freeze({
    channel: "dev",
    version: options.version,
    selfExecutable: resolve(options.executable ?? process.execPath),
    stableCommand: join(root, "scripts", "alp.cjs"),
    installRoot: root,
    assetRoot: root,
  });
}

export function resolveInstallLayout(options: ResolveInstallLayoutOptions): InstallLayout {
  const env = options.env ?? process.env;
  const executable = resolve(options.executable ?? process.execPath);
  if (options.devRoot) return developmentLayout(options, resolve(options.devRoot));

  if (env.ALP_LAYOUT_CHANNEL) {
    if (env.ALP_LAYOUT_CHANNEL !== "npm") throw new Error(`unsupported ALP layout channel: ${env.ALP_LAYOUT_CHANNEL}`);
    if (!env.ALP_INSTALL_ROOT || !env.ALP_STABLE_COMMAND) {
      throw new Error("npm layout requires ALP_INSTALL_ROOT and ALP_STABLE_COMMAND");
    }
    if (env.ALP_WRAPPER_VERSION !== options.version) {
      throw new Error(`npm wrapper version ${env.ALP_WRAPPER_VERSION ?? "missing"} does not match executable version ${options.version}`);
    }
    const installRoot = resolve(env.ALP_INSTALL_ROOT);
    if (!inside(installRoot, executable)) throw new Error("npm executable is outside ALP_INSTALL_ROOT");
    readInstallManifest(installRoot, options.version);
    return Object.freeze({
      channel: "npm",
      version: options.version,
      selfExecutable: executable,
      stableCommand: resolve(env.ALP_STABLE_COMMAND),
      installRoot,
      assetRoot: installRoot,
    });
  }

  const installRoot = dirname(dirname(executable));
  readInstallManifest(installRoot, options.version);
  const installHome = dirname(dirname(installRoot));
  const platform = options.platform ?? process.platform;
  const executableName = platform === "win32" ? "alp.exe" : "alp";
  return Object.freeze({
    channel: "binary",
    version: options.version,
    selfExecutable: executable,
    stableCommand: platform === "win32"
      ? join(installHome, "current", "bin", executableName)
      : join(installHome, "bin", executableName),
    installRoot,
    assetRoot: installRoot,
  });
}

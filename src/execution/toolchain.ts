import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Toolchain write paths (GitHub #25): directories *outside* the workspace that a build or
 * test tool must write to — `~/fvm`, `~/.pub-cache`, `~/.gradle`, DerivedData, `~/.cargo`,
 * `~/.npm` — declared once per machine in `~/.alp/settings.json`:
 *
 * ```json
 * { "toolchain": { "presets": ["flutter", "node"], "writePaths": ["~/fvm"] } }
 * ```
 *
 * A sandboxed launch (read-only, or `workspace-write` with a scope) opens exactly the paths
 * listed here beside the workspace and the relay directory, on both runtimes. Nothing else
 * changes: a preset is a list of well-known cache directories and nothing more, and a path
 * that does not exist is skipped when it came from a preset, refused when it was typed.
 *
 * Machine layer only. A repo's `.alp/settings.json` may not carry this block: a project
 * that could open `~/.ssh` for whoever clones it is the same hole `alp trust verify`
 * exists to close, and unlike a verify command there is no digest to trust here.
 */
export interface ToolchainSettings {
  readonly presets: readonly string[];
  readonly writePaths: readonly string[];
}

/**
 * Cache directories each ecosystem writes to outside the project, relative to `$HOME`. A
 * preset narrower than its tool needs is a bug worth reporting; a path here that does not
 * exist on a machine is simply not opened.
 */
export const TOOLCHAIN_PRESETS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  flutter: Object.freeze(["~/fvm", "~/.pub-cache", "~/.dart", "~/.dart-tool", "~/.flutter", "~/.flutter-devtools", "~/.config/flutter"]),
  node: Object.freeze(["~/.npm", "~/.yarn", "~/.cache/yarn", "~/.pnpm-store", "~/.local/share/pnpm", "~/Library/pnpm", "~/.bun/install/cache", "~/.node-gyp", "~/.cache/node-gyp"]),
  rust: Object.freeze(["~/.cargo", "~/.rustup"]),
  jvm: Object.freeze(["~/.gradle", "~/.m2", "~/.android", "~/.konan"]),
  xcode: Object.freeze(["~/Library/Developer/Xcode/DerivedData", "~/Library/Caches/CocoaPods", "~/.cocoapods", "~/Library/Caches/org.swift.swiftpm", "~/Library/org.swift.swiftpm"]),
  python: Object.freeze(["~/.cache/pip", "~/.cache/uv", "~/.local/share/uv", "~/.cache/pypoetry"]),
  go: Object.freeze(["~/go/pkg", "~/.cache/go-build"]),
});

export class InvalidToolchainSettings extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidToolchainSettings";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, where: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new InvalidToolchainSettings(`${where} must be a list of strings`);
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "") throw new InvalidToolchainSettings(`${where}[${index}] must be a non-empty string`);
    return entry;
  });
}

/** `null` when the file says nothing about toolchains; throws when it says it wrong. */
export function parseToolchainBlock(raw: unknown, file: string): ToolchainSettings | null {
  if (!isPlainObject(raw)) throw new InvalidToolchainSettings(`${file}: settings must be a JSON object`);
  if (raw.toolchain === undefined) return null;
  if (!isPlainObject(raw.toolchain)) throw new InvalidToolchainSettings(`${file}: \`toolchain\` must be an object with \`presets\` and/or \`writePaths\``);
  const presets = stringList(raw.toolchain.presets, `${file}: \`toolchain.presets\``);
  for (const preset of presets) {
    if (!(preset in TOOLCHAIN_PRESETS)) {
      throw new InvalidToolchainSettings(`${file}: \`toolchain.presets\` names \`${preset}\`; known presets are ${Object.keys(TOOLCHAIN_PRESETS).join(", ")}`);
    }
  }
  const writePaths = stringList(raw.toolchain.writePaths, `${file}: \`toolchain.writePaths\``);
  return Object.freeze({ presets: Object.freeze([...presets]), writePaths: Object.freeze(writePaths) });
}

export interface ResolveToolchainOptions {
  readonly home: string;
  /** ALP's own state directory — never opened, whatever the settings say. */
  readonly stateHome: string;
  /** Canonical path of an existing directory, or `null` when there is none. */
  readonly canonical: (path: string) => Promise<string | null>;
  readonly file: string;
}

function contains(parent: string, child: string): boolean {
  const between = relative(parent, child);
  return between === "" || (!between.startsWith(`..${sep}`) && between !== ".." && !isAbsolute(between));
}

/** `~` and `~/…` expand against the given home; anything else must already be absolute. */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(home, path.slice(2));
  return path;
}

/**
 * The declared block, resolved: presets expanded, `~` replaced, every path made canonical
 * through symlinks the way the workspace is, sorted and deduplicated. Refused: a relative
 * path, `/`, the home directory itself (that is not a toolchain, that is everything), and
 * anything at or around ALP's state home — the executions root and every `policy.json`
 * live there.
 */
export async function resolveToolchainWritePaths(
  settings: ToolchainSettings,
  options: ResolveToolchainOptions,
): Promise<readonly string[]> {
  const home = resolve(options.home);
  const root = resolve("/");
  const stateHome = resolve(options.stateHome);
  const resolved = new Set<string>();
  const consider = async (entry: string, explicit: boolean): Promise<void> => {
    const where = `${options.file}: \`toolchain.writePaths\` entry \`${entry}\``;
    const expanded = expandHome(entry, home);
    if (!isAbsolute(expanded)) throw new InvalidToolchainSettings(`${where} must be absolute or start with \`~/\``);
    const candidate = resolve(expanded);
    if (candidate === root || candidate === home) {
      throw new InvalidToolchainSettings(`${where} would open ${candidate === root ? "the whole filesystem" : "the whole home directory"}; list the toolchain's own directories`);
    }
    if (contains(candidate, stateHome) || contains(stateHome, candidate)) {
      throw new InvalidToolchainSettings(`${where} overlaps ALP's state directory \`${stateHome}\``);
    }
    const canonical = await options.canonical(candidate);
    if (canonical === null) {
      if (explicit) throw new InvalidToolchainSettings(`${where} does not exist`);
      return;
    }
    resolved.add(canonical);
  };
  for (const preset of settings.presets) {
    for (const entry of TOOLCHAIN_PRESETS[preset] ?? []) await consider(entry, false);
  }
  for (const entry of settings.writePaths) await consider(entry, true);
  return Object.freeze([...resolved].sort());
}

export function defaultHome(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || homedir();
}

/**
 * The check only a launch can make: a toolchain path may not contain the workspace (that
 * would open the whole tree to a read-only or scoped role) and may not lie inside it (the
 * scope, not the machine settings, says what a role writes there).
 */
export function assertToolchainOutsideWorkspace(paths: readonly string[], workspace: string): void {
  for (const path of paths) {
    if (contains(path, workspace)) {
      throw new Error(`toolchain write path \`${path}\` contains the workspace \`${workspace}\`; a toolchain path opens a cache, not a project`);
    }
    if (contains(workspace, path)) {
      throw new Error(`toolchain write path \`${path}\` lies inside the workspace \`${workspace}\`; use a write scope for that`);
    }
  }
}

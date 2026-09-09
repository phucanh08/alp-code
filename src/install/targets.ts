import definitions = require("./binary-targets.json");

export interface BinaryTarget {
  readonly id: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly libc: "glibc" | null;
  readonly bunTarget: string;
  readonly executable: string;
}

export const BINARY_TARGETS: readonly BinaryTarget[] = Object.freeze(definitions.map((value) => Object.freeze(value as BinaryTarget)));

export function resolveBinaryTarget(platform: NodeJS.Platform, arch: string, libc: string | null = null): BinaryTarget {
  const normalizedLibc = platform === "linux" ? libc : null;
  const target = BINARY_TARGETS.find((candidate) => candidate.platform === platform && candidate.arch === arch && candidate.libc === normalizedLibc);
  if (!target) throw new Error(`unsupported ALP binary target: ${platform}/${arch}${libc ? `/${libc}` : ""}`);
  return target;
}

export function hostBinaryTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): BinaryTarget {
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: unknown } } | undefined;
  const libc = platform === "linux"
    ? (report?.header?.glibcVersionRuntime ? "glibc" : "musl")
    : null;
  return resolveBinaryTarget(platform, arch, libc);
}

export function binaryArchiveName(version: string, target: string): string {
  if (!BINARY_TARGETS.some((candidate) => candidate.id === target)) throw new Error(`unknown target: ${target}`);
  return `alp-code-v${version}-${target}.tar.gz`;
}

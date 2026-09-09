export interface Semver { readonly major: number; readonly minor: number; readonly patch: number }

export function parseSemver(tag: string): Semver | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(tag).trim());
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null;
}

export function compareSemver(a: string, b: string): number {
  const parsedA = parseSemver(a);
  const parsedB = parseSemver(b);
  if (!parsedA || !parsedB) throw new Error(`invalid semver tag: ${JSON.stringify(!parsedA ? a : b)}`);
  return parsedA.major - parsedB.major || parsedA.minor - parsedB.minor || parsedA.patch - parsedB.patch;
}

export function isValidSemver(tag: string): boolean {
  return parseSemver(tag) !== null;
}

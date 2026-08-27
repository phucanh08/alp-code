import type { MemoryScopeGrant } from "./types";

function segments(value: MemoryScopeGrant): readonly string[] {
  return value.split(":");
}

export function memoryGrantCovers(
  grant: MemoryScopeGrant,
  target: MemoryScopeGrant,
): boolean {
  if (grant === target) return true;

  const expected = segments(grant);
  const actual = segments(target);
  if (expected[0] !== actual[0]) return false;

  if (grant === "shared") return actual.length > 1;
  if (
    expected.length === 2 &&
    (expected[0] === "private" || expected[0] === "project")
  ) {
    return (expected[1] === "*" || expected[1] === actual[1]) && actual.length >= 2;
  }

  for (let index = 0; index < expected.length; index += 1) {
    const part = expected[index];
    if (part === "*" && index === expected.length - 1) {
      return actual.length > index;
    }
    if (part !== "*" && part !== actual[index]) return false;
  }
  return actual.length >= expected.length;
}

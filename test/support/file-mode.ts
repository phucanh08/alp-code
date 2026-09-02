import { stat } from "node:fs/promises";
import { expect } from "vitest";

/**
 * Windows has no POSIX permission bits: `chmod(0o600)` there only toggles the read-only
 * attribute, and `stat` reports 0o666 (or 0o444) regardless. Asserting the exact mode
 * would fail for every developer on Windows while telling nobody anything, so the check
 * runs where it means something and is skipped where it cannot.
 */
export async function expectPosixMode(path: string, mode: number): Promise<void> {
  if (process.platform === "win32") return;
  expect((await stat(path)).mode & 0o777).toBe(mode);
}

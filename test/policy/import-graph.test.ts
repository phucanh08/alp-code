import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => (entry.isDirectory() ? sources(join(directory, entry.name)) : entry.name.endsWith(".ts") ? [join(directory, entry.name)] : [])));
  return files.flat();
}

/**
 * Oracle: invariant "ALP decides" (P4 gate) — policy is decided from identity and request,
 * never from what a run produced or what a parent said about it. A policy module that
 * reads evidence, acceptance, usage or thread state would let an outcome bend authority.
 */
describe("src/policy imports nothing from the governance loop", () => {
  it("never imports evidence, acceptance, usage or thread modules", async () => {
    const files = await sources(join(process.cwd(), "src", "policy"));
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const match of text.matchAll(/from\s+["']([^"']+)["']/g)) {
        if (/(^|\/)(evidence|acceptance|usage)(\b|[-./])|(^|\/)thread(\/|$)/.test(match[1])) offenders.push(`${file}: ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

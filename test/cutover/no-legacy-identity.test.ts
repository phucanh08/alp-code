import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();

const forbiddenSources = [
  "CHARTER.md",
  "identity",
  "scripts/compile-acl.cjs",
  "scripts/compile-acl.sh",
  "scripts/compile-acl.ps1",
  "scripts/trust-role.cjs",
  "scripts/trust-role.sh",
  "scripts/trust-role.ps1",
  "scripts/lib/loadout.cjs",
  "scripts/lib/claude-settings.cjs",
  "scripts/lib/codex-profile.cjs",
  "scripts/lib/skill-links.cjs",
  "hooks/session-start.cjs",
] as const;

const runtimeRoots = ["hooks", "scripts", "src"] as const;
const runtimeFiles = ["install.sh", "install.ps1", "package.json"] as const;
// `.worktrees` holds checkouts of other branches — including pre-cutover ones that still
// contain the legacy files by design. `.alp` holds the generated identity documents.
const ignoredDirectories = new Set(["node_modules", "dist", ".git", ".worktrees", ".alp"]);
const textExtensions = new Set([".cjs", ".js", ".json", ".ps1", ".sh", ".ts"]);
const legacyReference = /(?:CHARTER\.md|(?:^|[\\/'"`])identity[\\/]|loadout\.yaml|AGENTS\.md|CLAUDE\.md|compile-acl|trust-role|lib[\\/]loadout|claude-settings\.cjs|codex-profile|skill-links|session-start)/;

async function collectFiles(relativePath: string): Promise<string[]> {
  const absolutePath = path.join(repositoryRoot, relativePath);
  const entries = await readdir(absolutePath, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];

  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) continue;
    const child = path.join(relativePath, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(child)));
    else files.push(child);
  }

  return files;
}

/**
 * `path.join` yields backslashes on Windows, but every pattern below is written with
 * forward slashes. Without this the whole suite silently passes on Windows while catching
 * real violations on CI — the worst of both.
 */
function posix(file: string): string {
  return file.split(path.sep).join("/");
}

describe("code-native identity cutover", () => {
  it("has no legacy identity sources or runtime read/import paths", async () => {
    const repositoryFiles = (await collectFiles(".")).map(posix);
    const sourceViolations = forbiddenSources.filter((source) =>
      repositoryFiles.some((file) => file === source || file.startsWith(`${source}/`)),
    );
    const nestedInstructionFiles = repositoryFiles.filter((file) =>
      /(?:^|\/)(?:AGENTS|CLAUDE)\.md$/.test(file),
    );

    const runtimeCandidates = [
      ...(await Promise.all(runtimeRoots.map((root) => collectFiles(root)))).flat().filter((file) =>
        textExtensions.has(path.extname(file)),
      ),
      ...runtimeFiles,
    ];
    const runtimeViolations: string[] = [];
    for (const file of runtimeCandidates) {
      const lines = (await readFile(path.join(repositoryRoot, file), "utf8")).split("\n");
      lines.forEach((line, index) => {
        if (legacyReference.test(line)) runtimeViolations.push(`${file}:${index + 1}: ${line.trim()}`);
      });
    }

    expect(
      [...sourceViolations, ...nestedInstructionFiles, ...runtimeViolations],
      "remaining legacy identity sources and runtime references",
    ).toEqual([]);
  });
});

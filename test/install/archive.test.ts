import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseChecksums, verifyArchiveChecksum, validateArchivePath } from "../../src/install/archive";

describe("binary archive validation", () => {
  it("parses exact checksum records and verifies bytes", () => {
    const bytes = Buffer.from("archive");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const sums = parseChecksums(`${digest}  alp-code-v0.10.0-darwin-arm64.tar.gz\n`);
    expect(sums.get("alp-code-v0.10.0-darwin-arm64.tar.gz")).toBe(digest);
    expect(() => verifyArchiveChecksum(bytes, "alp-code-v0.10.0-darwin-arm64.tar.gz", sums)).not.toThrow();
    expect(() => verifyArchiveChecksum(Buffer.from("tampered"), "alp-code-v0.10.0-darwin-arm64.tar.gz", sums)).toThrow(/checksum/);
  });

  it("rejects traversal, absolute paths, backslashes and escaping symlinks", () => {
    for (const entry of ["../escape", "/etc/passwd", "C:\\escape", "skills\\bad"])
      expect(() => validateArchivePath(entry)).toThrow(/unsafe archive path/);
    expect(validateArchivePath("skills/search/SKILL.md")).toBe("skills/search/SKILL.md");
    expect(() => validateArchivePath("bin/alp-link", "../../outside")).toThrow(/symlink/);
  });
});

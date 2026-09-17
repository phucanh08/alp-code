import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTrustVerify } from "../../src/cli/commands/trust-verify";
import { InvalidModeSettings, loadVerifyCommands } from "../../src/cli/settings";
import { readTrustedVerify, trustVerify, untrustVerify, verifyTrusted } from "../../src/trust";
import { removeTemporary } from "../support/temporary-root";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTemporary(root))); });

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "alp-verify-trust-"));
  roots.push(root);
  return root;
}

async function project(settings: unknown, local?: unknown): Promise<string> {
  const root = await temporary();
  const directory = join(root, "repo");
  await mkdir(join(directory, ".alp"), { recursive: true });
  await mkdir(join(directory, "packages", "api"), { recursive: true });
  if (settings !== undefined) await writeFile(join(directory, ".alp", "settings.json"), JSON.stringify(settings));
  if (local !== undefined) await writeFile(join(directory, ".alp", "settings.local.json"), JSON.stringify(local));
  return directory;
}

const VERIFY = { verify: { commands: [{ id: "test", run: "npm test", timeoutMs: 600000, cwd: "." }] } };

/**
 * Oracle: P3 spec, "Producers (3)" — verify commands come from `.alp/settings.json`
 * (`{ verify: { commands: [{ id, run, timeoutMs, cwd }] } }`), project tier and up only:
 * the machine-wide `~/.alp/settings.json` may not put a command into a project's evidence;
 * `settings.local.json` layers over the project file; and the whole block is identified by
 * one digest, which is what `alp trust verify` records.
 */
describe("loadVerifyCommands", () => {
  it("reads the project's block, from a subdirectory, with defaults filled in", async () => {
    const directory = await project({ verify: { commands: [{ id: "test", run: "npm test" }] } });
    const loaded = await loadVerifyCommands(join(directory, "packages", "api"), { HOME: directory });
    expect(loaded.project).toBe(directory);
    expect(loaded.commands).toEqual([{ id: "test", run: "npm test", timeoutMs: 600000, cwd: "." }]);
    expect(loaded.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ignores the machine tier: a command there is not a project command", async () => {
    const directory = await project(undefined);
    const home = await temporary();
    await mkdir(join(home, ".alp"), { recursive: true });
    await writeFile(join(home, ".alp", "settings.json"), JSON.stringify(VERIFY));
    const loaded = await loadVerifyCommands(directory, { HOME: home, ALP_STATE_HOME: join(home, ".alp") });
    expect(loaded.commands).toEqual([]);
    expect(loaded.digest).toBeNull();
  });

  it("lets the local file add and override by id, and the digest follows the merged block", async () => {
    const shared = await project(VERIFY);
    const layered = await project(VERIFY, { verify: { commands: [{ id: "test", run: "npm run test:fast" }, { id: "lint", run: "npm run lint", timeoutMs: 1000 }] } });
    const sharedOnly = await loadVerifyCommands(shared, { HOME: shared });
    const merged = await loadVerifyCommands(layered, { HOME: layered });
    expect(merged.commands).toEqual([
      { id: "lint", run: "npm run lint", timeoutMs: 1000, cwd: "." },
      { id: "test", run: "npm run test:fast", timeoutMs: 600000, cwd: "." },
    ]);
    expect(merged.digest).not.toBe(sharedOnly.digest);
    // Same block in two projects: same digest — the digest is about the commands, not the path.
    const twin = await project(VERIFY);
    expect((await loadVerifyCommands(twin, { HOME: twin })).digest).toBe(sharedOnly.digest);
  });

  it("refuses a malformed entry instead of running something else", async () => {
    for (const block of [
      { verify: { commands: [{ id: "test" }] } },
      { verify: { commands: [{ run: "npm test" }] } },
      { verify: { commands: [{ id: "a b", run: "x" }] } },
      { verify: { commands: [{ id: "test", run: "x", timeoutMs: -1 }] } },
      { verify: { commands: [{ id: "test", run: "x", cwd: "../outside" }] } },
      { verify: "npm test" },
    ]) {
      const directory = await project(block);
      await expect(loadVerifyCommands(directory, { HOME: directory })).rejects.toBeInstanceOf(InvalidModeSettings);
    }
  });
});

/**
 * Oracle: spec — `alp trust verify` records `{ project, verifyDigest, trustedAt }`; the
 * verifier runs only when the project's current digest is the trusted one. The store follows
 * the trusted-agents store: keyed by canonical project, atomic, `0600`.
 */
describe("trusted verify store", () => {
  it("trusts one digest per project, and answers only for that digest", async () => {
    const root = await temporary();
    const file = join(root, "trusted-verify.json");
    await trustVerify({ project: root, verifyDigest: "a".repeat(64), trustedAt: "2026-09-17T00:00:00.000Z" }, file);
    expect(verifyTrusted(root, "a".repeat(64), file)).toBe(true);
    expect(verifyTrusted(root, "b".repeat(64), file)).toBe(false);
    expect(verifyTrusted(join(root, "other"), "a".repeat(64), file)).toBe(false);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    // Re-trusting replaces: the old digest is no longer trusted.
    await trustVerify({ project: root, verifyDigest: "b".repeat(64), trustedAt: "2026-09-17T00:00:01.000Z" }, file);
    expect(verifyTrusted(root, "a".repeat(64), file)).toBe(false);
    expect(verifyTrusted(root, "b".repeat(64), file)).toBe(true);
    expect(readTrustedVerify(file).records).toHaveLength(1);
  });

  it("trusts nothing without a file or with a broken one, and forgets on untrust", async () => {
    const root = await temporary();
    const file = join(root, "trusted-verify.json");
    expect(verifyTrusted(root, "a".repeat(64), file)).toBe(false);
    await trustVerify({ project: root, verifyDigest: "a".repeat(64), trustedAt: "2026-09-17T00:00:00.000Z" }, file);
    expect(await untrustVerify(root, file)).toBe(true);
    expect(await untrustVerify(root, file)).toBe(false);
    expect(verifyTrusted(root, "a".repeat(64), file)).toBe(false);
    await writeFile(file, "{not json");
    expect(verifyTrusted(root, "a".repeat(64), file)).toBe(false);
    expect(readTrustedVerify(file).warning).toBeDefined();
  });
});

describe("alp trust verify", () => {
  function prompt(answer: string) {
    const asked: string[] = [];
    return { asked, open: () => ({ ask: async (question: string) => { asked.push(question); return answer; }, close: () => {} }) };
  }

  async function run(directory: string, options: { answer?: string; interactive?: boolean; argv?: readonly string[] } = {}) {
    const asker = prompt(options.answer ?? "yes");
    const file = join(directory, "trusted-verify.json");
    let output = "";
    const code = await runTrustVerify(options.argv ?? [], {
      cwd: directory,
      env: { HOME: directory },
      write: (text) => { output += text; },
      interactive: options.interactive ?? true,
      openPrompt: asker.open,
      trustFile: file,
    });
    return { code, output, asked: asker.asked, file };
  }

  it("prints the commands, asks, and records the block's digest on yes", async () => {
    const directory = await project(VERIFY);
    const { code, output, asked, file } = await run(directory);
    expect(code).toBe(0);
    expect(output).toContain("npm test");
    expect(asked).toHaveLength(1);
    const { digest } = await loadVerifyCommands(directory, { HOME: directory });
    expect(verifyTrusted(directory, digest as string, file)).toBe(true);
    // Keyed by the canonical project, like the trusted-agents store: `/var` and `/private/var` are one repo.
    expect(JSON.parse(await readFile(file, "utf8")).trusted[0]).toMatchObject({ project: await realpath(directory), verifyDigest: digest });
  });

  it("records nothing on any other answer, or without a terminal", async () => {
    const directory = await project(VERIFY);
    const { digest } = await loadVerifyCommands(directory, { HOME: directory });
    const declined = await run(directory, { answer: "y" });
    expect(declined.code).not.toBe(0);
    expect(verifyTrusted(directory, digest as string, declined.file)).toBe(false);
    const headless = await run(directory, { interactive: false });
    expect(headless.code).not.toBe(0);
    expect(headless.asked).toEqual([]);
    expect(verifyTrusted(directory, digest as string, headless.file)).toBe(false);
  });

  it("has nothing to trust in a project without a verify block, and revokes with --revoke", async () => {
    const empty = await project(undefined);
    expect((await run(empty)).code).not.toBe(0);
    const directory = await project(VERIFY);
    const { digest } = await loadVerifyCommands(directory, { HOME: directory });
    const { file } = await run(directory);
    expect(verifyTrusted(directory, digest as string, file)).toBe(true);
    const revoked = await run(directory, { argv: ["--revoke"] });
    expect(revoked.code).toBe(0);
    expect(verifyTrusted(directory, digest as string, file)).toBe(false);
  });
});

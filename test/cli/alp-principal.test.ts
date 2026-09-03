import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { principalInstruction } from "../../src/agents/shared/principal";
import {
  ensurePrincipalProfile,
  runPrincipalCommand,
  type PrincipalPrompt,
} from "../../src/cli/commands/principal";
import {
  normalizePrincipalProfile,
  readPrincipalProfile,
  writePrincipalProfile,
} from "../../src/principal/principal-profile-store";
import { expectPosixMode } from "../support/file-mode";
import { removeTemporary } from "../support/temporary-root";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTemporary(root)));
});

async function profileFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "alp-principal-"));
  roots.push(root);
  return join(root, ".alp", "principal.json");
}

function scriptedPrompt(answers: readonly string[]): PrincipalPrompt & { asked: string[]; closed: boolean } {
  const queue = [...answers];
  const prompt = {
    asked: [] as string[],
    closed: false,
    async ask(question: string) {
      prompt.asked.push(question);
      return queue.shift() ?? "";
    },
    close() { prompt.closed = true; },
  };
  return prompt;
}

describe("principal profile store", () => {
  it("writes an owner-only document and reads it back", async () => {
    const file = await profileFile();

    await writePrincipalProfile({ name: "Lê Phúc Anh", addressAs: "anh", selfAs: "em" }, file);

    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 1,
      name: "Lê Phúc Anh",
      addressAs: "anh",
      selfAs: "em",
    });
    await expectPosixMode(file, 0o600);
    expect(readPrincipalProfile(file)).toEqual({
      profile: { name: "Lê Phúc Anh", addressAs: "anh", selfAs: "em" },
    });
  });

  it("treats an absent profile as unset and a corrupt one as a warning, never as a throw", async () => {
    const file = await profileFile();
    expect(readPrincipalProfile(file)).toEqual({ profile: null });

    await writePrincipalProfile({ name: "A", addressAs: "b", selfAs: "c" }, file);
    await writeFile(file, "{ not json\n");

    const read = readPrincipalProfile(file);
    expect(read.profile).toBeNull();
    expect(read.warning).toContain("invalid principal profile");
  });

  it("collapses whitespace and rejects empty or oversized fields", () => {
    expect(normalizePrincipalProfile({ name: "  Lê   Phúc Anh\t", addressAs: " anh ", selfAs: "em" })).toEqual({
      name: "Lê Phúc Anh",
      addressAs: "anh",
      selfAs: "em",
    });
    // A newline would otherwise become an extra instruction line in every role prompt.
    expect(normalizePrincipalProfile({ name: "A\nB", addressAs: "anh", selfAs: "em" }).name).toBe("A B");
    expect(() => normalizePrincipalProfile({ name: "   ", addressAs: "anh", selfAs: "em" })).toThrow(/name is required/);
    expect(() => normalizePrincipalProfile({ name: "A", addressAs: "", selfAs: "em" })).toThrow(/form of address/);
    expect(() => normalizePrincipalProfile({ name: "x".repeat(61), addressAs: "anh", selfAs: "em" })).toThrow(/at most/);
  });
});

describe("principal instruction", () => {
  it("names the principal and the agreed forms of address", () => {
    expect(principalInstruction({ name: "Lê Phúc Anh", addressAs: "anh", selfAs: "em" })).toBe(
      'Serve Lê Phúc Anh. Address the principal as "anh" and refer to yourself as "em". '
      + "Communicate in Vietnamese, keep technical terms in English, and lead with the verified outcome.",
    );
  });

  it("falls back to a neutral wording rather than inventing a name", () => {
    expect(principalInstruction(null)).toBe(
      "Serve the principal. Communicate in Vietnamese, keep technical terms in English, and lead with the verified outcome.",
    );
  });
});

describe("alp init principal capture", () => {
  it("asks once on a terminal, persists the answers, and refreshes identity documents", async () => {
    const file = await profileFile();
    const prompt = scriptedPrompt(["Lê Phúc Anh", "anh", "em"]);
    const writes: string[] = [];
    let synced = 0;

    const profile = await ensurePrincipalProfile({ interactive: true }, {
      file,
      write: (text) => writes.push(text),
      openPrompt: () => prompt,
      syncIdentity: async () => { synced += 1; },
    });

    expect(profile).toEqual({ name: "Lê Phúc Anh", addressAs: "anh", selfAs: "em" });
    expect(prompt.asked).toHaveLength(3);
    expect(prompt.closed).toBe(true);
    expect(synced).toBe(1);
    expect(writes.join("")).toContain("PROFILE  Lê Phúc Anh");
    expect(readPrincipalProfile(file).profile).toEqual(profile);
  });

  it("does not ask again once a profile exists", async () => {
    const file = await profileFile();
    await writePrincipalProfile({ name: "Lê Phúc Anh", addressAs: "anh", selfAs: "em" }, file);
    const prompt = scriptedPrompt(["other", "chị", "tôi"]);

    const profile = await ensurePrincipalProfile({ interactive: true }, {
      file,
      write: () => {},
      openPrompt: () => prompt,
    });

    expect(profile).toEqual({ name: "Lê Phúc Anh", addressAs: "anh", selfAs: "em" });
    expect(prompt.asked).toEqual([]);
  });

  it("skips the interview without a terminal and leaves no profile behind", async () => {
    const file = await profileFile();
    const writes: string[] = [];

    const profile = await ensurePrincipalProfile({ interactive: false }, {
      file,
      write: (text) => writes.push(text),
      openPrompt: () => { throw new Error("must not prompt without a terminal"); },
    });

    expect(profile).toBeNull();
    expect(writes.join("")).toContain("alp principal set");
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps init alive when the interview is answered empty", async () => {
    const file = await profileFile();
    const writes: string[] = [];
    const prompt = scriptedPrompt(["", "", ""]);

    const profile = await ensurePrincipalProfile({ interactive: true }, {
      file,
      write: (text) => writes.push(text),
      openPrompt: () => prompt,
    });

    expect(profile).toBeNull();
    expect(prompt.closed).toBe(true);
    expect(writes.join("")).toContain("WARNING  name is required");
    expect(writes.join("")).toContain("alp principal set");
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("alp principal", () => {
  it("shows the stored profile and reports an unset one with a non-zero status", async () => {
    const file = await profileFile();
    const writes: string[] = [];

    await expect(runPrincipalCommand({ action: "show" }, { file, write: (text) => writes.push(text) })).resolves.toBe(1);
    expect(writes.join("")).toContain("UNSET");

    await writePrincipalProfile({ name: "Lê Phúc Anh", addressAs: "anh", selfAs: "em" }, file);
    await expect(runPrincipalCommand({ action: "show" }, { file, write: (text) => writes.push(text) })).resolves.toBe(0);
    expect(writes.join("")).toContain('agents say "em" and call you "anh"');
  });

  it("overwrites an existing profile on set", async () => {
    const file = await profileFile();
    await writePrincipalProfile({ name: "Lê Phúc Anh", addressAs: "anh", selfAs: "em" }, file);

    await expect(runPrincipalCommand({ action: "set" }, {
      file,
      write: () => {},
      openPrompt: () => scriptedPrompt(["Người khác", "chị", "tôi"]),
    })).resolves.toBe(0);

    expect(readPrincipalProfile(file).profile).toEqual({ name: "Người khác", addressAs: "chị", selfAs: "tôi" });
  });
});

import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { InvalidMemoryIdError } from "../../src/memory/errors";
import { MarkdownFileStore } from "../../src/memory/adapters/markdown-file-store";
import { memoryStoreContract } from "./memory-store.contract";

async function temporaryStore() {
  const directory = await mkdtemp(join(tmpdir(), "alp-memory-store-"));
  return {
    root: directory,
    store: new MarkdownFileStore({ root: directory }),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

describe("MarkdownFileStore contract", () => {
  memoryStoreContract(temporaryStore);
});

describe("MarkdownFileStore filesystem behavior", () => {
  it.each(["", "shared:", "shared:..", "shared:/absolute", "project:alp:", "private::note"])(
    "rejects unsafe logical ID %j",
    async (id) => {
      const fixture = await temporaryStore();
      try {
        await expect(
          fixture.store.create({ id, kind: "fact", content: "unsafe" }),
        ).rejects.toBeInstanceOf(InvalidMemoryIdError);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it("rejects a symlink escape from the memory root", async () => {
    const fixture = await temporaryStore();
    const outside = await mkdtemp(join(tmpdir(), "alp-memory-outside-"));
    try {
      await symlink(outside, join(fixture.root, "shared"));
      await expect(
        fixture.store.create({ id: "shared:escape", kind: "fact", content: "no" }),
      ).rejects.toThrow(/symlink escape/);
      await expect(readdir(outside)).resolves.toEqual([]);
    } finally {
      await fixture.cleanup();
      await rm(outside, { recursive: true, force: true });
    }
  });

  it.each(["get", "update"] as const)(
    "rejects an existing target-file symlink escape on %s",
    async (operation) => {
      const fixture = await temporaryStore();
      const outside = await mkdtemp(join(tmpdir(), "alp-memory-target-outside-"));
      const outsideFile = join(outside, "secret.md");
      const target = join(fixture.root, "shared", "target.md");
      try {
        await fixture.store.create({ id: "shared:target", kind: "fact", content: "inside" });
        await writeFile(outsideFile, "outside-secret", "utf8");
        await rm(target);
        await symlink(outsideFile, target);

        const action = operation === "get"
          ? fixture.store.get("shared:target")
          : fixture.store.update("shared:target", { expectedVersion: 1, content: "overwrite" });
        await expect(action).rejects.toThrow(/symlink escape/);
        await expect(readFile(outsideFile, "utf8")).resolves.toBe("outside-secret");
      } finally {
        await fixture.cleanup();
        await rm(outside, { recursive: true, force: true });
      }
    },
  );

  it("uses monotonic versions even when timestamps are identical", async () => {
    const directory = await mkdtemp(join(tmpdir(), "alp-memory-clock-"));
    const fixed = new Date("2026-08-26T00:00:00.000Z");
    const store = new MarkdownFileStore({ root: directory, now: () => fixed });
    try {
      await store.create({ id: "shared:clock", kind: "fact", content: "v1" });
      await expect(store.update("shared:clock", { expectedVersion: 1, content: "v2" })).resolves.toMatchObject({ version: 2 });
      await expect(store.update("shared:clock", { expectedVersion: 2, content: "v3" })).resolves.toMatchObject({ version: 3 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rebuilds missing metadata without rewriting existing Markdown", async () => {
    const directory = await mkdtemp(join(tmpdir(), "alp-memory-rebuild-"));
    const shared = join(directory, "shared");
    const path = join(shared, "existing.md");
    const markdown = "---\ntitle: Existing\n---\n\n# Body\n\nKeep me byte-for-byte.\n";
    try {
      await mkdir(shared, { recursive: true });
      await writeFile(path, markdown, "utf8");
      const store = new MarkdownFileStore({ root: directory });

      await expect(store.get("shared:existing")).resolves.toMatchObject({
        id: "shared:existing",
        content: markdown,
        version: 1,
      });
      await expect(readFile(path, "utf8")).resolves.toBe(markdown);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("discovers nested shared and project Markdown through logical IDs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "alp-memory-nested-"));
    const sharedDecision = join(directory, "shared", "decisions", "runtime.md");
    const sharedReference = join(directory, "shared", "reference", "zod", "validation.md");
    const projectLog = join(directory, "projects", "alp", "log", "2026-08.md");
    try {
      await mkdir(join(directory, "shared", "decisions"), { recursive: true });
      await mkdir(join(directory, "shared", "reference", "zod"), { recursive: true });
      await mkdir(join(directory, "projects", "alp", "log"), { recursive: true });
      await writeFile(sharedDecision, "runtime decision", "utf8");
      await writeFile(sharedReference, "zod reference", "utf8");
      await writeFile(projectLog, "project log", "utf8");
      const store = new MarkdownFileStore({ root: directory });

      await expect(store.get("shared:decisions:runtime")).resolves.toMatchObject({
        id: "shared:decisions:runtime",
        content: "runtime decision",
      });
      await expect(store.get("shared:reference:zod:validation")).resolves.toMatchObject({
        id: "shared:reference:zod:validation",
        content: "zod reference",
      });
      await expect(store.get("project:alp:log:2026-08")).resolves.toMatchObject({
        id: "project:alp:log:2026-08",
        content: "project log",
      });
      await expect(store.search({ scope: "shared:reference" })).resolves.toMatchObject([
        { id: "shared:reference:zod:validation" },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("leaves no temporary sibling after replacement", async () => {
    const fixture = await temporaryStore();
    try {
      await fixture.store.create({ id: "shared:atomic", kind: "fact", content: "old" });
      await fixture.store.update("shared:atomic", { expectedVersion: 1, content: "new" });
      expect((await readdir(join(fixture.root, "shared"))).sort()).toEqual(["atomic.md"]);
    } finally {
      await fixture.cleanup();
    }
  });
});

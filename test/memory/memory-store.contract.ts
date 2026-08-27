import { expect, it } from "vitest";
import {
  MemoryEntryAlreadyExistsError,
  MemoryEntryNotFoundError,
  MemoryVersionConflictError,
} from "../../src/memory/errors";
import type { MemoryStore } from "../../src/memory/memory-store";

export interface MemoryStoreFixture {
  readonly store: MemoryStore;
  cleanup(): void | Promise<void>;
}

export function memoryStoreContract(
  createFixture: () => MemoryStoreFixture | Promise<MemoryStoreFixture>,
): void {
  it("creates and gets an entry with a stable logical ID", async () => {
    const fixture = await createFixture();
    try {
      const created = await fixture.store.create({
        id: "shared:welcome",
        kind: "fact",
        content: "hello",
      });

      expect(created).toMatchObject({
        id: "shared:welcome",
        scope: "shared",
        kind: "fact",
        content: "hello",
        version: 1,
      });
      await expect(fixture.store.get("shared:welcome")).resolves.toEqual(created);
      await expect(
        fixture.store.create({ id: "shared:welcome", kind: "fact", content: "again" }),
      ).rejects.toBeInstanceOf(MemoryEntryAlreadyExistsError);
    } finally {
      await fixture.cleanup();
    }
  });

  it("searches deterministically by scope, kind, and content", async () => {
    const fixture = await createFixture();
    try {
      await fixture.store.create({ id: "shared:b", kind: "fact", content: "needle two" });
      await fixture.store.create({ id: "shared:a", kind: "decision", content: "needle one" });
      await fixture.store.create({ id: "project:alp:c", kind: "fact", content: "needle three" });

      await expect(
        fixture.store.search({ scope: "shared", text: "needle" }),
      ).resolves.toMatchObject([{ id: "shared:a" }, { id: "shared:b" }]);
      await expect(
        fixture.store.search({ scope: "shared", kinds: ["fact"], limit: 1 }),
      ).resolves.toMatchObject([{ id: "shared:b" }]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("atomically replaces content while preserving ID and incrementing version", async () => {
    const fixture = await createFixture();
    try {
      await fixture.store.create({ id: "private:main:draft", kind: "draft", content: "old" });
      const updated = await fixture.store.update("private:main:draft", {
        expectedVersion: 1,
        kind: "decision",
        content: "new-complete-content",
      });

      expect(updated).toMatchObject({
        id: "private:main:draft",
        scope: "private",
        ownerRole: "main",
        kind: "decision",
        content: "new-complete-content",
        version: 2,
      });
      await expect(fixture.store.get("private:main:draft")).resolves.toEqual(updated);
    } finally {
      await fixture.cleanup();
    }
  });

  it("preserves expected-version conflicts as typed errors", async () => {
    const fixture = await createFixture();
    try {
      await fixture.store.create({ id: "shared:version", kind: "fact", content: "v1" });
      await fixture.store.update("shared:version", { expectedVersion: 1, content: "v2" });

      await expect(
        fixture.store.update("shared:version", { expectedVersion: 1, content: "stale" }),
      ).rejects.toMatchObject({
        name: "MemoryVersionConflictError",
        expectedVersion: 1,
        actualVersion: 2,
      });
      await expect(fixture.store.delete("shared:version", 1)).rejects.toBeInstanceOf(
        MemoryVersionConflictError,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("deletes entries and reports missing-entry behavior", async () => {
    const fixture = await createFixture();
    try {
      await fixture.store.create({ id: "project:alp:log", kind: "log", content: "done" });
      await fixture.store.delete("project:alp:log", 1);

      await expect(fixture.store.get("project:alp:log")).resolves.toBeNull();
      await expect(
        fixture.store.update("project:alp:missing", { expectedVersion: 1, content: "x" }),
      ).rejects.toBeInstanceOf(MemoryEntryNotFoundError);
      await expect(fixture.store.delete("project:alp:missing", 1)).rejects.toBeInstanceOf(
        MemoryEntryNotFoundError,
      );
    } finally {
      await fixture.cleanup();
    }
  });
}

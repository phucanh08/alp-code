import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentRegistry } from "../../src/agents/registry";
import { MarkdownFileStore } from "../../src/memory/adapters/markdown-file-store";
import { RemoteApiStore } from "../../src/memory/adapters/remote-api-store";
import { UnauthorizedMemoryAccessError } from "../../src/memory/errors";
import { MemoryService } from "../../src/memory/memory-service";
import type { MemoryStore } from "../../src/memory/memory-store";
import { FakeMemoryApiClient } from "../memory/fake-memory-api-client";
import { cleanupEnvironments, createE2eEnvironment, type E2eEnvironment } from "./harness";

afterEach(cleanupEnvironments);

/** The same MemoryService rules must hold whichever store backs it. */
async function isolationBehavior(service: MemoryService): Promise<void> {
  await service.create("search", { id: "private:search:notes", kind: "fact", content: "search-only finding" });
  await service.create("main", { id: "shared:handoff", kind: "fact", content: "shared finding" });

  await expect(service.get("search", "private:search:notes"))
    .resolves.toMatchObject({ content: "search-only finding" });
  await expect(service.get("main", "private:search:notes"))
    .rejects.toBeInstanceOf(UnauthorizedMemoryAccessError);
  await expect(service.search("main", { scope: "private:search" }))
    .rejects.toBeInstanceOf(UnauthorizedMemoryAccessError);

  // Shared memory stays readable by both, but a specialist cannot write it.
  await expect(service.get("search", "shared:handoff")).resolves.toMatchObject({ content: "shared finding" });
  await expect(service.create("search", { id: "shared:injected", kind: "fact", content: "nope" }))
    .rejects.toBeInstanceOf(UnauthorizedMemoryAccessError);
}

function serviceFor(store: MemoryStore, environment: E2eEnvironment): MemoryService {
  return new MemoryService({ store, policy: environment.policy, audit: { record() {} } });
}

describe("e2e: memory isolation and portability", () => {
  it("keeps private memory owner-scoped on the Markdown store", async () => {
    const environment = await createE2eEnvironment();

    await isolationBehavior(serviceFor(new MarkdownFileStore({ root: environment.memoryRoot }), environment));

    // Memory remains readable Markdown on disk, not an opaque runtime format.
    const files = (await readdir(environment.memoryRoot, { recursive: true })).map(String);
    expect(files.filter((name) => name.endsWith(".md")).length).toBe(2);
    expect(files).toContain(".alp-memory-index.json");
    const contents = await Promise.all(files
      .filter((name) => name.endsWith(".md"))
      .map((name) => readFile(join(environment.memoryRoot, name), "utf8")));
    expect(contents.sort()).toEqual(["search-only finding", "shared finding"]);
  });

  it("keeps the same isolation behavior on an API-backed store", async () => {
    const environment = await createE2eEnvironment();
    const client = new FakeMemoryApiClient();

    await isolationBehavior(serviceFor(new RemoteApiStore(client), environment));

    // Denials never reach the store, so the API sees only authorized calls.
    expect(client.calls).toEqual(["create", "create", "get", "get"]);
    expect(await readdir(environment.memoryRoot)).toEqual([]);
  });

  it("keeps agent definitions free of concrete memory adapters", async () => {
    const files = (await readdir("src/agents", { recursive: true }))
      .map(String)
      .filter((name) => name.endsWith(".ts"));

    for (const name of files) {
      const source = await readFile(join("src/agents", name), "utf8");
      expect(source, `${name} must not import a memory adapter`)
        .not.toMatch(/markdown-file-store|remote-api-store|memory-api-client/);
    }
    // Memory grants stay declarative: scope strings, not storage.
    expect(agentRegistry.get("search").capabilities.memory.write).toEqual(["private:search"]);
  });
});

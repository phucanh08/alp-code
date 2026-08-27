import { describe, expect, it } from "vitest";
import { RemoteApiStore } from "../../src/memory/adapters/remote-api-store";
import { FakeMemoryApiClient } from "./fake-memory-api-client";
import { memoryStoreContract } from "./memory-store.contract";

describe("RemoteApiStore contract", () => {
  memoryStoreContract(() => ({ store: new RemoteApiStore(new FakeMemoryApiClient()), cleanup() {} }));
});

describe("RemoteApiStore boundary", () => {
  it("delegates through the injected client without endpoint or auth knowledge", async () => {
    const client = new FakeMemoryApiClient();
    const store = new RemoteApiStore(client);

    await store.create({ id: "shared:remote", kind: "fact", content: "remote" });
    await store.get("shared:remote");
    expect(client.calls).toEqual(["create", "get"]);
  });
});

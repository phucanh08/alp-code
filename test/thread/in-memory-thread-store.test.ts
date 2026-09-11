import { InMemoryThreadStore } from "../../src/thread/in-memory-thread-store";
import { describeThreadStore } from "./thread-store.contract";

describeThreadStore("InMemoryThreadStore", async () => ({
  store: new InMemoryThreadStore(),
  cleanup: async () => undefined,
}));

import { InMemoryExecutionGraphStore } from "../../src/execution/graph/in-memory-execution-graph-store";
import { describeExecutionGraphStore } from "./execution-graph-store.contract";

describeExecutionGraphStore("InMemoryExecutionGraphStore", async () => ({
  store: new InMemoryExecutionGraphStore(),
  cleanup: async () => undefined,
}));

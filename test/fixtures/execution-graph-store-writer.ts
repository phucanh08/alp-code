import { FileExecutionGraphStore } from "../../src/execution/graph/file-execution-graph-store";
import { childNode, nextRevision } from "../support/execution-graph-fixture";

/**
 * Một process ngoài, ghi vào cùng một graph.
 *
 * Đây là nửa còn lại của câu hỏi mà một suite in-process không hỏi được: hàng đợi trong bộ
 * nhớ của `FileExecutionGraphStore` làm mọi lease trong một process nối tiếp nhau, nên một
 * lỗi khoá thư mục vẫn cho suite ấy xanh. Chỉ khi mỗi bên chỉ nhìn thấy đĩa thì một lost
 * update mới lộ ra — và nó lộ ra dưới dạng revision cuối nhỏ hơn tổng số lần ghi.
 *
 * Chạy qua `test/fixtures/run-typescript.cjs`:
 *   node test/fixtures/run-typescript.cjs test/fixtures/execution-graph-store-writer.ts \
 *     <root> <graphId> <label> <writes>
 */
async function main(): Promise<void> {
  const [root, graphId, label, writes] = process.argv.slice(3);
  const store = new FileExecutionGraphStore({ root, lockTimeoutMs: 30_000 });
  for (let index = 0; index < Number(writes); index += 1) {
    await store.withExclusiveLease(graphId, async (lease) => {
      const current = await lease.read();
      // Nhường thread giữa read và write. Không có nó thì hai process vẫn có thể nối tiếp
      // nhau chỉ vì mỗi lượt quá ngắn, và test sẽ xanh mà chưa hề chạm vào cửa sổ nó nhắm tới.
      await new Promise((settle) => setTimeout(settle, 1));
      await lease.write(
        nextRevision(current, {
          nodes: [...current.nodes, childNode(`${label}-${index}`, graphId, { graphId })],
        }),
      );
    });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});

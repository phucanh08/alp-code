import { FileThreadStore } from "../../src/thread/file-thread-store";
import { EMPTY_THREAD_CONTEXT_DIGEST } from "../../src/thread/types";

/**
 * Một process ngoài, ghi vào cùng một Thread.
 *
 * Nửa còn lại của câu hỏi mà suite in-process không hỏi được: hàng đợi trong bộ nhớ của
 * `FileThreadStore` làm mọi lease trong một process nối tiếp nhau, nên một lỗi khoá thư mục
 * vẫn cho suite ấy xanh. Chỉ khi mỗi bên chỉ nhìn thấy đĩa thì lost update mới lộ ra — dưới
 * dạng revision cuối nhỏ hơn tổng số lần ghi, hoặc một `sequence` bị lặp.
 *
 * Mỗi lượt reserve rồi settle ngay một root execution trong cùng một commit, để invariant 3
 * (sequence liên tục) cũng phải đúng qua nhiều process chứ không chỉ revision.
 *
 *   node test/fixtures/run-typescript.cjs test/fixtures/thread-store-writer.ts \
 *     <root> <threadId> <label> <writes>
 */
async function main(): Promise<void> {
  const [root, threadId, label, writes] = process.argv.slice(3) as [string, string, string, string];
  const store = new FileThreadStore({ root, lockTimeoutMs: 30_000 });
  for (let index = 0; index < Number(writes); index += 1) {
    await store.withExclusiveLease(threadId, async (lease) => {
      const current = lease.current();
      // Nhường thread giữa read và commit, để cửa sổ lost update thật sự mở ra.
      await new Promise((settle) => setTimeout(settle, 1));
      const now = new Date().toISOString();
      await lease.commit({
        ...current,
        revision: current.revision + 1,
        updatedAt: now,
        executions: [
          ...current.executions,
          {
            executionId: `exec_${label}_${index}`,
            sequence: current.executions.length + 1,
            contextRevision: 0,
            contextDigest: EMPTY_THREAD_CONTEXT_DIGEST,
            reservedAt: now,
            settled: { outcome: "completed", finishedAt: now, nextContextRevision: null },
          },
        ],
      });
    });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});

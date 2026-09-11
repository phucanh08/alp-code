import { writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import {
  ExecutionGraphService,
  readBindingFromEnvironment,
  type ChildRequest,
  type ExecutionBinding,
} from "../../src/execution/graph/execution-graph-service";
import { FileExecutionGraphStore } from "../../src/execution/graph/file-execution-graph-store";
import { isExecutionGraphError } from "../../src/execution/graph/errors";

/**
 * Một CLI process khác, đứng trong cùng một cây.
 *
 * Cái mà một suite in-process không hỏi được: hàng đợi lease trong bộ nhớ của store làm mọi
 * thao tác của *một* process nối tiếp nhau, nên trần vẫn đúng kể cả khi khoá liên-process
 * hỏng. Chỗ đứng của process này tới qua env — đúng bốn biến mà một delegate thật nhận —
 * nên một capability không truyền được qua ranh giới process sẽ hỏng ở đây chứ không ở một
 * lần trao tay trong bộ nhớ.
 *
 * Chạy qua `test/fixtures/run-typescript.cjs`:
 *   node test/fixtures/run-typescript.cjs test/fixtures/execution-graph-actor.ts \
 *     <root> <mode> <label> <count> [markerFile] [releaseFile]
 */

function request(label: string, index: number): ChildRequest {
  return {
    requestId: `${label}-${index}`,
    agentId: "search",
    task: `task ${label} ${index}`,
    workspace: "/project",
    workspaceMode: "read-only",
    mode: "medium",
    background: true,
    interactive: false,
    timeoutMs: null,
    metadata: {},
  };
}

function codeOf(error: unknown): string {
  if (isExecutionGraphError(error)) return error.code;
  return (error as Error)?.message ?? String(error);
}

const forever = (): Promise<never> => new Promise(() => {
  setInterval(() => {}, 1000);
});

async function waitForFile(file: string): Promise<void> {
  while (!existsSync(file)) await new Promise((settle) => setTimeout(settle, 10));
}

async function main(): Promise<void> {
  const [root, mode, label, count, markerFile, releaseFile] = process.argv.slice(3);
  const binding = readBindingFromEnvironment(process.env) as ExecutionBinding;
  if (!binding) throw new Error("no execution binding in the environment");
  const service = new ExecutionGraphService({
    store: new FileExecutionGraphStore({ root, lockTimeoutMs: 30_000 }),
  });

  if (mode === "spawn-children") {
    const started: string[] = [];
    const refused: string[] = [];
    for (let index = 0; index < Number(count); index += 1) {
      try {
        const reserved = await service.reserveChild(binding, request(label, index));
        if (reserved.kind === "existing") {
          refused.push("EXISTING");
          continue;
        }
        // Nhường thread giữa giữ chỗ và đăng ký: không có nó thì mỗi lượt quá ngắn để hai
        // process thật sự chồng lên nhau, và trần chưa từng bị thử.
        await new Promise((settle) => setTimeout(settle, 1));
        await service.startReservedChild(reserved, async () => undefined);
        started.push(reserved.binding.executionId);
      } catch (error) {
        refused.push(codeOf(error));
      }
    }
    process.stdout.write(JSON.stringify({ started, refused }));
    return;
  }

  if (mode === "reserve-and-hang") {
    const reserved = await service.reserveChild(binding, request(label, 0));
    writeFileSync(markerFile as string, JSON.stringify(reserved));
    await forever();
  }

  if (mode === "start-after-release") {
    const reserved = await service.reserveChild(binding, request(label, 0));
    writeFileSync(markerFile as string, JSON.stringify(reserved));
    await waitForFile(releaseFile as string);
    let registered = false;
    try {
      await service.startReservedChild(reserved as never, async () => { registered = true; });
      process.stdout.write(JSON.stringify({ outcome: "started", registered }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ outcome: "refused", code: codeOf(error), registered }));
    }
    return;
  }

  if (mode === "run-and-hang") {
    const reserved = await service.reserveChild(binding, request(label, 0));
    if (reserved.kind === "existing") throw new Error("unexpected existing child");
    await service.startReservedChild(reserved, async () => undefined);
    writeFileSync(markerFile as string, reserved.binding.executionId);
    await forever();
  }

  throw new Error(`unknown actor mode \`${mode}\``);
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});

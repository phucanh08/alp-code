import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ExecutionId } from "../types";
import { ExecutionGraphError } from "./errors";
import {
  freezeGraph,
  validateGraphWrite,
  type ExecutionGraphLease,
  type ExecutionGraphStore,
} from "./execution-graph-store";
import { assertGraphDocument } from "./invariants";
import type { ExecutionGraphDocument, ExecutionGraphId } from "./types";

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;
const LOCK_POLL_MS = 25;

interface LockOwner {
  readonly pid: number;
  readonly host: string;
  readonly acquiredAt: string;
}

interface LocatorDocument {
  readonly version: 1;
  readonly graphId: string;
}

function assertGraphId(graphId: string): string {
  if (
    graphId.length === 0 ||
    graphId === "." ||
    graphId === ".." ||
    graphId.includes("/") ||
    graphId.includes("\\") ||
    graphId.startsWith(".")
  ) {
    throw new ExecutionGraphError("EXECUTION_GRAPH_INVALID", `invalid execution graph ID \`${graphId}\``);
  }
  return graphId;
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((settle) => setTimeout(settle, milliseconds));
}

/**
 * Process này còn sống không, xét từ góc nhìn của một khoá.
 *
 * `EPERM` là còn sống: process tồn tại nhưng thuộc người khác. Trả `null` nghĩa là **không
 * chứng minh được** — khoá của một máy khác trên một thư mục chia sẻ chẳng hạn — và chỗ gọi
 * phải coi đó là còn sống, không phải đã chết. Cướp một khoá còn sống là cách hai process
 * cùng ghi một cây, đúng thứ file này tồn tại để chặn.
 */
function ownerAlive(owner: LockOwner): boolean | null {
  if (owner.host !== hostname()) return null;
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) return null;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM" ? true : false;
  }
}

/**
 * Graph JSON dưới `~/.alp/execution-graphs/`, một file cho mỗi cây.
 *
 * Cùng khuôn với `FileLocalExecutionStore` — thư mục khoá vì `mkdir` là nguyên tử ở mọi
 * filesystem chỗ này chạy, ghi tạm rồi `rename` vì `rename` cũng nguyên tử trong một thư
 * mục. Khác hai chỗ, và cả hai đều cố ý:
 *
 * 1. Khoá ở đây giữ suốt một thao tác nhiều bước — kể cả `backend.spawn()` — chứ không chỉ
 *    quanh một lần đọc-sửa-ghi. Đó là thứ đóng cửa sổ "node đã attach nhưng backend chưa
 *    thấy", nơi một lệnh cancel đi qua mà không tìm thấy gì để dừng.
 * 2. Khoá quá hạn **không** bị cướp chỉ vì nó cũ. Chỉ khi chứng minh được process chủ đã
 *    chết. Không chứng minh được thì hết giờ và fail — chậm và đúng, thay vì nhanh và có hai
 *    người cùng ghi.
 */
export class FileExecutionGraphStore implements ExecutionGraphStore {
  private readonly root: string;
  private readonly locatorDirectory: string;
  /**
   * Chờ bao lâu trước khi bỏ cuộc với một khoá người khác đang giữ.
   *
   * Năm giây trong production. Mở ra được vì lease này giữ qua cả `backend.spawn()`, nên một
   * caller ở máy chậm có thể cần chờ lâu hơn — và vì một test chứng minh "khoá còn sống thì
   * không bị cướp" phải chờ hết đúng khoảng này, và năm giây nhân số lần chạy là một suite
   * chậm không nói thêm điều gì.
   */
  private readonly lockTimeoutMs: number;
  /**
   * Hàng đợi trong process, trên cùng một graph.
   *
   * Khoá thư mục một mình đủ cho hai process, nhưng trong một process thì hai lease chồng
   * nhau chỉ nhìn thấy pid của chính mình đang sống và cùng chờ tới lúc hết giờ. Xếp hàng ở
   * đây biến chuyện đó thành nối tiếp, đúng như giữa hai process.
   */
  private readonly queues = new Map<ExecutionGraphId, Promise<unknown>>();

  constructor(options: { readonly root: string; readonly lockTimeoutMs?: number }) {
    this.root = resolve(options.root);
    this.locatorDirectory = join(this.root, "by-execution");
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  }

  async create(graph: ExecutionGraphDocument): Promise<void> {
    const document = assertGraphDocument(graph);
    assertGraphId(document.graphId);
    await this.ensureRoot();
    const file = this.graphFile(document.graphId);
    try {
      // `wx` là chỗ duy nhất không đi qua temp+rename: nó phải hỏng khi file đã có, và
      // `rename` thì lặng lẽ đè — hai process cùng tạo một root sẽ có một bên mất cây.
      await writeFile(file, serialize(document), { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ExecutionGraphError(
          "EXECUTION_GRAPH_EXISTS",
          `execution graph \`${document.graphId}\` already exists`,
        );
      }
      throw error;
    }
    await this.writeLocators(document);
  }

  async get(graphId: ExecutionGraphId): Promise<ExecutionGraphDocument | null> {
    assertGraphId(graphId);
    return this.readGraph(this.graphFile(graphId));
  }

  async findByExecutionId(executionId: ExecutionId): Promise<ExecutionGraphDocument | null> {
    // Root mở thẳng: `graphId === rootExecutionId`, nên với node ngoài cùng không có bảng tra
    // nào tham gia được vào câu trả lời sai.
    if (!executionId.includes("/") && !executionId.includes("\\") && !executionId.startsWith(".")) {
      const direct = await this.readGraph(this.graphFile(executionId));
      if (direct?.nodes.some((node) => node.executionId === executionId)) return direct;
    }
    const located = await this.readLocator(executionId);
    if (located) {
      const graph = await this.readGraph(this.graphFile(located));
      // Locator chỉ là gợi ý. Trỏ tới graph không chứa node thì nó sai, và câu trả lời nằm
      // ở lần quét bên dưới chứ không ở nó.
      if (graph?.nodes.some((node) => node.executionId === executionId)) return graph;
    }
    return this.scanForExecution(executionId);
  }

  async withExclusiveLease<T>(
    graphId: ExecutionGraphId,
    operation: (lease: ExecutionGraphLease) => Promise<T>,
  ): Promise<T> {
    assertGraphId(graphId);
    const previous = this.queues.get(graphId) ?? Promise.resolve();
    const run = previous.then(
      () => this.runLeased(graphId, operation),
      () => this.runLeased(graphId, operation),
    );
    this.queues.set(graphId, run.then(() => undefined, () => undefined));
    return run;
  }

  private async runLeased<T>(
    graphId: ExecutionGraphId,
    operation: (lease: ExecutionGraphLease) => Promise<T>,
  ): Promise<T> {
    await this.ensureRoot();
    const release = await this.acquireLock(graphId);
    try {
      // Đọc lại **sau** khi cầm khoá. Bản caller đã đọc trước đó có thể đã cũ, và mọi trần
      // tính trên nó sẽ là trần của một cây không còn tồn tại.
      const initial = await this.readGraph(this.graphFile(graphId));
      if (!initial) {
        throw new ExecutionGraphError(
          "EXECUTION_GRAPH_NOT_FOUND",
          `execution graph \`${graphId}\` does not exist`,
        );
      }
      let current = initial;
      const lease: ExecutionGraphLease = {
        graphId,
        read: async () => freezeGraph(current),
        write: async (next) => {
          const document = validateGraphWrite(current, next);
          await this.writeJson(this.graphFile(graphId), document);
          current = freezeGraph(document);
          await this.writeLocators(document);
          return current;
        },
      };
      return await operation(lease);
    } finally {
      await release();
    }
  }

  private async acquireLock(graphId: ExecutionGraphId): Promise<() => Promise<void>> {
    const lockDirectory = `${this.graphFile(graphId)}.lock`;
    const ownerFile = join(lockDirectory, "owner.json");
    const owner: LockOwner = { pid: process.pid, host: hostname(), acquiredAt: new Date().toISOString() };
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        await mkdir(lockDirectory, { mode: 0o700 });
        await writeFile(ownerFile, `${JSON.stringify(owner, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        return async () => { await rm(lockDirectory, { recursive: true, force: true }); };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await this.reclaimIfDead(lockDirectory, ownerFile)) continue;
        if (Date.now() >= deadline) {
          throw new ExecutionGraphError(
            "EXECUTION_GRAPH_LOCK_TIMEOUT",
            `timed out after ${this.lockTimeoutMs}ms waiting for the lease on execution graph \`${graphId}\``,
          );
        }
        await sleep(LOCK_POLL_MS);
      }
    }
  }

  /** Đúng khi khoá vừa được thu hồi vì chủ nó đã chết và nó đã quá hạn. */
  private async reclaimIfDead(lockDirectory: string, ownerFile: string): Promise<boolean> {
    let age: number;
    try {
      age = Date.now() - (await stat(lockDirectory)).mtimeMs;
    } catch {
      // Chủ khoá đã nhả giữa lần `mkdir` hỏng và lần `stat` này. Thử lại ngay.
      return true;
    }
    if (age <= STALE_LOCK_MS) return false;
    let owner: LockOwner;
    try {
      owner = JSON.parse(await readFile(ownerFile, "utf8")) as LockOwner;
    } catch {
      // Khoá cũ mà không nói được ai giữ. Không chứng minh được là đã chết, nên để yên và
      // để hết giờ nói ra chuyện đó — im lặng cướp nó là mở lại đúng cửa sổ này.
      return false;
    }
    if (ownerAlive(owner) !== false) return false;
    await rm(lockDirectory, { recursive: true, force: true });
    return true;
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.locatorDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700).catch(() => undefined);
    await chmod(this.locatorDirectory, 0o700).catch(() => undefined);
  }

  private graphFile(graphId: string): string {
    return join(this.root, `${graphId}.json`);
  }

  private locatorFile(executionId: string): string {
    // Execution ID đi vào tên file, nên nó phải không thoát được thư mục. Băm là thừa ở đây
    // — ID do ALP sinh — nhưng một ID đến từ argv thì không, và chỗ này không phân biệt được.
    const safe = executionId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
    return join(this.locatorDirectory, `${safe}.json`);
  }

  private async readGraph(file: string): Promise<ExecutionGraphDocument | null> {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new ExecutionGraphError(
        "EXECUTION_GRAPH_CORRUPT",
        `execution graph at ${file} is not valid JSON`,
        { cause: error },
      );
    }
    try {
      return freezeGraph(assertGraphDocument(parsed));
    } catch (error) {
      throw new ExecutionGraphError(
        "EXECUTION_GRAPH_CORRUPT",
        `execution graph at ${file} is unusable: ${(error as Error).message}`,
        { cause: error },
      );
    }
  }

  private async readLocator(executionId: string): Promise<string | null> {
    try {
      const parsed = JSON.parse(await readFile(this.locatorFile(executionId), "utf8")) as Partial<LocatorDocument>;
      return typeof parsed.graphId === "string" && parsed.graphId.length > 0 ? parsed.graphId : null;
    } catch {
      return null;
    }
  }

  /**
   * Quét mọi graph để tìm node, rồi sửa lại locator.
   *
   * Chỉ chạy khi locator thiếu, cũ hoặc hỏng — locator không phải authority, nên nó sai
   * không được phép là câu trả lời cuối. Tuyến tính theo số graph còn giữ; ở quy mô P0 đó là
   * hàng chục file, và một benchmark cho nó là tối ưu hoá cho một vấn đề chưa tồn tại.
   */
  private async scanForExecution(executionId: ExecutionId): Promise<ExecutionGraphDocument | null> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let corrupt: ExecutionGraphError | null = null;
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry.startsWith(".")) continue;
      let graph: ExecutionGraphDocument | null;
      try {
        graph = await this.readGraph(join(this.root, entry));
      } catch (error) {
        // Một graph hỏng không phải câu trả lời, nhưng nó cũng không được biến mất: nếu
        // không tìm thấy node ở đâu khác thì "không có graph" là một câu trả lời chưa chắc,
        // và nó sẽ đẩy caller sang đường legacy nơi cây này không còn trần nào.
        corrupt = error as ExecutionGraphError;
        continue;
      }
      if (graph?.nodes.some((node) => node.executionId === executionId)) {
        await this.writeLocator(executionId, graph.graphId).catch(() => undefined);
        return graph;
      }
    }
    if (corrupt) throw corrupt;
    return null;
  }

  private async writeLocators(graph: ExecutionGraphDocument): Promise<void> {
    for (const node of graph.nodes) {
      if (node.executionId === graph.graphId) continue;
      await this.writeLocator(node.executionId, graph.graphId);
    }
  }

  private async writeLocator(executionId: string, graphId: string): Promise<void> {
    await mkdir(this.locatorDirectory, { recursive: true, mode: 0o700 });
    await this.writeJson(this.locatorFile(executionId), { version: 1, graphId } satisfies LocatorDocument);
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    // Temp nằm cùng thư mục với đích, vì `rename` chỉ nguyên tử trong một filesystem.
    const temporary = join(dirname(file), `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, serialize(value), { encoding: "utf8", mode: 0o600 });
      await rename(temporary, file);
      await chmod(file, 0o600);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

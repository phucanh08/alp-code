import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();

/**
 * Những module quyết định quyền và danh tính. Không cái nào được nhìn thấy `src/thread/`:
 * Thread là input của snapshot (binding đi qua `ExecutionService.materialize`), không phải
 * thứ một PolicyEngine, một graph hay một backend tra cứu lúc quyết định.
 */
const authorityRoots = ["src/policy", "src/execution/graph", "src/delegation", "src/backend", "src/hooks"] as const;
const threadImport = /from\s+["'][^"']*\/thread\/[^"']*["']/;

async function collectFiles(relativePath: string): Promise<string[]> {
  const absolutePath = path.join(repositoryRoot, relativePath);
  const entries = await readdir(absolutePath, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const child = path.join(relativePath, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(child)));
    else if (entry.name.endsWith(".ts")) files.push(child);
  }
  return files;
}

function posix(file: string): string {
  return file.split(path.sep).join("/");
}

describe("thread is a unit of work, not a unit of authority", () => {
  it("keeps every authority module free of any import from src/thread/", async () => {
    const violations: string[] = [];
    for (const root of authorityRoots) {
      for (const file of await collectFiles(root)) {
        const source = await readFile(path.join(repositoryRoot, file), "utf8");
        if (threadImport.test(source)) violations.push(posix(file));
      }
    }
    expect(violations).toEqual([]);
  });

  /**
   * `ALP_THREAD_ID` là nhãn. Chỗ duy nhất đọc nó là `alp thread show` không đối số; chỗ duy
   * nhất ghi nó là env chung của runtime. Một reader thứ ba — nhất là trong hook hay policy —
   * là chỗ một biến env tự đặt bắt đầu có nghĩa.
   */
  it("reads ALP_THREAD_ID in exactly one place, and never inside hooks or policy", async () => {
    const readers: string[] = [];
    for (const root of ["src", "hooks"]) {
      for (const file of await collectFiles(root)) {
        const source = await readFile(path.join(repositoryRoot, file), "utf8");
        if (/env\.ALP_THREAD_ID|\["?ALP_THREAD_ID"?\]/.test(source)) readers.push(posix(file));
      }
    }
    expect(readers).toEqual(["src/cli/commands/thread.ts"]);
  });
});

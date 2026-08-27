import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseMemoryId } from "../memory-service";

function isWithin(root: string, target: string): boolean {
  const relation = relative(root, target);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

async function nearestExistingDirectory(path: string): Promise<string> {
  let candidate = path;
  while (true) {
    try {
      const metadata = await lstat(candidate);
      if (metadata.isDirectory() || metadata.isSymbolicLink()) return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
}

export class MemoryPathMapper {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  pathFor(id: string): string {
    const parsed = parseMemoryId(id);
    const directories = parsed.pathSegments.slice(0, -1);
    const filename = `${parsed.pathSegments.at(-1)!}.md`;
    const path =
      parsed.scope === "shared"
        ? join(this.root, "shared", ...directories, filename)
        : parsed.scope === "project"
          ? join(this.root, "projects", parsed.projectId!, ...directories, filename)
          : join(this.root, "private", parsed.ownerRole!, ...directories, filename);
    if (!isWithin(this.root, path)) throw new Error(`memory path escapes root for \`${id}\``);
    return path;
  }

  async safePathFor(id: string, createParent = false): Promise<string> {
    const path = this.pathFor(id);
    await mkdir(this.root, { recursive: true });
    const rootReal = await realpath(this.root);
    const existingParent = await nearestExistingDirectory(dirname(path));
    const existingReal = await realpath(existingParent);
    if (!isWithin(rootReal, existingReal)) {
      throw new Error(`memory path symlink escape for \`${id}\``);
    }
    if (createParent) {
      await mkdir(dirname(path), { recursive: true });
      const parentReal = await realpath(dirname(path));
      if (!isWithin(rootReal, parentReal)) {
        throw new Error(`memory path symlink escape for \`${id}\``);
      }
    }
    try {
      const targetMetadata = await lstat(path);
      if (targetMetadata.isSymbolicLink()) {
        throw new Error(`memory path symlink escape for \`${id}\``);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return path;
  }
}

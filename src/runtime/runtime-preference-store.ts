import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RuntimeId } from "./types";

export interface RuntimePreferenceRead {
  readonly runtime: RuntimeId | null;
  readonly warning?: string;
}

export interface RuntimePreferenceStore {
  read(): Promise<RuntimePreferenceRead>;
  write(runtime: RuntimeId): Promise<void>;
}

export interface FileRuntimePreferenceStoreOptions {
  readonly file?: string;
}

function isRuntimeId(value: unknown): value is RuntimeId {
  return value === "claude" || value === "codex";
}

export class FileRuntimePreferenceStore implements RuntimePreferenceStore {
  private readonly file: string;

  constructor(options: FileRuntimePreferenceStoreOptions = {}) {
    this.file = options.file ?? join(homedir(), ".alp", "runtime.json");
  }

  async read(): Promise<RuntimePreferenceRead> {
    let content: string;
    try {
      content = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { runtime: null };
      }
      return {
        runtime: null,
        warning: `invalid runtime preference at ${this.file}; using Claude default`,
      };
    }

    try {
      const parsed = JSON.parse(content) as { runtime?: unknown };
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        !isRuntimeId(parsed.runtime)
      ) {
        throw new Error("invalid runtime");
      }
      return { runtime: parsed.runtime };
    } catch {
      return {
        runtime: null,
        warning: `invalid runtime preference at ${this.file}; using Claude default`,
      };
    }
  }

  async write(runtime: RuntimeId): Promise<void> {
    if (!isRuntimeId(runtime)) {
      throw new Error(`invalid runtime \`${String(runtime)}\``);
    }
    const directory = dirname(this.file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = join(directory, `.${randomUUID()}.runtime.tmp`);
    try {
      await writeFile(
        temporary,
        `${JSON.stringify({ runtime })}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      await chmod(temporary, 0o600);
      await rename(temporary, this.file);
      await chmod(this.file, 0o600);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

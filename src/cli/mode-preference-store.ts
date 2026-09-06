import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_MODE, isModeId, type ModeId } from "../agents/modes";

export interface ModePreferenceRead {
  readonly mode: ModeId | null;
  readonly warning?: string;
}

export interface ModePreferenceStore {
  read(): Promise<ModePreferenceRead>;
  write(mode: ModeId): Promise<void>;
}

export interface FileModePreferenceStoreOptions {
  readonly file?: string;
}

export class FileModePreferenceStore implements ModePreferenceStore {
  private readonly file: string;

  constructor(options: FileModePreferenceStoreOptions = {}) {
    this.file = options.file ?? join(homedir(), ".alp", "mode.json");
  }

  async read(): Promise<ModePreferenceRead> {
    let content: string;
    try {
      content = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { mode: null };
      }
      return {
        mode: null,
        warning: `invalid mode preference at ${this.file}; using \`${DEFAULT_MODE}\``,
      };
    }

    try {
      const parsed = JSON.parse(content) as { mode?: unknown };
      if (parsed === null || typeof parsed !== "object" || !isModeId(parsed.mode)) {
        throw new Error("invalid mode");
      }
      return { mode: parsed.mode };
    } catch {
      return {
        mode: null,
        warning: `invalid mode preference at ${this.file}; using \`${DEFAULT_MODE}\``,
      };
    }
  }

  async write(mode: ModeId): Promise<void> {
    if (!isModeId(mode)) {
      throw new Error(`invalid mode \`${String(mode)}\``);
    }
    const directory = dirname(this.file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = join(directory, `.${randomUUID()}.mode.tmp`);
    try {
      await writeFile(
        temporary,
        `${JSON.stringify({ mode })}\n`,
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

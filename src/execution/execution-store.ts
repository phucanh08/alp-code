import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ExecutionArtifactPaths,
  ExecutionPolicy,
  StoredExecutionState,
} from "./types";

export interface PersistExecutionInput {
  readonly policy: ExecutionPolicy;
  readonly state: StoredExecutionState;
}

export interface ExecutionStore {
  create(input: PersistExecutionInput): Promise<ExecutionArtifactPaths>;
}

export interface FileExecutionStoreOptions {
  readonly root?: string;
}

function assertExecutionId(id: string): void {
  if (
    id.length === 0 ||
    id === "." ||
    id === ".." ||
    id.includes("/") ||
    id.includes("\\")
  ) {
    throw new Error(`invalid execution ID \`${id}\``);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeSnapshot(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await chmod(path, 0o600);
}

export class FileExecutionStore implements ExecutionStore {
  private readonly root: string;

  constructor(options: FileExecutionStoreOptions = {}) {
    this.root = options.root ?? join(homedir(), ".alp", "executions");
  }

  async create(input: PersistExecutionInput): Promise<ExecutionArtifactPaths> {
    if (input.policy.executionId !== input.state.executionId) {
      throw new Error("policy and execution state IDs do not match");
    }
    assertExecutionId(input.policy.executionId);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);

    const directory = join(this.root, input.policy.executionId);
    if (await pathExists(directory)) {
      throw new Error(`execution \`${input.policy.executionId}\` already exists`);
    }
    const staging = join(
      this.root,
      `.${input.policy.executionId}.${randomUUID()}.tmp`,
    );
    const policyFileName = "policy.json";
    const stateFileName = "state.json";
    try {
      await mkdir(staging, { mode: 0o700 });
      await mkdir(join(staging, "runtime"), { mode: 0o700 });
      await writeSnapshot(join(staging, policyFileName), input.policy);
      await writeSnapshot(join(staging, stateFileName), input.state);
      await rename(staging, directory);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }

    return Object.freeze({
      directory,
      stateFile: join(directory, stateFileName),
      policyFile: join(directory, policyFileName),
      runtimeDirectory: join(directory, "runtime"),
    });
  }
}

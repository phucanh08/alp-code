export class InvalidMemoryIdError extends Error {
  constructor(readonly id: string) {
    super(`invalid logical memory ID \`${id}\``);
    this.name = "InvalidMemoryIdError";
  }
}

export class UnauthorizedMemoryAccessError extends Error {
  constructor(
    readonly actor: string,
    readonly operation: "read" | "write",
    readonly scope: string,
    readonly code: string,
  ) {
    super(`\`${actor}\` cannot ${operation} memory scope \`${scope}\`: ${code}`);
    this.name = "UnauthorizedMemoryAccessError";
  }
}

export class MemoryVersionConflictError extends Error {
  constructor(
    readonly id: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `memory \`${id}\` version conflict: expected ${expectedVersion}, actual ${actualVersion}`,
    );
    this.name = "MemoryVersionConflictError";
  }
}

export class MemoryEntryNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`memory \`${id}\` does not exist`);
    this.name = "MemoryEntryNotFoundError";
  }
}

export class MemoryEntryAlreadyExistsError extends Error {
  constructor(readonly id: string) {
    super(`memory \`${id}\` already exists`);
    this.name = "MemoryEntryAlreadyExistsError";
  }
}

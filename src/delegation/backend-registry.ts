import type { ExecutionBackend } from "../backend/execution-backend";
import { DelegationError } from "./types";

const REQUIRED_METHODS: readonly (keyof ExecutionBackend)[] = [
  "healthCheck",
  "spawn",
  "status",
  "wait",
  "cancel",
  "cleanup",
];

export class BackendRegistry {
  private readonly backends = new Map<string, ExecutionBackend>();

  register<T extends ExecutionBackend>(backend: T): this {
    if (!backend.name.trim()) throw new DelegationError("INVALID_REQUEST", "backend name cannot be empty");
    if (this.backends.has(backend.name)) {
      throw new DelegationError("INVALID_REQUEST", `backend \`${backend.name}\` is already registered`);
    }
    for (const method of REQUIRED_METHODS) {
      if (typeof backend[method] !== "function") {
        throw new DelegationError("INVALID_REQUEST", `backend \`${backend.name}\` is missing ${method}()`);
      }
    }
    this.backends.set(backend.name, backend);
    return this;
  }

  resolve(name: string): ExecutionBackend {
    const backend = this.backends.get(name);
    if (!backend) {
      throw new DelegationError(
        "BACKEND_UNAVAILABLE",
        `backend \`${name}\` is not registered (available: ${this.names().join(", ") || "none"})`,
      );
    }
    return backend;
  }

  names(): readonly string[] {
    return Object.freeze([...this.backends.keys()]);
  }
}

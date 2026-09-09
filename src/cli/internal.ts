import { readFileSync, statSync } from "node:fs";
import type { LocalSupervisorSpec } from "../backend/local-supervisor";

const MAX_SPEC_BYTES = 1024 * 1024;

export type InternalCommand =
  | { readonly command: "ensure-state" }
  | { readonly command: "update-check" }
  | { readonly command: "supervisor"; readonly specFile: string };

export function parseInternalCommand(argv: readonly string[]): InternalCommand {
  if (argv[0] === "ensure-state" && argv.length === 1) return { command: "ensure-state" };
  if (argv[0] === "update-check" && argv.length === 1) return { command: "update-check" };
  if (argv[0] === "supervisor" && argv.length === 2) return { command: "supervisor", specFile: argv[1] };
  if (argv[0] === "supervisor") throw new Error("internal supervisor requires exactly one spec file");
  throw new Error(`unknown internal command: ${argv[0] ?? ""}`);
}

function readSupervisorSpec(file: string): LocalSupervisorSpec {
  const stat = statSync(file);
  if (!stat.isFile()) throw new Error("supervisor spec must be a regular file");
  if (stat.size > MAX_SPEC_BYTES) throw new Error(`supervisor spec is too large (${stat.size} > ${MAX_SPEC_BYTES})`);
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("supervisor spec must have mode 0600");
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { throw new Error(`invalid supervisor spec JSON: ${(error as Error).message}`); }
  const spec = value as Partial<LocalSupervisorSpec>;
  if (
    typeof spec.executionId !== "string" || typeof spec.command !== "string" ||
    !Array.isArray(spec.args) || !spec.args.every((value) => typeof value === "string") ||
    typeof spec.cwd !== "string" || typeof spec.env !== "object" || spec.env === null ||
    typeof spec.logFile !== "string" || typeof spec.resultFile !== "string" ||
    !Array.isArray(spec.temporaryFiles) || !spec.temporaryFiles.every((value) => typeof value === "string")
  ) throw new Error("invalid supervisor spec schema");
  return { ...(spec as LocalSupervisorSpec), specFile: file };
}

export interface InternalDependencies {
  readonly ensureState: () => void | Promise<void>;
  readonly refreshUpdateCheck: () => void | Promise<void>;
  readonly supervise: (spec: LocalSupervisorSpec) => void | Promise<void>;
}

export async function runInternalCommand(argv: readonly string[], dependencies: InternalDependencies): Promise<number> {
  const command = parseInternalCommand(argv);
  if (command.command === "ensure-state") await dependencies.ensureState();
  else if (command.command === "update-check") await dependencies.refreshUpdateCheck();
  else await dependencies.supervise(readSupervisorSpec(command.specFile));
  return 0;
}

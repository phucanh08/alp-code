import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { accessSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { RuntimeId } from "../agents/types";
import { agentRegistry } from "../agents/registry";
import { LocalProcessBackend } from "../backend/local-process-backend";
import { ExecutionService } from "../execution/execution-service";
import { FileExecutionStore } from "../execution/execution-store";
import { MarkdownFileStore } from "../memory/adapters/markdown-file-store";
import { MemoryService } from "../memory/memory-service";
import { PolicyEngine } from "../policy/policy-engine";
import { ClaudeRuntimeAdapter } from "../runtime/claude-adapter";
import { CodexRuntimeAdapter } from "../runtime/codex-adapter";
import { RuntimeSelector } from "../runtime/runtime-selector";
import { WorkflowRunner } from "../workflow/workflow-runner";
import { runContextCommand } from "./commands/context";
import { createDefaultDelegationComposition, runDelegateCommand, runDelegationLifecycleCommand } from "./commands/delegate";
import { syncIdentityDocuments } from "./commands/identity-sync";
import { deinitializeProject, initializeProject, ProjectRegistryStore } from "./commands/init";
import { ensurePrincipalProfile, runPrincipalCommand, type PrincipalCommandInput } from "./commands/principal";
import { runMainSession, type RunMainInput } from "./commands/run-main";
import { runRuntimeCommand, type RuntimeCommandInput } from "./commands/runtime";
import { checkForUpdate, FileUpdateCheckStore } from "./update-check";

export type AlpCommand =
  | { readonly command: "run-main"; readonly runtime?: RuntimeId }
  | { readonly command: "runtime"; readonly action: "show" | "set"; readonly runtime?: RuntimeId }
  | { readonly command: "init"; readonly project?: string }
  | { readonly command: "deinit"; readonly project?: string }
  | { readonly command: "identity"; readonly action: "sync" }
  | { readonly command: "principal"; readonly action: "show" | "set" }
  | { readonly command: "delegate"; readonly args: readonly string[] }
  | { readonly command: "delegation"; readonly args: readonly string[] }
  | { readonly command: "context"; readonly args: readonly string[] }
  | { readonly command: "maintenance"; readonly action: "doctor" | "update" | "uninstall"; readonly args: readonly string[] }
  | { readonly command: "version" }
  | { readonly command: "help" };

function runtimeId(value: string | undefined): RuntimeId {
  if (value !== "claude" && value !== "codex") throw new Error(`runtime must be claude or codex, got \`${value ?? ""}\``);
  return value;
}

export function parseAlpArgs(argv: readonly string[]): AlpCommand {
  if (argv.length === 0) return { command: "run-main" };
  const runtimeFlags = argv.filter((value) => value === "--runtime" || value.startsWith("--runtime="));
  if (runtimeFlags.length > 1) throw new Error("multiple runtime selections are not allowed");
  if (argv[0] === "--runtime") {
    if (argv.length !== 2) throw new Error("alp --runtime accepts exactly one runtime");
    return { command: "run-main", runtime: runtimeId(argv[1]) };
  }
  if (argv[0].startsWith("--runtime=")) {
    if (argv.length !== 1) throw new Error("alp --runtime accepts exactly one runtime");
    return { command: "run-main", runtime: runtimeId(argv[0].slice("--runtime=".length)) };
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    if (argv.length !== 1) throw new Error("alp --version does not accept arguments");
    return { command: "version" };
  }
  if (["claude", "codex", "run-role"].includes(argv[0]) || argv[0] === "--role") {
    throw new Error("direct raw runtime launch is unsupported; use `alp` or `alp --runtime <name>`");
  }
  if (argv[0] === "runtime") {
    if (argv[1] === "show" && argv.length === 2) return { command: "runtime", action: "show" };
    if (argv[1] === "set" && argv.length === 3) return { command: "runtime", action: "set", runtime: runtimeId(argv[2]) };
    throw new Error("usage: alp runtime show | alp runtime set <claude|codex>");
  }
  if (argv[0] === "init") {
    let project: string | undefined;
    for (let index = 1; index < argv.length; index += 1) {
      const value = argv[index];
      if (value.startsWith("-")) throw new Error(`unknown init option \`${value}\``);
      if (project !== undefined) throw new Error("alp init accepts one project path");
      project = value;
    }
    return { command: "init", ...(project ? { project } : {}) };
  }
  if (argv[0] === "deinit") {
    if (argv.length > 2 || argv[1]?.startsWith("-")) throw new Error("usage: alp deinit [path]");
    return { command: "deinit", ...(argv[1] ? { project: argv[1] } : {}) };
  }
  if (argv[0] === "identity") {
    if (argv[1] === "sync" && argv.length === 2) return { command: "identity", action: "sync" };
    throw new Error("usage: alp identity sync");
  }
  if (argv[0] === "principal") {
    if ((argv[1] === "show" || argv[1] === "set") && argv.length === 2) {
      return { command: "principal", action: argv[1] };
    }
    throw new Error("usage: alp principal show | alp principal set");
  }
  if (argv[0] === "delegate") return { command: "delegate", args: Object.freeze(argv.slice(1)) };
  if (argv[0] === "delegation") return { command: "delegation", args: Object.freeze(argv.slice(1)) };
  if (argv[0] === "context") return { command: "context", args: Object.freeze(argv.slice(1)) };
  if (argv[0] === "doctor") {
    if (argv.slice(1).some((value) => value !== "--quiet")) throw new Error("usage: alp doctor [--quiet]");
    return { command: "maintenance", action: "doctor", args: Object.freeze(argv.slice(1)) };
  }
  if (argv[0] === "update") {
    if (argv.length !== 1) throw new Error("alp update does not accept arguments");
    return { command: "maintenance", action: "update", args: Object.freeze([]) };
  }
  if (argv[0] === "uninstall") {
    if (argv.slice(1).some((value) => value !== "--purge-memory" && value !== "--force")) {
      throw new Error("usage: alp uninstall [--purge-memory] [--force]");
    }
    return { command: "maintenance", action: "uninstall", args: Object.freeze(argv.slice(1)) };
  }
  if (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") return { command: "help" };
  throw new Error(`unknown command \`${argv[0]}\``);
}

export interface AlpIo {
  write(text: string): unknown;
}

export interface AlpDependencies {
  readonly cwd: string;
  readonly stdout: AlpIo;
  readonly stderr: AlpIo;
  readonly version: string;
  readonly checkForUpdate: () => Promise<string | null>;
  readonly runMain: (input: RunMainInput) => Promise<number>;
  readonly runtimeCommand: (input: RuntimeCommandInput) => Promise<number>;
  readonly initProject: (input: { readonly project: string }) => Promise<void>;
  readonly deinitProject: (input: { readonly project: string }) => Promise<void>;
  readonly syncIdentity: () => Promise<void>;
  readonly principalCommand: (input: PrincipalCommandInput) => Promise<number>;
  readonly delegateCommand: (args: readonly string[]) => Promise<number>;
  readonly contextCommand: (args: readonly string[]) => Promise<number>;
  readonly maintenanceCommand: (input: { readonly action: "doctor" | "update" | "uninstall"; readonly args: readonly string[] }) => Promise<number>;
}

function findRepoRoot(start: string): string {
  let directory = resolve(start);
  for (;;) {
    try { accessSync(join(directory, "package.json")); return directory; } catch { /* continue */ }
    const parent = dirname(directory);
    if (parent === directory) throw new Error("cannot locate alp-code repository root");
    directory = parent;
  }
}

function readVersion(repoRoot: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    return typeof parsed?.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function defaultDependencies(cwd: string, stdout: AlpIo, stderr: AlpIo): AlpDependencies {
  const repoRoot = process.env.ALP_REPO_ROOT || findRepoRoot(__dirname);
  const version = readVersion(repoRoot);
  const policy = new PolicyEngine({ registry: agentRegistry });
  const memory = new MemoryService({
    store: new MarkdownFileStore({ root: join(repoRoot, "memory") }),
    policy,
    audit: { record() {} },
  });
  const executionService = new ExecutionService({
    registry: agentRegistry,
    policy,
    memory,
    workflowRunner: new WorkflowRunner(),
    store: new FileExecutionStore({ root: join(process.env.HOME || homedir(), ".alp", "executions") }),
  });
  const adapters = new Map<RuntimeId, ClaudeRuntimeAdapter | CodexRuntimeAdapter>([
    ["claude", new ClaudeRuntimeAdapter({ hooksDirectory: join(repoRoot, "hooks") })],
    // Previously left to default to `ALP_REPO_ROOT` (set by `scripts/alp.cjs`) the way
    // Claude's constructor already falls back too. That implicit path was fine carrying two
    // hooks; wiring two more onto it (PreCompact/PostCompact) turns a coincidence into a
    // real dependency, so it is passed explicitly here like Claude's.
    ["codex", new CodexRuntimeAdapter({ hooksDirectory: join(repoRoot, "hooks") })],
  ]);
  const backend = new LocalProcessBackend();
  const selector = new RuntimeSelector({ output: stdout });
  const projectRegistry = new ProjectRegistryStore();
  return {
    cwd,
    stdout,
    stderr,
    version,
    async checkForUpdate() {
      if (process.env.ALP_SKIP_UPDATE_CHECK === "1") return null;
      try {
        return await checkForUpdate({ repoRoot, store: new FileUpdateCheckStore(), currentVersion: version });
      } catch {
        return null;
      }
    },
    async runMain(input) {
      const result = await runMainSession(input, {
        registry: agentRegistry,
        selector,
        executionService,
        adapters,
        backend,
        executionId: () => `exec_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
        interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
        workspaceModeFor: async (project) => (await projectRegistry.isRegistered(project))
          ? "workspace-write"
          : "read-only",
      });
      return result.status === "completed" ? 0 : result.status === "cancelled" ? 130 : 1;
    },
    async runtimeCommand(input) {
      await runRuntimeCommand(input, { write: (text) => stdout.write(text) });
      return 0;
    },
    async initProject(input) {
      const registered = await initializeProject({ ...input, repoRoot }, { store: projectRegistry });
      // Asked before the identity sync below, because the answers are rendered into every
      // `.alp/agents/<role>.md` this install writes.
      await ensurePrincipalProfile(
        { interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY) },
        { write: (text) => stdout.write(text) },
      );
      // Identity documents are what the SessionStart hook reads; a project registered
      // without them would boot with an empty identity and a warning.
      await syncIdentityDocuments({ repoRoot }, { registry: agentRegistry });
      stdout.write(`READY    ${registered.path}\n`);
    },
    async deinitProject(input) {
      await deinitializeProject({ ...input, repoRoot }, { store: projectRegistry });
      stdout.write(`REMOVED  ${resolve(input.project)}\n`);
    },
    async syncIdentity() {
      const written = await syncIdentityDocuments({ repoRoot }, { registry: agentRegistry });
      for (const file of written) stdout.write(`IDENTITY ${file}\n`);
    },
    async principalCommand(input) {
      return runPrincipalCommand(input, {
        write: (text) => stdout.write(text),
        // A changed name must reach the generated identity documents, or the next native
        // session would boot with the previous one.
        syncIdentity: async () => { await syncIdentityDocuments({ repoRoot }, { registry: agentRegistry }); },
      });
    },
    async delegateCommand(args) {
      const lifecycle = args[0] === "__lifecycle";
      const actual = lifecycle ? args.slice(1) : args;
      const composition = await createDefaultDelegationComposition(repoRoot, process.env);
      const value = lifecycle
        ? await runDelegationLifecycleCommand(actual, composition.service)
        : await runDelegateCommand(actual, { cwd, env: process.env, service: composition.service });
      stdout.write(`${JSON.stringify(value, null, 2)}\n`);
      return typeof value === "object" && value !== null && "status" in value && value.status === "failed" ? 1 : 0;
    },
    async contextCommand(args) {
      return runContextCommand(args, {
        executionsRoot: join(process.env.HOME || homedir(), ".alp", "executions"),
        env: process.env,
        write: (text) => stdout.write(text),
      });
    },
    async maintenanceCommand(input) {
      if (input.action === "doctor") {
        const checked = spawnSync(process.execPath, [join(repoRoot, "scripts", "doctor.cjs"), ...input.args], {
          cwd,
          env: process.env,
          stdio: "inherit",
        });
        if (checked.error) throw checked.error;
        return checked.status ?? 2;
      }
      if (input.action === "update") {
        const updater = createRequire(__filename)(join(repoRoot, "scripts", "lib", "update.cjs")) as {
          updateInstallation(root: string, options: { env: NodeJS.ProcessEnv; stdio: "inherit"; log(level: string, message: string): void }): Promise<{ ok: boolean; message?: string }>;
        };
        const result = await updater.updateInstallation(repoRoot, {
          env: process.env,
          stdio: "inherit",
          log(level, message) { stdout.write(`${level.padEnd(9)}${message}\n`); },
        });
        if (!result.ok) stderr.write(`ERROR     ${result.message ?? "update failed"}\n`);
        return result.ok ? 0 : 1;
      }
      const uninstall = createRequire(__filename)(join(repoRoot, "scripts", "lib", "uninstall.cjs")) as {
        uninstall(root: string, options: { cwd: string; purgeMemory: boolean; force: boolean }): { log: readonly { level: string; text: string }[]; memoryBackup: string | null };
      };
      const result = uninstall.uninstall(repoRoot, {
        cwd,
        purgeMemory: input.args.includes("--purge-memory"),
        force: input.args.includes("--force"),
      });
      for (const entry of result.log) stdout.write(`${entry.level.padEnd(8)} ${entry.text}\n`);
      if (result.memoryBackup) stdout.write(`RESTORE  ${result.memoryBackup}\n`);
      return 0;
    },
  };
}

function helpText(): string {
  return [
    "alp — code-native agent launcher",
    "",
    "  alp [--runtime claude|codex]",
    "  alp runtime show|set <runtime>",
    "  alp init [path]",
    "  alp deinit [path]",
    "  alp identity sync",
    "  alp principal show|set",
    "  alp delegate <role> [options] -- <task>",
    "  alp context status|validate [execution-id]",
    "  alp context pin <decision|constraint|open-item|next-action> -- <text>",
    "  alp context unpin <pin-id>",
    "  alp doctor",
    "  alp update [--verbose]",
    "  alp uninstall [--purge-memory] [--force]",
    "  alp --version",
    "",
    "Direct `claude`, `codex`, and identity-aware raw-runtime shortcuts are unsupported.",
  ].join("\n") + "\n";
}

export async function main(argv: readonly string[] = process.argv.slice(2), injected?: AlpDependencies): Promise<number> {
  const cwd = injected?.cwd ?? process.cwd();
  const stdout = injected?.stdout ?? process.stdout;
  const stderr = injected?.stderr ?? process.stderr;
  const dependencies = injected ?? defaultDependencies(cwd, stdout, stderr);
  const command = parseAlpArgs(argv);
  const notice = await dependencies.checkForUpdate().catch(() => null);
  if (notice) stdout.write(notice);
  if (command.command === "version") { stdout.write(`alp ${dependencies.version}\n`); return 0; }
  if (command.command === "run-main") return dependencies.runMain({ cwd, ...(command.runtime ? { requestedRuntime: command.runtime } : {}) });
  if (command.command === "runtime") return dependencies.runtimeCommand(command);
  if (command.command === "init") { await dependencies.initProject({ project: resolve(cwd, command.project ?? ".") }); return 0; }
  if (command.command === "deinit") { await dependencies.deinitProject({ project: resolve(cwd, command.project ?? ".") }); return 0; }
  if (command.command === "identity") { await dependencies.syncIdentity(); return 0; }
  if (command.command === "principal") return dependencies.principalCommand({ action: command.action });
  if (command.command === "delegate") return dependencies.delegateCommand(command.args);
  if (command.command === "delegation") return dependencies.delegateCommand(Object.freeze(["__lifecycle", ...command.args]));
  if (command.command === "context") return dependencies.contextCommand(command.args);
  if (command.command === "maintenance") return dependencies.maintenanceCommand({ action: command.action, args: command.args });
  stdout.write(helpText());
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      process.stderr.write(`ERROR     ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    },
  );
}

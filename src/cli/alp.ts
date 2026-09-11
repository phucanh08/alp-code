import { randomUUID } from "node:crypto";
import { accessSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { RuntimeId } from "../agents/types";
import { MODE_IDS, MODE_PROFILES, parseMode, type ModeId } from "../agents/modes";
import { agentRegistry } from "../agents/registry";
import { LocalProcessBackend } from "../backend/local-process-backend";
import { ExecutionService } from "../execution/execution-service";
import { FileExecutionStore } from "../execution/execution-store";
import { ExecutionGraphService } from "../execution/graph/execution-graph-service";
import { FileExecutionGraphStore } from "../execution/graph/file-execution-graph-store";
import { FileThreadStore } from "../thread/file-thread-store";
import { HistoryBridgeRegistry } from "../thread/history-bridge";
import { ClaudeHistoryBridge } from "../runtime/claude-history-bridge";
import { CodexHistoryBridge } from "../runtime/codex-history-bridge";
import { ThreadService, threadGraphReader } from "../thread/thread-service";
import { MarkdownFileStore } from "../memory/adapters/markdown-file-store";
import { MemoryService } from "../memory/memory-service";
import { PolicyEngine } from "../policy/policy-engine";
import { ClaudeRuntimeAdapter } from "../runtime/claude-adapter";
import { CodexRuntimeAdapter } from "../runtime/codex-adapter";
import { ModeSelector } from "./mode-selector";
import { loadModeProfiles } from "./settings";
import { WorkflowRunner } from "../workflow/workflow-runner";
import { runContextCommand } from "./commands/context";
import { backendProbe } from "../delegation/delegation-service";
import { createDefaultDelegationComposition, isRenderedOutput, runDelegateCommand, runDelegationLifecycleCommand, sharedBackendStateDirectory, workspaceFromArgs } from "./commands/delegate";
import { parseAgentCommand, runAgentCommand } from "./commands/agent";
import { syncIdentityDocuments } from "./commands/identity-sync";
import { deinitializeProject, initializeProject, ProjectRegistryStore } from "./commands/init";
import { ensurePrincipalProfile, openTerminalPrompt, runPrincipalCommand, type PrincipalCommandInput } from "./commands/principal";
import { continueThreadSession, historySourceFromDisk, runMainSession, type RunMainDependencies, type RunMainInput } from "./commands/run-main";
import { runThreadCommand } from "./commands/thread";
import { runModeCommand, type ModeCommandInput } from "./commands/mode";
import { agentsDirectory, executionGraphsDirectory, executionsDirectory, memoryRoot, threadsDirectory } from "../state-paths";
import { checkForUpdate, FileUpdateCheckStore, spawnNativeBackgroundUpdateCheck } from "./update-check";
import type { InstallLayout } from "../install-layout";
import { BUILD_VERSION } from "../build-info";
import { renderDoctor } from "../install/doctor";
import { trustedRegistryFor } from "../trust";
import { updateInstallation } from "../install/update";
import { uninstallInstallation } from "../install/uninstall";

export type AlpCommand =
  | { readonly command: "run-main"; readonly mode?: ModeId; readonly title?: string }
  | { readonly command: "mode"; readonly action: "show" | "set"; readonly mode?: ModeId }
  | { readonly command: "init"; readonly project?: string }
  | { readonly command: "deinit"; readonly project?: string }
  | { readonly command: "identity"; readonly action: "sync" }
  | { readonly command: "agent"; readonly args: readonly string[] }
  | { readonly command: "principal"; readonly action: "show" | "set" }
  | { readonly command: "delegate"; readonly args: readonly string[] }
  | { readonly command: "delegation"; readonly args: readonly string[] }
  | { readonly command: "thread"; readonly args: readonly string[] }
  | { readonly command: "context"; readonly args: readonly string[] }
  | { readonly command: "maintenance"; readonly action: "doctor" | "update" | "uninstall"; readonly args: readonly string[] }
  | { readonly command: "version" }
  | { readonly command: "help" };

/** Lời nhắn cho mọi chỗ còn gọi runtime — cờ, subcommand, hay tên CLI trần. */
const RUNTIME_IS_GONE =
  "runtime không còn là lựa chọn: nấc quyết định model, model quyết định CLI — dùng `alp --mode <nấc>` hoặc `alp mode set <nấc>`";

const RUN_MAIN_USAGE = `alp [--mode ${MODE_IDS.join("|")}] [--title <tiêu đề>]`;

/**
 * `alp [--mode <nấc>] [--title <tiêu đề>]` — hai cờ, mỗi cờ tối đa một lần. Gõ sai thì dừng
 * ngay chứ không rơi về mặc định, vì một phiên chạy nấc khác nấc người dùng tưởng là im lặng
 * tốn tiền hoặc im lặng yếu đi. `--title` chỉ đặt tên cho Thread mới mở; không cấp gì.
 */
function parseRunMainFlags(argv: readonly string[]): AlpCommand {
  let mode: ModeId | undefined;
  let title: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--runtime" || value.startsWith("--runtime=")) throw new Error(RUNTIME_IS_GONE);
    const flag = value === "--mode" || value.startsWith("--mode=") ? "--mode"
      : value === "--title" || value.startsWith("--title=") ? "--title"
      : null;
    if (flag === null) throw new Error(`unknown option \`${value}\`; usage: ${RUN_MAIN_USAGE}`);
    let raw: string | undefined;
    if (value === flag) { raw = argv[index + 1]; index += 1; } else { raw = value.slice(`${flag}=`.length); }
    if (flag === "--mode") {
      if (mode !== undefined) throw new Error("multiple mode selections are not allowed");
      if (raw === undefined || raw === "") throw new Error("alp --mode accepts exactly one mode");
      mode = parseMode(raw);
    } else {
      if (title !== undefined) throw new Error("alp --title accepts exactly one title");
      if (raw === undefined || raw.trim() === "") throw new Error("alp --title needs a non-empty title");
      title = raw.trim();
    }
  }
  return { command: "run-main", ...(mode ? { mode } : {}), ...(title ? { title } : {}) };
}

export function parseAlpArgs(argv: readonly string[]): AlpCommand {
  if (argv.length === 0) return { command: "run-main" };
  if (argv[0].startsWith("--mode") || argv[0].startsWith("--title") || argv[0].startsWith("--runtime")) return parseRunMainFlags(argv);
  if (argv[0] === "--version" || argv[0] === "-v") {
    if (argv.length !== 1) throw new Error("alp --version does not accept arguments");
    return { command: "version" };
  }
  if (["claude", "codex", "run-role"].includes(argv[0]) || argv[0] === "--role") {
    throw new Error("direct raw runtime launch is unsupported; use `alp` or `alp --mode <nấc>`");
  }
  if (argv[0] === "runtime") throw new Error(RUNTIME_IS_GONE);
  if (argv[0] === "mode") {
    if (argv[1] === "show" && argv.length === 2) return { command: "mode", action: "show" };
    if (argv[1] === "set" && argv.length === 3) return { command: "mode", action: "set", mode: parseMode(argv[2]) };
    throw new Error(`usage: alp mode show | alp mode set <${MODE_IDS.join("|")}>`);
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
  if (argv[0] === "agent") return { command: "agent", args: Object.freeze(argv.slice(1)) };
  if (argv[0] === "delegate") return { command: "delegate", args: Object.freeze(argv.slice(1)) };
  if (argv[0] === "delegation") return { command: "delegation", args: Object.freeze(argv.slice(1)) };
  if (argv[0] === "context") return { command: "context", args: Object.freeze(argv.slice(1)) };
  if (argv[0] === "thread") return { command: "thread", args: Object.freeze(argv.slice(1)) };
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
  readonly modeCommand: (input: ModeCommandInput) => Promise<number>;
  readonly initProject: (input: { readonly project: string }) => Promise<void>;
  readonly deinitProject: (input: { readonly project: string }) => Promise<void>;
  readonly syncIdentity: () => Promise<void>;
  readonly agentCommand: (args: readonly string[]) => Promise<number>;
  readonly principalCommand: (input: PrincipalCommandInput) => Promise<number>;
  readonly delegateCommand: (args: readonly string[]) => Promise<number>;
  readonly contextCommand: (args: readonly string[]) => Promise<number>;
  readonly threadCommand: (args: readonly string[]) => Promise<number>;
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

function projectAssetRoot(layout: InstallLayout): string {
  return layout.channel === "binary"
    ? join(dirname(dirname(layout.installRoot)), "current")
    : layout.assetRoot;
}

function defaultDependencies(cwd: string, stdout: AlpIo, stderr: AlpIo, layout?: InstallLayout): AlpDependencies {
  const repoRoot = layout?.installRoot ?? process.env.ALP_REPO_ROOT ?? findRepoRoot(__dirname);
  const version = layout?.version ?? BUILD_VERSION;
  /**
   * Built per command rather than once per process, because which agents exist is a property
   * of the project being worked in: `main`'s `delegatesTo` — and therefore its `policyHash` —
   * includes the agents this project trusted.
   */
  const compositionFor = async (projectRoot: string) => {
    const project = await trustedRegistryFor(projectRoot);
    const policy = new PolicyEngine({ registry: project.registry });
    const memory = new MemoryService({
      store: new MarkdownFileStore({ root: memoryRoot() }),
      policy,
      audit: { record() {} },
    });
    return {
      ...project,
      executionService: new ExecutionService({
        registry: project.registry,
        policy,
        memory,
        workflowRunner: new WorkflowRunner(),
        store: new FileExecutionStore({ root: executionsDirectory() }),
      }),
    };
  };
  const adapters = new Map<RuntimeId, ClaudeRuntimeAdapter | CodexRuntimeAdapter>([
    ["claude", new ClaudeRuntimeAdapter({
      hooksDirectory: join(repoRoot, "hooks"),
      ...(layout ? { stableCommand: layout.stableCommand, assetRoot: layout.assetRoot } : {}),
    })],
    // Previously left to default to `ALP_REPO_ROOT` (set by `scripts/alp.cjs`) the way
    // Claude's constructor already falls back too. That implicit path was fine carrying two
    // hooks; wiring two more onto it (PreCompact/PostCompact) turns a coincidence into a
    // real dependency, so it is passed explicitly here like Claude's.
    ["codex", new CodexRuntimeAdapter({
      hooksDirectory: join(repoRoot, "hooks"),
      ...(layout ? { stableCommand: layout.stableCommand, assetRoot: layout.assetRoot, windowsPathCommand: "alp" } : {}),
    })],
  ]);
  /**
   * Cùng một state directory với `alp delegate`.
   *
   * Root từng chạy trên backend mặc định (`~/.alp/local`) còn con thì chạy dưới state dir của
   * delegation — hai bảng process không biết gì về nhau, nên một lệnh lifecycle ở process sau
   * không tra được execution mà process trước đã mở. Một cây thì phải có một sổ.
   */
  const delegationStateDir = sharedBackendStateDirectory({
    installRoot: layout?.installRoot ?? repoRoot,
    channel: layout?.channel ?? "dev",
  });
  const backend = new LocalProcessBackend({
    stateDir: delegationStateDir,
    ...(layout && layout.channel !== "dev" ? {
      supervisorInvocation: { executable: layout.selfExecutable, args: ["__internal", "supervisor"] },
    } : {}),
  });
  const graph = new ExecutionGraphService({
    store: new FileExecutionGraphStore({ root: executionGraphsDirectory() }),
  });
  const threads = new ThreadService({
    store: new FileThreadStore({ root: threadsDirectory() }),
    graph: threadGraphReader(graph, backendProbe(backend)),
    history: new HistoryBridgeRegistry([
      new ClaudeHistoryBridge({ env: process.env }),
      new CodexHistoryBridge({ env: process.env }),
    ]),
  });
  const selector = new ModeSelector({ output: stdout });
  const projectRegistry = new ProjectRegistryStore();
  /** Cùng một bộ dependency cho bare `alp` và `alp thread continue` — root flow là một. */
  const sessionDependencies = async (projectCwd: string): Promise<RunMainDependencies> => {
    const project = await compositionFor(projectCwd);
    for (const notice of project.notices) stdout.write(`${notice}\n`);
    const { profiles } = await loadModeProfiles({ cwd: projectCwd, env: process.env });
    return {
      registry: project.registry,
      modeProfiles: profiles,
      selector,
      executionService: project.executionService,
      graph,
      threads,
      announce: (line) => stderr.write(`${line}\n`),
      adapters,
      backend,
      executionId: () => `exec_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
      interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      workspaceModeFor: async (project) => (await projectRegistry.isRegistered(project))
        ? "workspace-write"
        : "read-only",
    };
  };
  const exitCodeOf = (status: "completed" | "cancelled" | string): number =>
    status === "completed" ? 0 : status === "cancelled" ? 130 : 1;
  return {
    cwd,
    stdout,
    stderr,
    version,
    async checkForUpdate() {
      if (process.env.ALP_SKIP_UPDATE_CHECK === "1") return null;
      try {
        return await checkForUpdate({
          repoRoot,
          store: new FileUpdateCheckStore(),
          currentVersion: version,
          ...(layout && layout.channel !== "dev" ? {
            triggerBackgroundRefresh: () => spawnNativeBackgroundUpdateCheck(layout.selfExecutable, cwd),
          } : {}),
        });
      } catch {
        return null;
      }
    },
    async runMain(input) {
      const result = await runMainSession(input, await sessionDependencies(input.cwd));
      return exitCodeOf(result.status);
    },
    async threadCommand(args) {
      return runThreadCommand(args, {
        threads,
        cwd,
        env: process.env,
        write: (text) => stdout.write(text),
        historySource: (executionId) => historySourceFromDisk(executionsDirectory(), executionId),
        continueThread: async (input) => {
          const result = await continueThreadSession(
            { threadId: input.threadId, cwd, ...(input.mode ? { mode: input.mode } : {}) },
            { ...(await sessionDependencies(cwd)), threads, executionsRoot: executionsDirectory() },
          );
          return exitCodeOf(result.status);
        },
      });
    },
    async modeCommand(input) {
      const settings = await loadModeProfiles({ cwd, env: process.env });
      await runModeCommand(input, {
        write: (text: string) => stdout.write(text),
        ...(settings.files.length > 0 ? { settings } : {}),
      });
      return 0;
    },
    async initProject(input) {
      const registered = await initializeProject({
        ...input,
        repoRoot,
        ...(layout ? { stableCommand: layout.stableCommand, assetRoot: projectAssetRoot(layout) } : {}),
      }, { store: projectRegistry });
      // Asked before the identity sync below, because the answers are rendered into every
      // `.alp/agents/<role>.md` this install writes.
      await ensurePrincipalProfile(
        { interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY) },
        { write: (text) => stdout.write(text) },
      );
      // Identity documents are what the SessionStart hook reads; a project registered
      // without them would boot with an empty identity and a warning.
      await syncIdentityDocuments({ directory: agentsDirectory() }, { registry: agentRegistry });
      stdout.write(`READY    ${registered.path}\n`);
    },
    async deinitProject(input) {
      await deinitializeProject({ ...input, repoRoot: layout ? projectAssetRoot(layout) : repoRoot }, { store: projectRegistry });
      stdout.write(`REMOVED  ${resolve(input.project)}\n`);
    },
    async syncIdentity() {
      const written = await syncIdentityDocuments({ directory: agentsDirectory() }, { registry: agentRegistry });
      for (const file of written) stdout.write(`IDENTITY ${file}\n`);
    },
    async agentCommand(args) {
      // The same asset root the adapters were built with, so the skills this reports on are
      // the ones a launch would actually resolve.
      const assetRoot = layout?.assetRoot ?? repoRoot;
      const command = parseAgentCommand(args, cwd);
      // Đọc theo project được hỏi, không theo cwd: `alp agent test --project <path>` phải
      // báo cáo đúng loadout mà project đó sẽ chạy.
      const { profiles } = await loadModeProfiles({ cwd: command.project, env: process.env });
      return runAgentCommand(command, {
        hooksDirectory: join(repoRoot, "hooks"),
        skillsRoot: join(assetRoot, "skills"),
        assetRoot,
        modeProfiles: profiles,
        ...(layout ? { stableCommand: layout.stableCommand } : {}),
        env: process.env,
        write: (text: string) => { stdout.write(text); },
        // Trust is a decision a person makes, so `alp agent add` needs a real terminal to
        // ask in — and refuses rather than assuming when it does not have one.
        interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
        openPrompt: openTerminalPrompt,
      });
    },
    async principalCommand(input) {
      return runPrincipalCommand(input, {
        write: (text) => stdout.write(text),
        // A changed name must reach the generated identity documents, or the next native
        // session would boot with the previous one.
        syncIdentity: async () => { await syncIdentityDocuments({ directory: agentsDirectory() }, { registry: agentRegistry }); },
      });
    },
    async delegateCommand(args) {
      const lifecycle = args[0] === "__lifecycle";
      const actual = lifecycle ? args.slice(1) : args;
      // Resolved before the service exists: an agent this project trusted is only reachable
      // if the registry the service is built with knows about it. Lifecycle commands address
      // an execution by id and need no project.
      const workspaceRoot = lifecycle ? cwd : resolve(cwd, workspaceFromArgs(actual.slice(1), cwd));
      const project = lifecycle
        ? { registry: agentRegistry, notices: [] as readonly string[] }
        : await trustedRegistryFor(workspaceRoot);
      for (const notice of project.notices) stderr.write(`${notice}\n`);
      // Without this, a target the principal can see in `.alp/agents/` comes back as
      // "unknown agent": true — an unapproved agent never enters the registry — but it reads
      // as a typo when the real answer is that nobody approved it yet.
      const target = actual[0];
      const blocked = "decisions" in project
        ? project.decisions.find((decision) => decision.agent.id === target && decision.status !== "trusted")
        : undefined;
      if (blocked) {
        throw new Error(blocked.status === "changed"
          ? `\`${target}\` changed after it was trusted; run \`alp agent add ${target}\` to review and approve it again`
          : `\`${target}\` is not approved; run \`alp agent add ${target}\` to review it`);
      }
      // Settings đọc theo **workspace của execution**, không theo chỗ đang đứng gõ lệnh:
      // `alp delegate --project <path>` phải chạy đúng loadout của project đó.
      const { profiles } = await loadModeProfiles({ cwd: workspaceRoot, env: process.env });
      const composition = await createDefaultDelegationComposition(layout ?? {
        channel: "dev",
        version,
        selfExecutable: process.execPath,
        stableCommand: join(repoRoot, "scripts", "alp.cjs"),
        installRoot: repoRoot,
        assetRoot: repoRoot,
      }, process.env, project.registry, profiles);
      const value = lifecycle
        ? await runDelegationLifecycleCommand(actual, composition.service)
        : await runDelegateCommand(actual, { cwd, env: process.env, service: composition.service, registry: project.registry });
      // `alp delegation tree` đã tự định dạng; mọi lệnh còn lại trả dữ liệu cho script đọc.
      if (isRenderedOutput(value)) stdout.write(value.rendered);
      else stdout.write(`${JSON.stringify(value, null, 2)}\n`);
      return typeof value === "object" && value !== null && "status" in value && value.status === "failed" ? 1 : 0;
    },
    async contextCommand(args) {
      return runContextCommand(args, {
        executionsRoot: executionsDirectory(),
        env: process.env,
        write: (text) => stdout.write(text),
      });
    },
    async maintenanceCommand(input) {
      if (input.action === "doctor") {
        const report = await renderDoctor(layout ?? {
          channel: "dev", version, selfExecutable: process.execPath,
          stableCommand: join(repoRoot, "scripts", "alp.cjs"), installRoot: repoRoot, assetRoot: repoRoot,
        }, process.env, input.args.includes("--quiet"));
        stdout.write(report.output);
        return report.exitCode;
      }
      if (input.action === "update") {
        if (!layout) throw new Error("native update requires an explicit installation layout");
        try {
          const result = await updateInstallation({ layout, env: process.env });
          stdout.write(result.unchanged
            ? `OK        alp-code v${result.to} is already current\n`
            : `UPDATED   alp-code v${result.from} → v${result.to}; ~/.alp preserved\n`);
          return 0;
        } catch (error) {
          stderr.write(`ERROR     ${(error as Error).message}\n`);
          return 1;
        }
      }
      if (!layout) throw new Error("native uninstall requires an explicit installation layout");
      const result = uninstallInstallation(layout, {
        cwd,
        env: process.env,
        purgeMemory: input.args.includes("--purge-memory"),
      });
      if (result.memoryBackup) stdout.write(`RESTORE  ${result.memoryBackup}\n`);
      for (const leftover of result.leftovers) stdout.write(`CLEANUP  ${leftover}\n`);
      stdout.write("REMOVED  native alp-code installation\n");
      return 0;
    },
  };
}

function helpText(): string {
  return [
    "alp — code-native agent launcher",
    "",
    `  ${RUN_MAIN_USAGE}`,
    "  alp mode show|set <mode>",
    "  alp init [path]",
    "  alp deinit [path]",
    "  alp identity sync",
    "  alp agent test <role|--all> [--project <path>] [--tier 1|2|3] [--mode <mode>] [--json]",
    "  alp agent add|show|untrust <id> [--project <path>]",
    "  alp agent list [--project <path>]",
    "  alp principal show|set",
    "  alp delegate <role> [options] -- <task>",
    "  alp delegation tree|status|wait|cancel|cleanup <execution-id> [--json]",
    "  alp delegation list",
    "  alp context status|validate [execution-id]",
    "  alp context pin <decision|constraint|open-item|next-action> -- <text>",
    "  alp context unpin <pin-id>",
    "  alp thread list [--all] | show [<thread-id>] | context|reconcile|sync|close|archive <thread-id>",
    `  alp thread continue <thread-id> [--mode ${MODE_IDS.join("|")}]`,
    "  alp doctor",
    "  alp update",
    "  alp uninstall [--purge-memory] [--force]",
    "  alp --version",
    "",
    "Mode quyết định model của từng vai, và model quyết định CLI nào chạy vai đó.",
    "Thứ tự: --mode → ALP_MODE → `alp mode set` → hỏi trên TTY → `medium`.",
    "Loadout sửa được ở `~/.alp/settings.json`, `<project>/.alp/settings.json`, rồi",
    "`settings.local.json` — `alp mode show` in ra vai nào đang chạy khác mặc định.",
    "",
    ...MODE_IDS.map((mode) => `  ${mode.padEnd(7)} ${MODE_PROFILES[mode].summary}`),
    "",
    "Direct `claude`, `codex`, and identity-aware raw-runtime shortcuts are unsupported.",
  ].join("\n") + "\n";
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  injected?: AlpDependencies,
  layout?: InstallLayout,
): Promise<number> {
  const cwd = injected?.cwd ?? process.cwd();
  const stdout = injected?.stdout ?? process.stdout;
  const stderr = injected?.stderr ?? process.stderr;
  const dependencies = injected ?? defaultDependencies(cwd, stdout, stderr, layout);
  const command = parseAlpArgs(argv);
  const notice = await dependencies.checkForUpdate().catch(() => null);
  if (notice) stdout.write(notice);
  if (command.command === "version") { stdout.write(`alp ${dependencies.version}\n`); return 0; }
  if (command.command === "run-main") {
    // Cờ thắng biến môi trường; `ALP_MODE` tồn tại để một phiên delegated kế thừa nấc của cha.
    const inheritedMode = process.env.ALP_MODE ? parseMode(process.env.ALP_MODE) : undefined;
    const mode = command.mode ?? inheritedMode;
    return dependencies.runMain({ cwd, ...(mode ? { mode } : {}), ...(command.title ? { title: command.title } : {}) });
  }
  if (command.command === "mode") return dependencies.modeCommand(command);
  if (command.command === "init") { await dependencies.initProject({ project: resolve(cwd, command.project ?? ".") }); return 0; }
  if (command.command === "deinit") { await dependencies.deinitProject({ project: resolve(cwd, command.project ?? ".") }); return 0; }
  if (command.command === "identity") { await dependencies.syncIdentity(); return 0; }
  if (command.command === "principal") return dependencies.principalCommand({ action: command.action });
  if (command.command === "agent") return dependencies.agentCommand(command.args);
  if (command.command === "delegate") return dependencies.delegateCommand(command.args);
  if (command.command === "delegation") return dependencies.delegateCommand(Object.freeze(["__lifecycle", ...command.args]));
  if (command.command === "context") return dependencies.contextCommand(command.args);
  if (command.command === "thread") return dependencies.threadCommand(command.args);
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

import { BUILD_VERSION } from "../build-info";
import { RELAY_DIRECTORY_ENV } from "../execution/relay-protocol";
import { resolveInstallLayout, type InstallLayout } from "../install-layout";

export interface EntryIo { write(text: string): unknown }

export interface EntryDependencies {
  readonly version: string;
  readonly stdout: EntryIo;
  readonly ensureState: () => void | Promise<void>;
  readonly runHook: (argv: readonly string[]) => Promise<number>;
  readonly runInternal: (argv: readonly string[]) => Promise<number>;
  /** Trong một execution: gửi lệnh cho process root thi hành thay (xem `relay-client.ts`). */
  readonly relay: (argv: readonly string[], directory: string) => Promise<number>;
  readonly loadFullCli: () => Promise<{ main(argv: readonly string[]): Promise<number> }>;
}

export async function dispatchEntry(
  argv: readonly string[],
  dependencies: EntryDependencies,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if ((argv[0] === "--version" || argv[0] === "-v") && argv.length === 1) {
    dependencies.stdout.write(`alp ${dependencies.version}\n`);
    return 0;
  }
  if (argv[0] === "hook") return dependencies.runHook(argv.slice(1));
  if (argv[0] === "__internal") return dependencies.runInternal(argv.slice(1));
  // Bên trong một execution, process này chạy dưới sandbox của runtime: không ghi được `~/.alp`,
  // và một worker nó spawn sẽ thừa kế sandbox đó. Mọi lệnh thường đi qua process root.
  const relayDirectory = env[RELAY_DIRECTORY_ENV];
  if (relayDirectory) return dependencies.relay(argv, relayDirectory);
  await dependencies.ensureState();
  const full = await dependencies.loadFullCli();
  return full.main(argv);
}

function defaultLayout(): InstallLayout {
  return resolveInstallLayout({
    executable: process.execPath,
    version: BUILD_VERSION,
    ...(process.env.ALP_REPO_ROOT ? { devRoot: process.env.ALP_REPO_ROOT } : {}),
  });
}

function dependencies(): EntryDependencies {
  let cachedLayout: InstallLayout | undefined;
  const layout = (): InstallLayout => cachedLayout ??= defaultLayout();
  return {
    version: BUILD_VERSION,
    stdout: process.stdout,
    ensureState: async () => {
      const { ensureState } = await import("../install/state");
      ensureState({ layout: layout() });
    },
    async runHook(argv) {
      const { runHookCommand } = await import("./hook-entry");
      return runHookCommand(argv);
    },
    async runInternal(argv) {
      const { runInternalCommand } = await import("./internal");
      return runInternalCommand(argv, {
      ensureState: async () => {
        const { ensureState } = await import("../install/state");
        ensureState({ layout: layout() });
      },
      refreshUpdateCheck: async () => {
        const { refreshUpdateCheck } = await import("./update-check");
        await refreshUpdateCheck();
      },
      supervise: async (spec) => {
        const { superviseExecution } = await import("../backend/local-supervisor");
        await superviseExecution(spec);
      },
      });
    },
    async relay(argv, directory) {
      const { relayCommand } = await import("./relay-client");
      return relayCommand({
        directory, argv, cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr,
        deadlineAt: process.env.ALP_EXECUTION_DEADLINE_AT ?? null,
      });
    },
    async loadFullCli() {
      const full = await import("./alp");
      return { main: (argv) => full.main(argv, undefined, layout()) };
    },
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  return dispatchEntry(argv, dependencies());
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

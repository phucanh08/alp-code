import { BUILD_VERSION } from "../build-info";
import { resolveInstallLayout, type InstallLayout } from "../install-layout";

export interface EntryIo { write(text: string): unknown }

export interface EntryDependencies {
  readonly version: string;
  readonly stdout: EntryIo;
  readonly ensureState: () => void | Promise<void>;
  readonly runHook: (argv: readonly string[]) => Promise<number>;
  readonly runInternal: (argv: readonly string[]) => Promise<number>;
  readonly loadFullCli: () => Promise<{ main(argv: readonly string[]): Promise<number> }>;
}

export async function dispatchEntry(argv: readonly string[], dependencies: EntryDependencies): Promise<number> {
  if ((argv[0] === "--version" || argv[0] === "-v") && argv.length === 1) {
    dependencies.stdout.write(`alp ${dependencies.version}\n`);
    return 0;
  }
  if (argv[0] === "hook") return dependencies.runHook(argv.slice(1));
  if (argv[0] === "__internal") return dependencies.runInternal(argv.slice(1));
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

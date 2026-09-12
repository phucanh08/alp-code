import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { RuntimeId } from "../agents/types";
import type { EnforcementField, EnforcementLevel } from "../runtime/capabilities";

/**
 * One measurement of one cell of the enforcement table, taken on this machine.
 *
 * The table in `runtime/capabilities.ts` is a claim dated and versioned elsewhere; a probe
 * is the claim checked here, now, against the binary on PATH. Tier 2 compares the two and
 * reports `DRIFT` when they disagree — a signal about the machine, not a bug in ALP.
 */
export interface SandboxProbeResult {
  readonly runtime: RuntimeId;
  readonly field: EnforcementField;
  readonly observed: EnforcementLevel;
  /** What was done and what was seen, one line — the evidence a `DRIFT` is printed with. */
  readonly evidence: string;
}

/** `null` means "nothing can be probed for this runtime here" — not "everything holds". */
export type SandboxProbe = (input: { readonly runtime: RuntimeId }) => Promise<readonly SandboxProbeResult[] | null>;

export type ProbeRunner = (command: string, args: readonly string[]) => Promise<{ readonly status: number | null; readonly stdout: string }>;

export interface CodexSandboxProbeOptions {
  /** The environment the runtime is looked up and run in — `PATH` and `HOME` matter. */
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  /** Runs the runtime and answers its exit status and stdout — the boundary a test replaces. */
  readonly run?: ProbeRunner;
}

const PROBE_TIMEOUT_MS = 15_000;
const CANARY = "alp-sandbox-probe-canary";
const CONTROL = "alp-sandbox-probe-control";
/**
 * Built-in permission profiles of codex 0.154 (`-P` is required; `-c sandbox_mode=…` is
 * refused with a usage error). `:workspace` writes the `-C` directory and `/tmp`;
 * `:read-only` writes nothing.
 */
const READ_ONLY_PROFILE = ":read-only";
const WORKSPACE_PROFILE = ":workspace";
/**
 * Absolute, and only builtins are used under it: the probe runs in the *launch* environment,
 * whose `PATH` may hold nothing but the runtime, and a probe that failed to find `cat`
 * would look exactly like a sandbox that refused the read.
 */
const SHELL = "/bin/sh";

function locate(command: string, env: NodeJS.ProcessEnv): boolean {
  return (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean).some((directory) => existsSync(join(directory, command)));
}

function defaultRunner(env: NodeJS.ProcessEnv): ProbeRunner {
  return (command, args) => new Promise((settle) => {
    execFile(command, [...args], { env, timeout: PROBE_TIMEOUT_MS, encoding: "utf8", windowsHide: true }, (error, stdout) => {
      const status = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : null;
      settle({ status, stdout: stdout ?? "" });
    });
  });
}

/**
 * Measures Codex's seatbelt with `codex sandbox`, which needs no model and no login: one
 * write outside the writable roots under `workspace-write`, one read outside the workspace
 * under `read-only`.
 *
 * The write target lives under `HOME`, never under the system temp directory: Codex's
 * `workspace-write` allows `/tmp` and `$TMPDIR` by default, so a probe writing there would
 * report `none` for a sandbox that is working. The two probes also check each other — a
 * `codex sandbox` that fails to run at all reads nothing, which disagrees with the table's
 * `readIsolation: none` and surfaces as `DRIFT` instead of passing as "refused".
 *
 * A control command runs first: a `codex sandbox` that cannot start (a usage error, a
 * profile it does not know) exits non-zero without executing anything, and read as a refusal
 * that would print `enforced` for a sandbox never entered. The probe throws instead, and
 * tier 2 turns that into a failed check.
 *
 * Claude is not probed: its sandbox runs only inside a model session, which costs a call.
 * Windows is not probed: no row of the table claims a Codex sandbox there.
 */
export function codexSandboxProbe(options: CodexSandboxProbeOptions): SandboxProbe {
  const run = options.run ?? defaultRunner(options.env);
  return async ({ runtime }) => {
    if (runtime !== "codex" || options.platform === "win32") return null;
    const command = "codex";
    if (!locate(command, options.env)) return null;
    const home = options.env.HOME;
    if (home === undefined) return null;

    const root = join(home, ".alp", `sandbox-probe-${process.pid}-${Date.now().toString(36)}`);
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    const writeTarget = join(outside, "written.txt");
    const readTarget = join(outside, "canary.txt");
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await mkdir(outside, { recursive: true, mode: 0o700 });
    await writeFile(readTarget, `${CANARY}\n`, { mode: 0o600 });

    try {
      const control = await run(command, [
        "sandbox", "-P", READ_ONLY_PROFILE, "-C", workspace, "--",
        SHELL, "-c", 'printf "%s\n" "$1"', "sh", CONTROL,
      ]);
      if (!control.stdout.includes(CONTROL)) {
        throw new Error(`codex sandbox did not run a control command (exit ${control.status ?? "signal"}); nothing was measured`);
      }

      const write = await run(command, [
        "sandbox", "-P", WORKSPACE_PROFILE, "-C", workspace, "--",
        SHELL, "-c", 'printf x > "$1"', "sh", writeTarget,
      ]);
      const written = existsSync(writeTarget);
      const writeObserved: EnforcementLevel = written ? "none" : write.status === 0 ? "none" : "enforced";
      const writeEvidence = written
        ? `wrote ${writeTarget} outside the writable roots`
        : write.status === 0
          ? `the write command exited 0 without writing ${writeTarget} — inconclusive, counted as unenforced`
          : `write outside the writable roots refused (exit ${write.status ?? "signal"})`;

      const read = await run(command, [
        "sandbox", "-P", READ_ONLY_PROFILE, "-C", workspace, "--",
        SHELL, "-c", 'IFS= read -r line < "$1" && printf "%s\n" "$line"', "sh", readTarget,
      ]);
      const readSucceeded = read.stdout.includes(CANARY);
      const results: SandboxProbeResult[] = [
        { runtime: "codex", field: "writeIsolation", observed: writeObserved, evidence: writeEvidence },
        {
          runtime: "codex",
          field: "readIsolation",
          observed: readSucceeded ? "none" : "enforced",
          evidence: readSucceeded
            ? "read outside the workspace succeeded under read-only"
            : `read outside the workspace did not print the file (exit ${read.status ?? "signal"})`,
        },
      ];
      return results;
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}


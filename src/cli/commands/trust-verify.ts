import { InvalidModeSettings, loadVerifyCommands } from "../settings";
import { canonicalProject, trustVerify, trustedVerifyFile, untrustVerify, verifyTrusted } from "../../trust";
import type { PrincipalPrompt } from "./principal";

export interface TrustVerifyDependencies {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly write: (text: string) => void;
  readonly interactive: boolean;
  readonly openPrompt?: () => PrincipalPrompt;
  /** Overridden in tests; defaults to `~/.alp/trusted-verify.json`. */
  readonly trustFile?: string;
}

const SHORT_DIGEST = 12;

/**
 * `alp trust verify [--project <path>] [--revoke]` — the gate between a `verify` block in a
 * repo and a command the ALP process will run in that repo.
 *
 * The block is printed in full, then the question is asked, and only a terminal may answer:
 * there is no `--yes`, for the same reason `alp agent add` has none. What is recorded is the
 * digest of the block as read now — editing it afterwards makes the block untrusted again,
 * which `alp delegation evidence` reports as `verify-skipped untrusted` rather than running
 * whatever the edit put there.
 */
export async function runTrustVerify(argv: readonly string[], dependencies: TrustVerifyDependencies): Promise<number> {
  let project = dependencies.cwd;
  let revoke = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--project") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--project requires a path");
      project = value;
      index += 1;
    } else if (argument === "--revoke") {
      revoke = true;
    } else {
      throw new Error(`unknown option for \`alp trust verify\`: ${argument}`);
    }
  }
  const file = dependencies.trustFile ?? trustedVerifyFile(dependencies.env);

  let settings;
  try {
    settings = await loadVerifyCommands(project, dependencies.env);
  } catch (error) {
    if (!(error instanceof InvalidModeSettings)) throw error;
    dependencies.write(`REFUSED  ${error.message}\n`);
    return 1;
  }
  const root = canonicalProject(settings.project);

  if (revoke) {
    const removed = await untrustVerify(root, file);
    dependencies.write(removed
      ? `REMOVED  verify commands are no longer trusted in ${root}\n`
      : `UNCHANGED  no verify block was trusted in ${root}\n`);
    return 0;
  }

  if (settings.digest === null) {
    dependencies.write([
      `NOTHING  ${root} declares no \`verify\` block`,
      `         add { "verify": { "commands": [ { "id": "test", "run": "npm test" } ] } } to .alp/settings.json first`,
      "",
    ].join("\n"));
    return 1;
  }

  const already = verifyTrusted(root, settings.digest, file);
  dependencies.write([
    `VERIFY   ${root}`,
    `         block ${settings.digest.slice(0, SHORT_DIGEST)}${already ? " (already trusted)" : ""}`,
    ...settings.commands.map((command) =>
      `  ${command.id.padEnd(12)} ${command.run}    (cwd ${command.cwd}, timeout ${command.timeoutMs} ms)`),
    "",
    "These commands run in the ALP process, in the project's workspace, outside any runtime sandbox,",
    "whenever a delegation requires `verify:<id>`. Trust only a block you have read.",
    "",
  ].join("\n"));

  if (!dependencies.interactive || dependencies.openPrompt === undefined) {
    dependencies.write("REFUSED  trust needs a terminal; there is no `--yes` for this command\n");
    return 1;
  }
  const prompt = dependencies.openPrompt();
  let answer: string;
  try {
    answer = await prompt.ask("Trust these verify commands? Type yes to confirm: ");
  } finally {
    prompt.close();
  }
  if (answer.trim().toLowerCase() !== "yes") {
    dependencies.write("REFUSED  the verify block was not trusted\n");
    return 1;
  }

  await trustVerify({ project: root, verifyDigest: settings.digest, trustedAt: new Date().toISOString() }, file);
  dependencies.write([
    `TRUSTED  verify block ${settings.digest.slice(0, SHORT_DIGEST)} in ${root}`,
    "         editing .alp/settings.json or settings.local.json revokes this: a different digest is skipped, not run",
    "",
  ].join("\n"));
  return 0;
}

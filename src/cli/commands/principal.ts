import { createInterface } from "node:readline/promises";
import {
  normalizePrincipalProfile,
  principalProfileFile,
  readPrincipalProfile,
  writePrincipalProfile,
  type PrincipalProfile,
} from "../../principal/principal-profile-store";

/** Minimal question/close surface so tests can drive the interview without a terminal. */
export interface PrincipalPrompt {
  ask(question: string): Promise<string>;
  close(): void;
}

export interface PrincipalDependencies {
  /** Overridden in tests; defaults to `~/.alp/principal.json`. */
  readonly file?: string;
  readonly write: (text: string) => void;
  readonly openPrompt?: () => PrincipalPrompt;
  /** Re-renders `.alp/agents/<role>.md`, which embed the profile. Optional for tests. */
  readonly syncIdentity?: () => Promise<void>;
}

const STDIN_ENDED = "stdin ended before the principal profile was complete";

/**
 * Reads answers off a line queue instead of `rl.question`.
 *
 * Two reasons. A piped stdin (`printf 'name\nanh\nem\n' | alp principal set`) flushes every
 * line while only the first question is pending, and `rl.question` drops the rest; and when
 * the input ends with a question outstanding, `rl.question` never settles, so the CLI would
 * hang rather than fail. Queueing lines fixes the first, and the close handler turns the
 * second into an error.
 */
function openTerminalPrompt(): PrincipalPrompt {
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  const lines: string[] = [];
  const waiting: Array<{ resolve(value: string): void; reject(error: unknown): void }> = [];
  let ended = false;

  reader.on("line", (line) => {
    const waiter = waiting.shift();
    if (waiter) waiter.resolve(line);
    else lines.push(line);
  });
  reader.on("close", () => {
    ended = true;
    for (const waiter of waiting.splice(0)) waiter.reject(new Error(STDIN_ENDED));
  });

  return {
    ask(question) {
      process.stdout.write(question);
      const buffered = lines.shift();
      if (buffered !== undefined) return Promise.resolve(buffered);
      if (ended) return Promise.reject(new Error(STDIN_ENDED));
      return new Promise<string>((resolve, reject) => { waiting.push({ resolve, reject }); });
    },
    close: () => reader.close(),
  };
}

export async function promptPrincipalProfile(prompt: PrincipalPrompt): Promise<PrincipalProfile> {
  return normalizePrincipalProfile({
    name: await prompt.ask("  Your name: "),
    addressAs: await prompt.ask("  An agent addresses you as (anh, chị, bạn…): "),
    selfAs: await prompt.ask("  An agent refers to itself as (em, tôi, mình…): "),
  });
}

function describe(profile: PrincipalProfile): string {
  return `PROFILE  ${profile.name} — agents say "${profile.selfAs}" and call you "${profile.addressAs}"\n`;
}

async function capturePrincipalProfile(dependencies: PrincipalDependencies): Promise<PrincipalProfile> {
  dependencies.write("\nWho is ALP serving? This is stored once, on this machine only.\n");
  const prompt = (dependencies.openPrompt ?? openTerminalPrompt)();
  let answered: PrincipalProfile;
  try {
    answered = await promptPrincipalProfile(prompt);
  } finally {
    prompt.close();
  }
  const profile = await writePrincipalProfile(answered, dependencies.file);
  dependencies.write(describe(profile));
  await dependencies.syncIdentity?.();
  return profile;
}

export interface EnsurePrincipalProfileInput {
  readonly interactive: boolean;
}

/**
 * Called by `alp init`. Asks only when the profile is missing and a terminal is attached;
 * a non-interactive install (CI, scripts) keeps going with a neutral prompt rather than
 * failing or guessing a name from git config.
 *
 * Never throws: the project registration has already happened by this point, so a refused
 * or empty answer downgrades to the same note a non-interactive run gets.
 */
export async function ensurePrincipalProfile(
  input: EnsurePrincipalProfileInput,
  dependencies: PrincipalDependencies,
): Promise<PrincipalProfile | null> {
  const current = readPrincipalProfile(dependencies.file ?? principalProfileFile());
  if (current.warning) dependencies.write(`WARNING  ${current.warning}\n`);
  if (current.profile) return current.profile;
  if (input.interactive) {
    try {
      return await capturePrincipalProfile(dependencies);
    } catch (error) {
      dependencies.write(`WARNING  ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  dependencies.write("NOTE     principal profile is unset; run `alp principal set` to add your name and forms of address\n");
  return null;
}

export interface PrincipalCommandInput {
  readonly action: "show" | "set";
}

export async function runPrincipalCommand(
  input: PrincipalCommandInput,
  dependencies: PrincipalDependencies,
): Promise<number> {
  const file = dependencies.file ?? principalProfileFile();
  if (input.action === "show") {
    const current = readPrincipalProfile(file);
    if (current.warning) dependencies.write(`WARNING  ${current.warning}\n`);
    if (!current.profile) {
      dependencies.write("UNSET    no principal profile; run `alp principal set`\n");
      return 1;
    }
    dependencies.write(describe(current.profile));
    dependencies.write(`FILE     ${file}\n`);
    return 0;
  }
  await capturePrincipalProfile(dependencies);
  return 0;
}

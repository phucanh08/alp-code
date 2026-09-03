import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { removeTemporary } from "../support/temporary-root";

const run = promisify(execFile);
const HOOK = join(process.cwd(), "hooks", "session-boot.cjs");

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => removeTemporary(root))));

/**
 * Runs the hook the way a runtime does — a bare child process with only environment to go
 * on — and parses the SessionStart payload it prints.
 */
async function boot(env: NodeJS.ProcessEnv): Promise<{ context: string; warning: string | undefined }> {
  const { stdout } = await run(process.execPath, [HOOK], { env: { ...process.env, ...env } });
  const payload = JSON.parse(stdout) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
    systemMessage?: string;
  };
  expect(payload.hookSpecificOutput.hookEventName).toBe("SessionStart");
  return { context: payload.hookSpecificOutput.additionalContext, warning: payload.systemMessage };
}

async function fixture(): Promise<{ root: string }> {
  const root = await mkdtemp(join(tmpdir(), "alp-session-boot-"));
  roots.push(root);
  await mkdir(join(root, ".alp", "agents"), { recursive: true });
  await writeFile(join(root, ".alp", "agents", "search.md"), "# static role document\n");
  return { root };
}

describe("session-boot hook", () => {
  it("prefers this execution's session context over the static role document", async () => {
    const { root } = await fixture();
    const contextFile = join(root, "session-context.md");
    await writeFile(contextFile, "# execution session context\ninvariants and policy live here\n");

    const { context, warning } = await boot({
      ALP_SESSION_CONTEXT: contextFile,
      ALP_ROLE: "search",
      ALP_REPO_ROOT: root,
    });

    // Both sources are present and valid; the execution-specific one has to win, because
    // it is the only one carrying invariants, policy context and the workspace grant.
    expect(context).toContain("execution session context");
    expect(context).not.toContain("static role document");
    expect(warning).toBeUndefined();
  });

  it("falls back to the role document when no execution launched the runtime", async () => {
    const { root } = await fixture();

    const { context, warning } = await boot({
      ALP_SESSION_CONTEXT: "",
      ALP_ROLE: "search",
      ALP_REPO_ROOT: root,
    });

    // The native path: the principal ran `claude`/`codex` directly, so no adapter wrote a
    // session context. Identity still has to arrive from somewhere.
    expect(context).toContain("static role document");
    expect(warning).toBeUndefined();
  });

  it("starts the session with a warning rather than silently unbriefed", async () => {
    const { root } = await fixture();

    const { context, warning } = await boot({
      ALP_SESSION_CONTEXT: join(root, "absent.md"),
      ALP_ROLE: "search",
      ALP_REPO_ROOT: root,
    });

    // Fail-open, unlike the policy hooks — but never quietly. A managed launch cannot
    // reach this state anyway: the adapter writes the file before it spawns anything, so
    // an unwritable one aborts `prepare()` and no process starts.
    expect(context).toBe("");
    expect(warning).toContain("ALP identity not loaded");
  });

  it("refuses a role name that could escape the agents directory", async () => {
    const { root } = await fixture();

    const { context, warning } = await boot({
      ALP_SESSION_CONTEXT: "",
      ALP_ROLE: "../../etc/passwd",
      ALP_REPO_ROOT: root,
    });

    expect(context).toBe("");
    expect(warning).toContain("invalid role");
  });
});

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { GitBaselineProbe, GitBaselineV1, Verifier, VerifyRun } from "./evidence";

/**
 * The two boundary adapters the evidence collector talks to: `git` for the change baseline
 * and a shell for the verify commands. Everything decided about what they return — which
 * paths changed, whether a run counts — lives in `evidence.ts`; this file only *asks*.
 */

/** `git` reads only: nothing here mutates the index or the work tree. */
function git(cwd: string, args: readonly string[]): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile("git", [...args], { cwd, encoding: "buffer", maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

/**
 * `XY path NUL` — or `XY to NUL from NUL` for renames/copies, whose second field must be
 * consumed and skipped or every following entry shifts by one.
 */
function parsePorcelain(output: Buffer, rebase: (path: string) => string): { path: string; status: string }[] {
  const fields = output.toString("utf8").split("\0");
  const entries: { path: string; status: string }[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field.length < 4) continue;
    const status = field.slice(0, 2);
    const path = field.slice(3);
    entries.push({ path: rebase(path), status });
    if (status[0] === "R" || status[0] === "C" || status[1] === "R" || status[1] === "C") index += 1;
  }
  return entries;
}

async function contentHash(path: string): Promise<string | null> {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch {
    // Deleted, or a directory: the status alone records that it changed.
    return null;
  }
}

interface Tree {
  /** Real path of the work tree's top level — what `git` prints. */
  readonly toplevel: string;
  /** Pathspec for the workspace, relative to the top level (`.` for the top level itself). */
  readonly pathspec: string;
  /** Turn a top-level-relative path back into one under the caller's `workspace`. */
  readonly rebase: (path: string) => string;
}

/**
 * The work tree around `workspace`, or `null` when there is none. `git` prints real paths
 * (`/private/var` for `/var` on darwin); the caller's paths are compared against the policy's
 * `writeScope`, so every path is handed back under the `workspace` spelling it gave us.
 */
async function treeOf(workspace: string): Promise<Tree | null> {
  const output = await git(workspace, ["rev-parse", "--show-toplevel"]);
  const toplevel = output?.toString("utf8").trim();
  if (!toplevel) return null;
  let real = workspace;
  try { real = await realpath(workspace); } catch { /* keep the given form */ }
  const inside = relative(toplevel, real);
  const pathspec = inside === "" ? "." : inside;
  const prefix = pathspec === "." ? "" : pathspec + sep;
  return {
    toplevel,
    pathspec,
    rebase: (path) => (path.startsWith(prefix) ? resolve(workspace, path.slice(prefix.length)) : join(toplevel, path)),
  };
}

export function gitBaselineProbe(): GitBaselineProbe {
  return {
    async capture(workspace) {
      const tree = await treeOf(workspace);
      if (tree === null) return null;
      // A fresh repository with no commit yet has no HEAD: still a repository, so still a
      // baseline — every later commit then shows as a moved HEAD.
      const head = (await git(tree.toplevel, ["rev-parse", "--verify", "HEAD"]))?.toString("utf8").trim() || null;
      // Run at the top level and scope with a pathspec, so paths never depend on
      // `status.relativePaths` or on which subdirectory the workspace is.
      const status = await git(tree.toplevel, ["status", "--porcelain", "-z", "--untracked-files=all", "--", tree.pathspec]);
      if (status === null) return null;
      const dirty = await Promise.all(
        parsePorcelain(status, tree.rebase)
          .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
          .map(async (entry) => ({ ...entry, contentHash: await contentHash(entry.path) })),
      );
      const baseline: GitBaselineV1 = { version: 1, head, dirty };
      return baseline;
    },
    async changedBetween(workspace, from, to) {
      const tree = await treeOf(workspace);
      if (tree === null) return [];
      const output = await git(tree.toplevel, ["diff", "--name-only", "-z", from, to, "--", tree.pathspec]);
      if (output === null) return [];
      return output.toString("utf8").split("\0").filter((path) => path.length > 0).map(tree.rebase).sort();
    },
  };
}

/** Keep the last `maxBytes` of a byte stream without holding the whole stream. */
class Tail {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private readonly maxBytes: number) {}
  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.chunks.length > 1 && this.size - this.chunks[0].length >= this.maxBytes) {
      this.size -= this.chunks[0].length;
      this.chunks.shift();
    }
  }
  text(): string {
    const all = Buffer.concat(this.chunks);
    return all.subarray(Math.max(0, all.length - this.maxBytes)).toString("utf8");
  }
}

/**
 * Run one verify command through the platform shell with exactly the environment the
 * collector hands over — the command sees `PATH` and `HOME`, not the parent's secrets.
 * A timeout kills the whole process group and reports `timeout`; a command that cannot be
 * spawned at all reports exit 127, which is what a shell would say for the same failure.
 */
export function spawnVerifier(options: { readonly platform?: NodeJS.Platform; readonly tailBytes?: number } = {}): Verifier {
  const platform = options.platform ?? process.platform;
  const tailBytes = options.tailBytes ?? 4 * 1024;
  return (command, runOptions) =>
    new Promise<VerifyRun>((resolve) => {
      const startedAt = Date.now();
      const tail = new Tail(tailBytes);
      const [file, args] = platform === "win32"
        ? ["cmd.exe", ["/d", "/s", "/c", command.run]]
        : ["/bin/sh", ["-c", command.run]];
      const child = spawn(file, args, {
        cwd: runOptions.cwd,
        env: { ...runOptions.env },
        stdio: ["ignore", "pipe", "pipe"],
        detached: platform !== "win32",
        windowsHide: true,
      });
      let settled = false;
      const done = (run: VerifyRun) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(run);
      };
      const timer = setTimeout(() => {
        try {
          if (platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
        done({ kind: "timeout" });
      }, runOptions.timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => tail.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => tail.push(chunk));
      child.on("error", () => done({ kind: "ran", exitCode: 127, durationMs: Date.now() - startedAt, tail: tail.text() }));
      child.on("close", (code, signal) => {
        done({ kind: "ran", exitCode: code ?? (signal ? 128 : 1), durationMs: Date.now() - startedAt, tail: tail.text() });
      });
    });
}

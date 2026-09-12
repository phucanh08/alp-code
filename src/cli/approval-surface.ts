import { createInterface } from "node:readline";
import type { ApprovalSurface } from "../execution/types";

export interface TtyApprovalSurfaceOptions {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: { write(text: string): unknown };
  /** Both ends are a terminal. Off a TTY nobody is there to answer, and nothing is asked. */
  readonly isTTY: boolean;
}

const YES = new Set(["y", "yes"]);

/**
 * The principal's keyboard, as the one place a `require_approval` can be answered.
 *
 * Belongs to the root `alp` and nothing else: `alp delegate` runs under a role, and a role
 * cannot be the principal for its own launch. Only an explicit `y`/`yes` is a yes — an empty
 * line, a closed stdin or anything else is a no, so a script piping into `alp` cannot approve
 * by accident and a prompt nobody read approves nothing.
 */
export function createTtyApprovalSurface(options: TtyApprovalSurfaceOptions): ApprovalSurface {
  return {
    supportsApproval: options.isTTY,
    async ask(decision) {
      options.stdout.write(`\n${decision.prompt}\n  rule ${decision.rule} · scope ${decision.scope}\n  approve? [y/N] `);
      const reader = createInterface({ input: options.stdin, terminal: false });
      try {
        const answer = await new Promise<string>((settle) => {
          reader.once("line", (line) => settle(line));
          reader.once("close", () => settle(""));
        });
        return YES.has(answer.trim().toLowerCase());
      } finally {
        reader.close();
      }
    },
  };
}

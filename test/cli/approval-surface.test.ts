import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createTtyApprovalSurface } from "../../src/cli/approval-surface";
import type { PolicyDecision } from "../../src/policy/types";

const QUESTION: Extract<PolicyDecision, { kind: "require_approval" }> = {
  kind: "require_approval",
  rule: "workspace-outside-grant-inside-project",
  scope: "session",
  subject: "/project/web",
  prompt: "Launch `worker` at `/project/web`? It is outside the granted workspace `/project/api` but inside the project `/project`.",
};

function terminal(answer: string) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let written = "";
  stdout.on("data", (chunk: Buffer) => { written += chunk.toString(); });
  const surface = createTtyApprovalSurface({ stdin, stdout, isTTY: true });
  const asked = surface.ask(QUESTION);
  stdin.end(answer);
  return { asked, output: () => written };
}

/**
 * Oracle: phase-1 spec — the surface belongs to the root `alp` on a TTY; without one there is
 * nothing to ask and `supportsApproval` is false. Only an explicit yes is a yes: an empty
 * line, a stray key, or a closed stdin all read as no — fail closed at the keyboard too.
 */
describe("the TTY approval surface", () => {
  it("does not support approval off a TTY", () => {
    const surface = createTtyApprovalSurface({ stdin: new PassThrough(), stdout: new PassThrough(), isTTY: false });
    expect(surface.supportsApproval).toBe(false);
  });

  it("shows the prompt with the rule and scope, and reads an explicit yes", async () => {
    const value = terminal("y\n");
    await expect(value.asked).resolves.toBe(true);
    expect(value.output()).toContain(QUESTION.prompt);
    expect(value.output()).toContain("workspace-outside-grant-inside-project");
    expect(value.output()).toContain("session");
    await expect(terminal("yes\n").asked).resolves.toBe(true);
    await expect(terminal("Y\n").asked).resolves.toBe(true);
  });

  it("reads anything but an explicit yes as no — including silence", async () => {
    await expect(terminal("n\n").asked).resolves.toBe(false);
    await expect(terminal("\n").asked).resolves.toBe(false);
    await expect(terminal("yolo\n").asked).resolves.toBe(false);
    await expect(terminal("").asked).resolves.toBe(false);
  });
});

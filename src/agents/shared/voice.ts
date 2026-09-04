import type { OutputContract } from "../types";
import { principalInstruction } from "./principal";

/**
 * Static identity only — nothing here varies per execution. That is what lets the same
 * text be rendered once into `.alp/agents/<role>.md` and into every session context, and
 * injected by the SessionStart hook before turn 1 rather than costing a Read round-trip.
 * Per-execution facts (workspace, invariants, policy) belong to `renderSessionContext`;
 * the task and its memory belong to `renderTaskInput`.
 */
export interface InstructionOptions {
  /**
   * Who reads the answer.
   *
   * `principal` (the default) gets the address-and-language rule and the report-first line —
   * right for every role whose output is prose someone reads. `machine` gets neither: titling
   * returns a bare title in the thread's own language, which the language rule contradicts
   * outright, and compaction writes a handoff for the next session. Both are told in their own
   * rules not to address the principal at all, so the lines were instructions to do the one
   * thing the same prompt forbids.
   */
  readonly audience?: "principal" | "machine";
}

export function renderInstructions(
  role: string,
  purpose: string,
  rules: readonly string[],
  options: InstructionOptions = {},
): string {
  const principalFacing = (options.audience ?? "principal") === "principal";
  return [
    `You are ${role}. ${purpose}`,
    ...(principalFacing
      ? [
        principalInstruction(),
        "State status or conclusion first. Be concise, direct, and explicit about evidence and uncertainty.",
      ]
      : []),
    ...rules.map((rule) => `- ${rule}`),
  ].join("\n");
}

export function textOutput(name: string): OutputContract<string> {
  return {
    name,
    schema: { type: "string", minLength: 1 },
    validate(value: unknown) {
      return typeof value === "string" && value.trim().length > 0
        ? { ok: true, value }
        : { ok: false, issues: ["output must be non-empty text"] };
    },
  };
}

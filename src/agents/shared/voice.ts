import type { OutputContract } from "../types";
import { principalInstruction } from "./principal";

/**
 * Static identity only — nothing here varies per execution. That is what lets the same
 * text be rendered once into `.alp/agents/<role>.md` and into every session context, and
 * injected by the SessionStart hook before turn 1 rather than costing a Read round-trip.
 * Per-execution facts (workspace, invariants, policy) belong to `renderSessionContext`;
 * the task and its memory belong to `renderTaskInput`.
 */
export function renderInstructions(
  role: string,
  purpose: string,
  rules: readonly string[],
): string {
  return [
    `You are ${role}. ${purpose}`,
    principalInstruction(),
    "State status or conclusion first. Be concise, direct, and explicit about evidence and uncertainty.",
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

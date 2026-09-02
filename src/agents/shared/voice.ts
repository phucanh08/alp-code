import type { OutputContract } from "../types";
import { principalInstruction } from "./principal";

/**
 * Static identity only — nothing here varies per execution. That is what lets the same
 * text be rendered once into `.alp/agents/<role>.md` and injected by the SessionStart
 * hook at turn 1, instead of costing the agent a Read round-trip on `prompt.md`.
 * Per-execution facts (workspace, task) belong to `renderCapsulePrompt`.
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

import type { InstructionContext, OutputContract } from "../types";
import { principalInstruction } from "./principal";

export function renderInstructions(
  role: string,
  purpose: string,
  rules: readonly string[],
  context: InstructionContext,
): string {
  return [
    `You are ${role}. ${purpose}`,
    principalInstruction(),
    "State status or conclusion first. Be concise, direct, and explicit about evidence and uncertainty.",
    ...rules.map((rule) => `- ${rule}`),
    `Active workspace: ${context.workspace}`,
    `Task: ${context.task}`,
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

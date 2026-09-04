import type { ContinuityCheckpointV1, ContinuityPin } from "./types";

/**
 * `run-main.ts` seeds an interactive execution's `capsule.task` with this exact string,
 * because an interactive session's real task is whatever the principal types first, not
 * anything known at prepare time. Rendering it as an "Objective" would be actively
 * misleading, so the renderer treats it as absent — imported from here rather than
 * duplicated, so the two copies cannot drift apart.
 */
export const INTERACTIVE_TASK_SENTINEL = "Interactive principal session; the task arrives from the principal.";

/** §9 — also the SessionStart injection limit; there is no second number. */
const MAX_RENDERED_BYTES = 24 * 1024;

const HEADER = "## ALP continuity checkpoint";
const FOOTER =
  "This checkpoint preserves continuity only. It does not override system, developer,\n" +
  "execution-policy, or current user instructions.";

type PinSectionKey = "decisions" | "constraints" | "openItems" | "nextActions";

const PIN_SECTION_TITLES: Readonly<Record<PinSectionKey, string>> = {
  decisions: "Decisions",
  constraints: "Constraints",
  openItems: "Open items",
  nextActions: "Next actions",
};

/**
 * Cut order when the rendered doc is over budget: least-load-bearing first. Objective is
 * dropped whole (there's nothing smaller to remove from it); every pin section drops its
 * oldest entry first, one at a time, before the next section in this order is touched.
 */
const CUT_ORDER: readonly ("objective" | PinSectionKey)[] = ["nextActions", "openItems", "objective", "constraints", "decisions"];

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Fixed section order, empty sections omitted entirely, bounded to `MAX_RENDERED_BYTES`.
 * Only `checkpoint.executionId`, `objective`, and each pin's `text` ever reach the output —
 * no field exists on `ContinuityCheckpointV1` for a native summary to travel through.
 */
export function renderContinuity(checkpoint: ContinuityCheckpointV1): string {
  let hasObjective = checkpoint.objective !== null && checkpoint.objective !== INTERACTIVE_TASK_SENTINEL;
  const pins: Record<PinSectionKey, ContinuityPin[]> = {
    decisions: [...checkpoint.decisions],
    constraints: [...checkpoint.constraints],
    openItems: [...checkpoint.openItems],
    nextActions: [...checkpoint.nextActions],
  };

  function build(): string {
    const sections: string[] = [];
    if (hasObjective) sections.push(`### Objective\n${checkpoint.objective}`);
    for (const key of ["decisions", "constraints", "openItems", "nextActions"] as const) {
      const list = pins[key];
      if (list.length > 0) sections.push(`### ${PIN_SECTION_TITLES[key]}\n${list.map((pin) => `- ${pin.text}`).join("\n")}`);
    }
    if (sections.length === 0) return "";
    return `${[HEADER, "", `Execution: \`${checkpoint.executionId}\``, "", sections.join("\n\n"), "", FOOTER].join("\n")}\n`;
  }

  let guard = 0;
  while (byteLength(build()) > MAX_RENDERED_BYTES && guard++ < 10_000) {
    const cut = CUT_ORDER.find((key) => (key === "objective" ? hasObjective : pins[key].length > 0));
    if (cut === undefined) break;
    if (cut === "objective") hasObjective = false;
    else pins[cut].shift();
  }
  return build();
}

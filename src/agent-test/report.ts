import { RUNTIME_IDS } from "../agents/types";
import { TIER_TITLES, type AgentTestReport, type AgentTestTier } from "./types";

const STATUS_WIDTH = 6;
const ID_WIDTH = 28;

const ARG_WIDTH = 160;

/**
 * One argument, on one line. The last argument of a launch is the task prompt — multi-line
 * and, for a role that holds no `Read`, the whole task — so printed raw it breaks the report
 * into pieces that read like sections of their own. `--json` carries it untouched.
 */
function formatArg(arg: string): string {
  const flat = arg.replaceAll("\n", "\\n");
  return flat.length > ARG_WIDTH ? `${flat.slice(0, ARG_WIDTH - 1)}…` : flat;
}

function section(title: string, lines: readonly string[]): readonly string[] {
  return lines.length === 0 ? [] : ["", `  ${title}`, ...lines.map((line) => `    ${line}`)];
}

/**
 * The report a principal reads before trusting a role. Findings first-class, and the tier 2
 * disclosure printed in full even when every check is green — "what may this role do, what
 * leaves the machine, what does it cost" is the question the command exists to answer, not
 * a diagnostic that only matters when something is broken.
 */
export function renderAgentTestReport(report: AgentTestReport): string {
  const lines: string[] = [
    `AGENT    ${report.role} — ${report.displayName} · mode ${report.mode}`,
  ];

  for (const tier of [1, 2, 3] as const satisfies readonly AgentTestTier[]) {
    const checks = report.checks.filter((check) => check.tier === tier);
    if (checks.length === 0) continue;
    lines.push("", `TIER ${tier}   ${TIER_TITLES[tier]}`);
    for (const check of checks) {
      lines.push(`  ${check.status.toUpperCase().padEnd(STATUS_WIDTH)}${check.id.padEnd(ID_WIDTH)}${check.detail}`);
    }
    if (tier === 2 && report.disclosure) {
      const { authority, egress, cost, launch } = report.disclosure;
      lines.push(
        ...section("Authority", authority),
        ...section("Egress", egress.map((line) => `- ${line}`)),
        ...section("Cost", cost.map((line) => `- ${line}`)),
        ...section("Launch", RUNTIME_IDS.map((runtime) => {
          const facts = launch[runtime];
          return `${runtime.padEnd(7)}${facts.model} · ${facts.reasoningEffort} · ${facts.argv.map(formatArg).join(" ")}`;
        })),
      );
    }
  }

  const failed = report.checks.filter((check) => check.status === "fail");
  lines.push("");
  if (failed.length === 0) {
    lines.push(`RESULT   ${report.checks.length} checks passed`);
  } else {
    lines.push(
      `RESULT   ${failed.length} of ${report.checks.length} checks failed`,
      ...failed.map((check) => `  FAIL  tier ${check.tier} ${check.id}: ${check.detail}`),
    );
    if (report.stoppedAt !== null && report.stoppedAt < 3) {
      lines.push(`  Tiers after ${report.stoppedAt} were not run: a red tier makes the ones after it unreadable.`);
    }
  }

  return `${lines.join("\n")}\n`;
}

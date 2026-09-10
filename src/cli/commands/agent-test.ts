import { relative, resolve } from "node:path";
import { renderAgentTestReport, testAgent, AGENT_TEST_TIERS, type AgentTestReport, type AgentTestTier } from "../../agent-test";
import { createCandidateRegistry, loadProjectAgents, type AgentLoadResult } from "../../agents/loader";
import { parseMode, type ModeId } from "../../agents/modes";
import type { AgentId } from "../../agents/types";

export interface AgentCommandInput {
  readonly roles: readonly AgentId[];
  readonly all: boolean;
  /** Where `.alp/agents/` is looked for. */
  readonly project: string;
  readonly tiers: readonly AgentTestTier[];
  readonly mode?: ModeId;
  readonly json: boolean;
}

export interface AgentCommandDependencies {
  readonly hooksDirectory: string;
  readonly skillsRoot: string;
  readonly assetRoot?: string;
  readonly stableCommand?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly write: (text: string) => void;
}

const USAGE = "usage: alp agent test <role|--all> [--project <path>] [--tier 1|2|3] [--mode <mode>] [--json]";

export function parseAgentCommand(args: readonly string[], cwd: string): AgentCommandInput {
  if (args[0] !== "test") throw new Error(USAGE);

  const roles: AgentId[] = [];
  const tiers: AgentTestTier[] = [];
  let mode: ModeId | undefined;
  let project = cwd;
  let json = false;
  let all = false;

  for (let index = 1; index < args.length; index += 1) {
    const value = args[index];
    const valueOf = (flag: string): string => {
      if (value.startsWith(`${flag}=`)) return value.slice(flag.length + 1);
      const next = args[index + 1];
      if (next === undefined) throw new Error(`${flag} needs a value; ${USAGE}`);
      index += 1;
      return next;
    };
    if (value === "--all") { all = true; continue; }
    if (value === "--json") { json = true; continue; }
    if (value === "--project" || value.startsWith("--project=")) { project = resolve(cwd, valueOf("--project")); continue; }
    if (value === "--tier" || value.startsWith("--tier=")) {
      const raw = Number(valueOf("--tier"));
      const tier = AGENT_TEST_TIERS.find((candidate) => candidate === raw);
      if (tier === undefined) throw new Error(`--tier must be one of ${AGENT_TEST_TIERS.join(", ")}`);
      if (!tiers.includes(tier)) tiers.push(tier);
      continue;
    }
    if (value === "--mode" || value.startsWith("--mode=")) { mode = parseMode(valueOf("--mode")); continue; }
    if (value.startsWith("-")) throw new Error(`unknown option \`${value}\`; ${USAGE}`);
    roles.push(value);
  }

  if (all && roles.length > 0) throw new Error("alp agent test takes roles or --all, not both");
  if (!all && roles.length === 0) throw new Error(USAGE);

  return {
    roles,
    all,
    project,
    tiers: tiers.length > 0 ? tiers.sort() : AGENT_TEST_TIERS,
    ...(mode ? { mode } : {}),
    json,
  };
}

function renderLoadFailures(load: AgentLoadResult, project: string): string {
  return load.failed.map((failure) => [
    `AGENT-FILE ${failure.id} — ${relative(project, failure.sourcePath) || failure.sourcePath}`,
    ...failure.issues.map((issue) => `  FAIL  ${issue}`),
    "",
  ].join("\n")).join("\n");
}

/**
 * `alp agent test` — vision §10.3 tiers 1–3, as a command rather than a suite.
 *
 * The tiers already run in `test/agents/agent-test-tiers.test.ts`, and that is not the same
 * thing: a suite proves the eight shipped roles are sound to whoever runs `npm test`, while
 * §5 asks a principal to trust a definition they wrote themselves, on their own machine,
 * before it runs with real authority. That question needs an answer they can ask.
 *
 * Custom agents in `<project>/.alp/agents/` are loaded and tested alongside the built-ins.
 * A file that never gets past the ceiling is reported with its issues and not tested — there
 * is nothing to test yet, and a definition the loader refused is exactly the case where a
 * green report would be a lie.
 *
 * Exit codes follow `alp doctor`: 0 clean, 1 findings to deal with.
 */
export async function runAgentCommand(
  input: AgentCommandInput,
  dependencies: AgentCommandDependencies,
): Promise<number> {
  const load = await loadProjectAgents({ projectRoot: input.project });
  const registry = createCandidateRegistry(load.loaded);
  const candidates = new Set(load.loaded.map((agent) => agent.id));
  const broken = new Map(load.failed.map((failure) => [failure.id, failure]));

  const requested = input.all ? registry.list().map((entry) => entry.id) : input.roles;
  // A name that did not load is a finding, not a usage error: the file exists, the issues
  // are already known, and throwing here would trade the list of what is wrong with it for
  // a message saying only that something is. Refusing to test it is the fail-closed half.
  const testable = requested.filter((role) => registry.has(role));
  for (const role of requested) {
    if (registry.has(role) || broken.has(role)) continue;
    const known = [...registry.list().map((entry) => entry.id), ...broken.keys()].join(", ");
    throw new Error(`unknown agent \`${role}\`; known: ${known}`);
  }

  const reports: AgentTestReport[] = [];
  for (const role of testable) {
    reports.push(await testAgent({
      role,
      registry,
      hooksDirectory: dependencies.hooksDirectory,
      skillsRoot: dependencies.skillsRoot,
      env: dependencies.env,
      tiers: input.tiers,
      ...(input.mode ? { mode: input.mode } : {}),
      ...(dependencies.assetRoot ? { assetRoot: dependencies.assetRoot } : {}),
      ...(dependencies.stableCommand ? { stableCommand: dependencies.stableCommand } : {}),
    }));
  }

  // Relevant when the run was meant to cover everything, or when a named role is the broken
  // one. An unrelated broken file in the same project is still printed — silence about a
  // definition that will not load is its own kind of wrong answer — but it does not decide
  // the exit code of a question that was not about it.
  const relevantFailures = input.all
    ? load.failed
    : load.failed.filter((failure) => requested.includes(failure.id));

  if (input.json) {
    dependencies.write(`${JSON.stringify({
      project: input.project,
      candidates: [...candidates],
      failedToLoad: load.failed,
      reports: input.roles.length === 1 && !input.all ? reports[0] : reports,
    }, null, 2)}\n`);
  } else {
    if (load.failed.length > 0) dependencies.write(renderLoadFailures(load, input.project));
    dependencies.write(reports.map((report) => {
      const rendered = renderAgentTestReport(report);
      return candidates.has(report.role)
        // Said out loud, because tier 2 prepares this role as though `main` already delegated
        // to it. That grant is what trust confers (§11 decision 3), and it is not in force.
        ? `${rendered}NOTE     \`${report.role}\` is a candidate from \`.alp/agents/\`, not a trusted agent; the run models the grant trust would give it.\n`
        : rendered;
    }).join("\n"));
    if (reports.length > 1) {
      const failed = reports.filter((report) => !report.ok);
      dependencies.write(failed.length === 0
        ? `\nALL      ${reports.length} agents passed tiers ${input.tiers.join(", ")}\n`
        : `\nALL      ${failed.length} of ${reports.length} agents have findings: ${failed.map((report) => report.role).join(", ")}\n`);
    }
  }

  return reports.every((report) => report.ok) && relevantFailures.length === 0 ? 0 : 1;
}

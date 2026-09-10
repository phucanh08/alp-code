import { renderAgentTestReport, testAgent, AGENT_TEST_TIERS, type AgentTestReport, type AgentTestTier } from "../../agent-test";
import { parseMode, type ModeId } from "../../agents/modes";
import type { AgentId, AgentRegistry } from "../../agents/types";

export interface AgentCommandInput {
  readonly roles: readonly AgentId[];
  readonly tiers: readonly AgentTestTier[];
  readonly mode?: ModeId;
  readonly json: boolean;
}

export interface AgentCommandDependencies {
  readonly registry: AgentRegistry;
  readonly hooksDirectory: string;
  readonly skillsRoot: string;
  readonly assetRoot?: string;
  readonly stableCommand?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly write: (text: string) => void;
}

const USAGE = "usage: alp agent test <role|--all> [--tier 1|2|3] [--mode <mode>] [--json]";

export function parseAgentCommand(args: readonly string[], registry: AgentRegistry): AgentCommandInput {
  if (args[0] !== "test") throw new Error(USAGE);

  const roles: AgentId[] = [];
  const tiers: AgentTestTier[] = [];
  let mode: ModeId | undefined;
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
    if (value === "--tier" || value.startsWith("--tier=")) {
      const raw = Number(valueOf("--tier"));
      const tier = AGENT_TEST_TIERS.find((candidate) => candidate === raw);
      if (tier === undefined) throw new Error(`--tier must be one of ${AGENT_TEST_TIERS.join(", ")}`);
      if (!tiers.includes(tier)) tiers.push(tier);
      continue;
    }
    if (value === "--mode" || value.startsWith("--mode=")) { mode = parseMode(valueOf("--mode")); continue; }
    if (value.startsWith("-")) throw new Error(`unknown option \`${value}\`; ${USAGE}`);
    // Refused here rather than at `registry.get`, so an unknown role prints the roles that
    // do exist instead of an error naming only the one that does not.
    if (!registry.has(value)) {
      throw new Error(`unknown agent \`${value}\`; known: ${registry.list().map((entry) => entry.id).join(", ")}`);
    }
    roles.push(value);
  }

  if (all && roles.length > 0) throw new Error("alp agent test takes roles or --all, not both");
  if (!all && roles.length === 0) throw new Error(USAGE);

  return {
    roles: all ? registry.list().map((entry) => entry.id) : roles,
    tiers: tiers.length > 0 ? tiers.sort() : AGENT_TEST_TIERS,
    ...(mode ? { mode } : {}),
    json,
  };
}

/**
 * `alp agent test` — vision §10.3 tiers 1–3, as a command rather than a suite.
 *
 * The tiers already run in `test/agents/agent-test-tiers.test.ts`, and that is not the same
 * thing: a suite proves the eight shipped roles are sound to whoever runs `npm test`, while
 * §5 asks a principal to trust a definition they wrote themselves, on their own machine,
 * before it runs with real authority. That question needs an answer they can ask.
 *
 * Exit codes follow `alp doctor`: 0 clean, 1 findings to deal with.
 */
export async function runAgentCommand(
  input: AgentCommandInput,
  dependencies: AgentCommandDependencies,
): Promise<number> {
  const reports: AgentTestReport[] = [];
  for (const role of input.roles) {
    reports.push(await testAgent({
      role,
      registry: dependencies.registry,
      hooksDirectory: dependencies.hooksDirectory,
      skillsRoot: dependencies.skillsRoot,
      env: dependencies.env,
      tiers: input.tiers,
      ...(input.mode ? { mode: input.mode } : {}),
      ...(dependencies.assetRoot ? { assetRoot: dependencies.assetRoot } : {}),
      ...(dependencies.stableCommand ? { stableCommand: dependencies.stableCommand } : {}),
    }));
  }

  if (input.json) {
    dependencies.write(`${JSON.stringify(input.roles.length === 1 ? reports[0] : reports, null, 2)}\n`);
  } else {
    dependencies.write(reports.map(renderAgentTestReport).join("\n"));
    if (reports.length > 1) {
      const failed = reports.filter((report) => !report.ok);
      dependencies.write(failed.length === 0
        ? `\nALL      ${reports.length} agents passed tiers ${input.tiers.join(", ")}\n`
        : `\nALL      ${failed.length} of ${reports.length} agents have findings: ${failed.map((report) => report.role).join(", ")}\n`);
    }
  }

  return reports.every((report) => report.ok) ? 0 : 1;
}

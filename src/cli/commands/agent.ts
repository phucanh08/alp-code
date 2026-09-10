import { resolve } from "node:path";
import { AGENT_TEST_TIERS, type AgentTestTier } from "../../agent-test";
import { loadProjectAgents } from "../../agents/loader";
import { parseMode, type ModeId } from "../../agents/modes";
import type { AgentId } from "../../agents/types";
import { runAgentTest, type AgentTestDependencies } from "./agent-test";
import { runAgentShow } from "./agent-show";
import { runAgentAdd, runAgentList, runAgentUntrust, type AgentTrustDependencies } from "./agent-trust";

export type AgentCommand =
  | {
    readonly kind: "test";
    readonly roles: readonly AgentId[];
    readonly all: boolean;
    readonly project: string;
    readonly tiers: readonly AgentTestTier[];
    readonly mode?: ModeId;
    readonly json: boolean;
  }
  | { readonly kind: "add"; readonly id: AgentId; readonly project: string }
  | { readonly kind: "show"; readonly id: AgentId; readonly project: string }
  | { readonly kind: "untrust"; readonly id: AgentId; readonly project: string }
  | { readonly kind: "list"; readonly project: string; readonly json: boolean };

export type AgentCommandDependencies = AgentTestDependencies & AgentTrustDependencies;

const USAGE = [
  "usage: alp agent test <role|--all> [--project <path>] [--tier 1|2|3] [--mode <mode>] [--json]",
  "       alp agent add <id> [--project <path>]",
  "       alp agent show <id> [--project <path>]",
  "       alp agent untrust <id> [--project <path>]",
  "       alp agent list [--project <path>] [--json]",
].join("\n");

export function parseAgentCommand(args: readonly string[], cwd: string): AgentCommand {
  const subcommand = args[0];
  if (subcommand !== "test" && subcommand !== "add" && subcommand !== "untrust"
    && subcommand !== "list" && subcommand !== "show") {
    throw new Error(USAGE);
  }

  const positional: string[] = [];
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
    positional.push(value);
  }

  if (subcommand === "list") {
    if (positional.length > 0) throw new Error(`alp agent list takes no agent name; ${USAGE}`);
    return { kind: "list", project, json };
  }
  if (subcommand === "add" || subcommand === "untrust" || subcommand === "show") {
    if (all || json || tiers.length > 0 || mode !== undefined) {
      throw new Error(`alp agent ${subcommand} takes only --project; ${USAGE}`);
    }
    if (positional.length !== 1) throw new Error(`alp agent ${subcommand} takes exactly one agent id; ${USAGE}`);
    return { kind: subcommand, id: positional[0], project };
  }

  if (all && positional.length > 0) throw new Error("alp agent test takes roles or --all, not both");
  if (!all && positional.length === 0) throw new Error(USAGE);
  return {
    kind: "test",
    roles: positional,
    all,
    project,
    tiers: tiers.length > 0 ? tiers.sort() : AGENT_TEST_TIERS,
    ...(mode ? { mode } : {}),
    json,
  };
}

/**
 * One load of `<project>/.alp/agents/` for whichever subcommand asked.
 *
 * Loading here rather than inside each one keeps a single answer per invocation: `add` prints
 * a report about the same definition it then hashes, and cannot end up approving a file that
 * was re-read in between.
 */
export async function runAgentCommand(
  command: AgentCommand,
  dependencies: AgentCommandDependencies,
): Promise<number> {
  if (command.kind === "untrust") return runAgentUntrust(command, dependencies);

  const load = await loadProjectAgents({ projectRoot: command.project });
  if (command.kind === "list") return runAgentList(command, load, dependencies);
  if (command.kind === "show") return runAgentShow(command, load, dependencies);
  if (command.kind === "add") return runAgentAdd(command, load, dependencies);
  return runAgentTest(command, load, dependencies);
}

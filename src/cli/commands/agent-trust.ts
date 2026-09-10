import { relative } from "node:path";
import { renderAgentTestReport, testAgent } from "../../agent-test";
import { createCandidateRegistry, type AgentLoadResult } from "../../agents/loader";
import { hashAgentDefinition } from "../../execution/execution-policy";
import {
  authorityOf,
  diffAuthority,
  readTrustedAgents,
  resolveTrust,
  trustAgent,
  trustRecordFor,
  untrustAgent,
} from "../../trust";
import type { PrincipalPrompt } from "./principal";

export interface AgentTrustDependencies {
  readonly hooksDirectory: string;
  readonly skillsRoot: string;
  readonly assetRoot?: string;
  readonly stableCommand?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly write: (text: string) => void;
  readonly interactive: boolean;
  readonly openPrompt?: () => PrincipalPrompt;
  /** Overridden in tests; defaults to `~/.alp/trusted-agents.json`. */
  readonly trustFile?: string;
}

const SHORT_HASH = 12;

function short(hash: string): string {
  return hash.slice(0, SHORT_HASH);
}

/**
 * `alp agent add <id>` — the one gate between a file in a repo and a role that can run.
 *
 * Three things happen before the question is asked, in this order, because each one makes the
 * next worth asking:
 *
 * 1. The loader has to accept it. A definition over the capability ceiling is not a trust
 *    decision, it is a broken file.
 * 2. All three tiers have to pass. An agent that cannot clear its own deny-path tests is one
 *    whose ceiling is a claim rather than a check — §11 decision 11 puts the tooling before
 *    §5 for exactly this moment.
 * 3. The full authority, egress and cost are printed, plus a capability diff when this file
 *    was trusted before under different content.
 *
 * Only then does it ask, and only a terminal may answer: there is no `--yes`. A flag that
 * approves authority without a person reading it turns the whole gate into a formality, and
 * the one place it would be used — a script, CI — is the place where nobody is reading.
 */
export async function runAgentAdd(
  input: { readonly id: string; readonly project: string },
  load: AgentLoadResult,
  dependencies: AgentTrustDependencies,
): Promise<number> {
  const failure = load.failed.find((candidate) => candidate.id === input.id);
  if (failure) {
    dependencies.write([
      `AGENT-FILE ${failure.id} — ${relative(input.project, failure.sourcePath) || failure.sourcePath}`,
      ...failure.issues.map((issue) => `  FAIL  ${issue}`),
      `REFUSED  \`${input.id}\` does not load; there is nothing to trust yet\n`,
    ].join("\n"));
    return 1;
  }

  const agent = [...load.loaded, ...load.overlays].find((candidate) => candidate.id === input.id);
  if (agent === undefined) {
    const known = [...load.loaded, ...load.overlays, ...load.failed].map((candidate) => candidate.id);
    throw new Error(known.length === 0
      ? `no agent file under \`${load.agentsDirectory}\``
      : `unknown agent \`${input.id}\`; found: ${known.join(", ")}`);
  }

  const report = await testAgent({
    role: agent.id,
    registry: createCandidateRegistry(load.loaded, undefined, load.overlays),
    hooksDirectory: dependencies.hooksDirectory,
    skillsRoot: dependencies.skillsRoot,
    env: dependencies.env,
    ...(dependencies.assetRoot ? { assetRoot: dependencies.assetRoot } : {}),
    ...(dependencies.stableCommand ? { stableCommand: dependencies.stableCommand } : {}),
  });
  dependencies.write(renderAgentTestReport(report));
  if (!report.ok) {
    dependencies.write(`REFUSED  \`${agent.id}\` has findings; fix them before trusting it\n`);
    return 1;
  }

  const currentHash = hashAgentDefinition(agent.definition);
  const authority = authorityOf(agent.definition);
  const existing = trustRecordFor(
    readTrustedAgents(dependencies.trustFile).records,
    input.project,
    agent.id,
  );

  if (existing?.definitionHash === currentHash) {
    dependencies.write(`TRUSTED  \`${agent.id}\` is already trusted at ${short(currentHash)} since ${existing.trustedAt}\n`);
    return 0;
  }

  dependencies.write(`\nHASH     ${currentHash}\n`);
  if (existing) {
    const changes = diffAuthority(existing.authority, authority);
    dependencies.write([
      `RETRUST  previously trusted at ${short(existing.definitionHash)} on ${existing.trustedAt}`,
      changes.length === 0
        ? "  authority unchanged; the prompt or workflow moved"
        : ["  authority changed:", ...changes.map((line) => `    ${line}`)].join("\n"),
      "",
    ].join("\n"));
  }

  if (!dependencies.interactive || dependencies.openPrompt === undefined) {
    dependencies.write("REFUSED  trust needs a terminal; there is no `--yes` for this command\n");
    return 1;
  }

  const prompt = dependencies.openPrompt();
  let answer: string;
  try {
    answer = await prompt.ask(`Trust \`${agent.id}\` with the authority above? Type yes to confirm: `);
  } finally {
    prompt.close();
  }
  if (answer.trim().toLowerCase() !== "yes") {
    dependencies.write(`REFUSED  \`${agent.id}\` was not trusted\n`);
    return 1;
  }

  await trustAgent({
    project: input.project,
    id: agent.id,
    definitionHash: currentHash,
    trustedAt: new Date().toISOString(),
    sourcePath: agent.sourcePath,
    authority,
  }, dependencies.trustFile);

  dependencies.write([
    `TRUSTED  \`${agent.id}\` at ${short(currentHash)}`,
    `         \`main\` may now delegate to it in ${input.project}`,
    `         editing the file revokes this: a different hash is denied, not warned about`,
    "",
  ].join("\n"));
  return 0;
}

export async function runAgentUntrust(
  input: { readonly id: string; readonly project: string },
  dependencies: AgentTrustDependencies,
): Promise<number> {
  const removed = await untrustAgent(input.project, input.id, dependencies.trustFile);
  dependencies.write(removed
    ? `REMOVED  \`${input.id}\` is no longer trusted in ${input.project}\n`
    : `NONE     \`${input.id}\` was not trusted in ${input.project}\n`);
  return removed ? 0 : 1;
}

/** What this project's agent files are, and which of them a session can actually reach. */
export function runAgentList(
  input: { readonly project: string; readonly json: boolean },
  load: AgentLoadResult,
  dependencies: AgentTrustDependencies,
): number {
  const decisions = resolveTrust(
    [...load.loaded, ...load.overlays],
    readTrustedAgents(dependencies.trustFile).records,
    input.project,
  );
  const rows = [
    ...decisions.map((decision) => ({
      id: decision.agent.id,
      status: decision.status,
      hash: decision.currentHash,
      sourcePath: decision.agent.sourcePath,
    })),
    ...load.failed.map((failure) => ({
      id: failure.id,
      status: "unloadable" as const,
      issues: failure.issues,
      sourcePath: failure.sourcePath,
    })),
  ];

  if (input.json) {
    dependencies.write(`${JSON.stringify({ project: input.project, agents: rows }, null, 2)}\n`);
    return rows.some((row) => row.status !== "trusted") ? 1 : 0;
  }

  if (rows.length === 0) {
    dependencies.write(`NONE     no agent file under ${load.agentsDirectory}\n`);
    return 0;
  }
  for (const row of rows) {
    const detail = row.status === "changed"
      ? "edited since it was trusted — denied until `alp agent add` approves it again"
      : row.status === "untrusted"
        ? "never trusted — run `alp agent add` to approve it"
        : row.status === "unloadable"
          ? ("issues" in row ? row.issues.join("; ") : "")
          : short(row.hash ?? "");
    dependencies.write(`${row.status.toUpperCase().padEnd(11)}${row.id.padEnd(20)}${detail}\n`);
  }
  return rows.some((row) => row.status !== "trusted") ? 1 : 0;
}

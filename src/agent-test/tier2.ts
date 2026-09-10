import { access, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentDefinition, RuntimeId } from "../agents/types";
import { RUNTIME_IDS } from "../agents/types";
import { MODE_PROFILES, modelForMode, reasoningEffortForMode, runtimeForMode, type ModeId, type ModeProfiles } from "../agents/modes";
import { defaultAutoCompactTokens } from "../agents/model-context";
import { enforcementNotes } from "../runtime/permission-rules";
import type { AgentDryRun } from "./dry-run";
import type { AgentTestCheck, AgentTestDisclosure, AgentTestLaunchFacts } from "./types";

const TASK_POINTER = /^ALP task is in (.+); execute it\.$/;

export interface Tier2Input {
  readonly definition: AgentDefinition<unknown>;
  readonly run: AgentDryRun;
  readonly mode: ModeId;
  /** Loadout đã ghép settings; bỏ trống thì báo cáo theo bản built-in. */
  readonly modeProfiles?: ModeProfiles;
  readonly skillsRoot: string;
}

async function directoryBytes(directory: string): Promise<number> {
  try {
    return (await stat(join(directory, "SKILL.md"))).size;
  } catch {
    return 0;
  }
}

/**
 * The Authority table as the role reads it, lifted out of the rendered session context
 * rather than rebuilt from the policy. Rebuilding it would prove the report agrees with
 * itself; lifting it proves the report agrees with the text the model will actually see.
 */
function authorityTable(sessionContext: string): readonly string[] {
  const lines = sessionContext.split("\n");
  const start = lines.indexOf("## Authority");
  if (start === -1) return [];
  const rows: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("That table is the whole")) break;
    if (line.startsWith("| ") && !line.startsWith("| --- |") && line !== "| | |") rows.push(line);
  }
  return rows;
}

export async function runTier2(input: Tier2Input): Promise<{
  readonly checks: readonly AgentTestCheck[];
  readonly disclosure: AgentTestDisclosure;
}> {
  const { definition, run, mode, skillsRoot } = input;
  const profiles = input.modeProfiles ?? MODE_PROFILES;
  const checks: AgentTestCheck[] = [];
  const add = (id: string, ok: boolean, detail: string): void => {
    checks.push({ tier: 2, id, status: ok ? "pass" : "fail", detail });
  };
  const { policy, capsule, artifacts } = run.execution;

  const scoped = RUNTIME_IDS.filter((runtime) => run.launch[runtime].cwd === run.workspace);
  add(
    "workspace-scope",
    scoped.length === RUNTIME_IDS.length
      && policy.workspace === run.workspace
      && capsule.activeWorkspace === run.workspace,
    scoped.length === RUNTIME_IDS.length && policy.workspace === run.workspace
      ? `prepared against \`${run.workspace}\`, which is not the launcher cwd`
      : `capsule/launch disagree with the requested workspace \`${run.workspace}\``,
  );

  // `capsule.allowedTools` is narrowed to the opening workflow state and only advances at
  // the Stop hook. Printing that under a table calling itself "the whole of your authority"
  // told `main` it held three tools for a session in which it held nine.
  const toolsRow = /\| Tools \| (.+) \|/.exec(run.sessionContext)?.[1] ?? "";
  const printedTools = toolsRow === "—" ? [] : toolsRow.split(", ");
  add(
    "authority-tools",
    printedTools.slice().sort().join(",") === [...policy.allowedTools].sort().join(","),
    `printed [${printedTools.join(", ") || "—"}] against session grant [${policy.allowedTools.join(", ") || "—"}]`,
  );

  const deliveryIssues: string[] = [];
  for (const runtime of RUNTIME_IDS) {
    const last = run.launch[runtime].args.at(-1) ?? "";
    const pointer = TASK_POINTER.exec(last);
    if (definition.capabilities.tools.includes("Read")) {
      if (!pointer) { deliveryIssues.push(`${runtime}: task is not delivered as a file pointer`); continue; }
      try { await access(pointer[1]); } catch { deliveryIssues.push(`${runtime}: task file \`${pointer[1]}\` is missing`); }
    } else if (pointer) {
      deliveryIssues.push(`${runtime}: pointed at a file it holds no \`Read\` tool to open`);
    }
  }
  add(
    "task-delivery",
    deliveryIssues.length === 0,
    deliveryIssues.join("; ")
      || (definition.capabilities.tools.includes("Read") ? "delivered as a readable file pointer" : "delivered inline — the role holds no `Read`"),
  );

  const directories = run.claudeSettings.permissions.additionalDirectories;
  const grantsWorkspace = definition.capabilities.workspace.readRoots.length > 0;
  add(
    "workspace-acl",
    directories.includes(run.workspace) === grantsWorkspace && directories.includes(artifacts.runtimeDirectory),
    grantsWorkspace
      ? `workspace is an additional read root${directories.includes(run.workspace) ? "" : " — but was not granted"}`
      : `memory-only role${directories.includes(run.workspace) ? " was handed the workspace tree anyway" : "; the workspace tree stays out of its ACL"}`,
  );

  const { allow, deny } = run.claudeSettings.permissions;
  add(
    "subagent-ban",
    definition.capabilities.subagents.length > 0 || (deny.includes("Task") && deny.includes("Agent")),
    definition.capabilities.subagents.length > 0
      ? `grants ${definition.capabilities.subagents.join(", ")}`
      : deny.includes("Task") && deny.includes("Agent")
        ? "the runtime's in-process agent tool is denied by ACL, not only by prompt"
        : "the runtime's in-process agent tool is reachable",
  );

  const missingSkillRules = definition.capabilities.skills.filter((skill) => !allow.includes(`Skill(${skill})`));
  add(
    "skill-acl",
    definition.capabilities.skills.length > 0
      ? missingSkillRules.length === 0 && [...policy.skills].join(",") === [...definition.capabilities.skills].join(",")
      : deny.includes("Skill"),
    definition.capabilities.skills.length === 0
      ? deny.includes("Skill") ? "`Skill` is denied outright" : "`Skill` is neither granted nor denied"
      : missingSkillRules.length > 0
        ? `no ACL rule for ${missingSkillRules.join(", ")}`
        : `ACL allows exactly ${policy.skills.join(", ")}`,
  );

  const grantedServers = definition.capabilities.mcpServers;
  const configured = Object.keys(run.mcpConfig.mcpServers);
  const codexServers = run.launch.codex.args.some((arg) => arg.startsWith("mcp_servers."));
  add(
    "mcp-isolation",
    run.launch.claude.args.includes("--strict-mcp-config")
      && configured.slice().sort().join(",") === [...grantedServers].sort().join(",")
      && codexServers === grantedServers.length > 0,
    grantedServers.length === 0
      ? run.launch.claude.args.includes("--strict-mcp-config") && configured.length === 0 && !codexServers
        ? "no server configured, and the machine's own MCP config is excluded"
        : `unauthorized egress: claude=[${configured.join(", ")}] codex=${codexServers}`
      : `configured exactly ${configured.join(", ")}`,
  );

  const alpEnv = (runtime: RuntimeId): string[] =>
    Object.keys(run.launch[runtime].env).filter((key) => key.startsWith("ALP_")).sort();
  add(
    "runtime-parity",
    alpEnv("claude").join(",") === alpEnv("codex").join(","),
    alpEnv("claude").join(",") === alpEnv("codex").join(",")
      ? `both runtimes receive the same ${alpEnv("claude").length} ALP_* variables`
      : `claude=[${alpEnv("claude").join(", ")}] codex=[${alpEnv("codex").join(", ")}]`,
  );

  const skillBytes = await Promise.all(
    definition.capabilities.skills.map(async (skill) => [skill, await directoryBytes(join(skillsRoot, skill))] as const),
  );
  const totalSkillBytes = skillBytes.reduce((sum, [, bytes]) => sum + bytes, 0);
  const selectedRuntime = runtimeForMode(definition, mode, profiles);

  const launch: Record<string, AgentTestLaunchFacts> = {};
  for (const runtime of RUNTIME_IDS) {
    launch[runtime] = {
      model: definition.model[runtime],
      reasoningEffort: definition.reasoningEffort[runtime],
      cwd: run.launch[runtime].cwd,
      argv: [run.launch[runtime].command, ...run.launch[runtime].args],
    };
  }

  const webTools = definition.capabilities.tools.filter((tool) => tool === "WebFetch" || tool === "WebSearch");
  const disclosure: AgentTestDisclosure = {
    authority: authorityTable(run.sessionContext),
    enforcement: enforcementNotes(policy),
    egress: [
      webTools.length > 0 ? `tools reaching the network: ${webTools.join(", ")}` : "no network tool granted",
      policy.mcpServers.length > 0
        ? `MCP: ${policy.mcpServers.map((server) => `${server.name} (${server.egress} egress) — ${server.command} ${server.args.join(" ")}`).join("; ")}`
        : "no MCP server granted; the machine's own config is excluded",
    ],
    cost: [
      `mode \`${mode}\` runs this role on ${selectedRuntime} · ${modelForMode(definition, mode, profiles)} · ${reasoningEffortForMode(definition, mode, profiles)}`,
      ...RUNTIME_IDS.map((runtime) => {
        const declared = policy.autoCompactTokens[runtime];
        const fallback = defaultAutoCompactTokens(definition.model[runtime]);
        return `auto-compact ${runtime}: ${declared === null
          ? fallback === null ? "runtime default (no published window)" : `${fallback.toLocaleString("en-US")} (90% of window)`
          : declared.toLocaleString("en-US")}`;
      }),
      `identity ${capsule.instructions.length} chars · session context ${run.sessionContext.length} chars`,
      definition.capabilities.skills.length === 0
        ? "no skill enters context"
        : `${definition.capabilities.skills.length} skill, ${totalSkillBytes.toLocaleString("en-US")} bytes of SKILL.md behind the \`Skill\` tool`,
    ],
    launch: launch as Readonly<Record<RuntimeId, AgentTestLaunchFacts>>,
  };

  return { checks, disclosure };
}

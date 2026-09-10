import { delimiter, relative } from "node:path";
import type { AgentLoadResult } from "../../agents/loader";
import { agentRegistry } from "../../agents/registry";
import { renderInstructions } from "../../agents/shared/voice";
import type { AgentDefinition } from "../../agents/types";
import { runtimeSkillRoots } from "../../runtime/adapter-files";
import { readTrustedAgents, resolveTrust } from "../../trust";
import type { AgentTrustDependencies } from "./agent-trust";

function row(label: string, value: string): string {
  return `  ${label.padEnd(16)}${value || "—"}\n`;
}

/**
 * `alp agent show <id>` — what this role is, and **in what order its skills resolve**.
 *
 * §5.7.1 requires the order to be printed because shadowing is the one thing about it a
 * principal cannot infer: a project's `code-review` beating the shipped one is correct and
 * intended, and indistinguishable from a mistake unless something says which copy won.
 */
export function runAgentShow(
  input: { readonly id: string; readonly project: string },
  load: AgentLoadResult,
  dependencies: AgentTrustDependencies,
): number {
  const project = [...load.loaded, ...load.overlays].find((candidate) => candidate.id === input.id);
  const builtin = agentRegistry.has(input.id) ? agentRegistry.get(input.id) : null;
  const definition: AgentDefinition<unknown> | null = project?.definition ?? builtin;
  if (definition === null) {
    const failure = load.failed.find((candidate) => candidate.id === input.id);
    if (failure) {
      dependencies.write([
        `AGENT-FILE ${failure.id} — ${relative(input.project, failure.sourcePath) || failure.sourcePath}`,
        ...failure.issues.map((issue) => `  FAIL  ${issue}`),
        "",
      ].join("\n"));
      return 1;
    }
    throw new Error(`unknown agent \`${input.id}\``);
  }

  const source = project === undefined
    ? "built-in"
    : load.overlays.includes(project)
      ? `built-in + skill overlay (${relative(input.project, project.sourcePath) || project.sourcePath})`
      : relative(input.project, project.sourcePath) || project.sourcePath;

  const [decision] = project === undefined
    ? []
    : resolveTrust([project], readTrustedAgents(dependencies.trustFile).records, input.project);

  const { capabilities } = definition;
  let out = `AGENT    ${definition.id} — ${definition.displayName}\n`;
  out += row("source", source);
  if (decision) out += row("trust", `${decision.status} (${decision.currentHash.slice(0, 12)})`);
  out += row("reports to", definition.reportsTo);
  out += row("delegates to", definition.delegatesTo.join(", "));
  out += row("tools", capabilities.tools.join(", "));
  out += row("skills", capabilities.skills.join(", "));
  out += row("memory read", capabilities.memory.read.join(", "));
  out += row("memory write", capabilities.memory.write.join(", "));
  out += row("workspace", `read ${capabilities.workspace.readRoots.join(", ") || "none"} · write ${capabilities.workspace.writeRoots.join(", ") || "none"}`);

  const roots = runtimeSkillRoots(dependencies.env, dependencies.assetRoot, capabilities.skillRoots ?? []).split(delimiter);
  out += "\n  skill resolve order (first match wins)\n";
  roots.forEach((root, index) => { out += `    ${index + 1}. ${root}\n`; });
  if ((capabilities.skillBindings ?? []).length > 0) {
    out += "\n  project skills\n";
    for (const binding of capabilities.skillBindings ?? []) {
      out += `    ${binding.name.padEnd(24)}${binding.kind.padEnd(10)}${binding.path}\n`;
    }
  }
  out += `\n  identity renders to ${renderInstructions(definition.instructions).length} chars\n`;

  dependencies.write(out);
  return 0;
}

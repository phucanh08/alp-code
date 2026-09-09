import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { agentRegistry } from "../agents/registry";
import type { InstallLayout } from "../install-layout";
import { readInstallManifest } from "../install-layout";
import { loadDelegationConfig } from "./config";
import { executionsDirectory, installRecord, memoryRoot } from "./paths";
import { hostBinaryTarget } from "./targets";
import { ClaudeRuntimeAdapter } from "../runtime/claude-adapter";
import { CodexRuntimeAdapter } from "../runtime/codex-adapter";

export interface DoctorFinding { readonly tag: string; readonly message: string; readonly remediation?: string }

export function inspectInstallation(layout: InstallLayout, env: NodeJS.ProcessEnv = process.env): {
  readonly observations: readonly DoctorFinding[];
  readonly findings: readonly DoctorFinding[];
} {
  const observations: DoctorFinding[] = [];
  const findings: DoctorFinding[] = [];
  const checkDirectory = (tag: string, directory: string) => {
    try {
      accessSync(directory, constants.R_OK | constants.W_OK);
      const mode = statSync(directory).mode & 0o777;
      if (process.platform !== "win32" && (mode & 0o077)) findings.push({ tag, message: `${directory} permissions are ${mode.toString(8)}`, remediation: `chmod 700 ${JSON.stringify(directory)}` });
      else observations.push({ tag, message: `${directory} accessible` });
    } catch (error) { findings.push({ tag, message: (error as Error).message }); }
  };

  try {
    if (layout.channel !== "dev") {
      const manifest = readInstallManifest(layout.installRoot, layout.version);
      const target = hostBinaryTarget();
      if (manifest.target !== target.id) {
        findings.push({ tag: "TARGET", message: `artifact ${manifest.target} is running on ${target.id}`, remediation: "reinstall the matching ALP archive" });
      } else observations.push({ tag: "TARGET", message: manifest.target });
    }
    observations.push({ tag: "ARTIFACT", message: `${layout.channel} ${layout.installRoot}` });
  } catch (error) { findings.push({ tag: "ARTIFACT", message: (error as Error).message, remediation: "alp update" }); }
  if (layout.channel === "binary") {
    try {
      accessSync(layout.stableCommand, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      observations.push({ tag: "STABLE-COMMAND", message: layout.stableCommand });
    } catch (error) {
      findings.push({ tag: "STABLE-COMMAND", message: `${layout.stableCommand}: ${(error as Error).message}`, remediation: "re-run the binary installer" });
    }
    const current = join(dirname(dirname(layout.installRoot)), "current");
    try {
      const actual = realpathSync(current);
      if (actual !== realpathSync(layout.installRoot)) {
        findings.push({ tag: "CURRENT", message: `${current} points to ${actual}, running ${layout.installRoot}`, remediation: "finish the update or restore the documented previous-version pointer" });
      } else observations.push({ tag: "CURRENT", message: `${current} → ${actual}` });
    } catch (error) {
      findings.push({ tag: "CURRENT", message: `${current}: ${(error as Error).message}`, remediation: "re-run the binary installer" });
    }
  }
  if (!agentRegistry.has("main")) findings.push({ tag: "AGENT-REGISTRY", message: "main agent missing" });
  else observations.push({ tag: "AGENT-REGISTRY", message: `${agentRegistry.list().length} agents valid` });
  for (const [tag, directory] of [
    ["MEMORY", memoryRoot(env)],
    ["EXECUTION-STATE", executionsDirectory(env)],
    ["DELEGATION-STATE", loadDelegationConfig(layout.installRoot, env, layout.channel).stateDir],
  ] as const) checkDirectory(tag, directory);
  if (!existsSync(installRecord(env))) findings.push({ tag: "INSTALL-RECORD", message: `missing ${installRecord(env)}`, remediation: "alp __internal ensure-state" });
  return Object.freeze({ observations: Object.freeze(observations), findings: Object.freeze(findings) });
}

export async function renderDoctor(layout: InstallLayout, env: NodeJS.ProcessEnv, quiet = false): Promise<{ output: string; exitCode: number }> {
  try {
    const report = inspectInstallation(layout, env);
    const observations = [...report.observations];
    const findings = [...report.findings];
    for (const [tag, adapter] of [
      ["RUNTIME-CLAUDE", new ClaudeRuntimeAdapter({ stableCommand: layout.stableCommand, assetRoot: layout.assetRoot })],
      ["RUNTIME-CODEX", new CodexRuntimeAdapter({ stableCommand: layout.stableCommand, assetRoot: layout.assetRoot })],
    ] as const) {
      try {
        const health = await adapter.probe();
        if (health.ok) observations.push({ tag, message: health.message });
        else findings.push({ tag, message: health.message, remediation: health.remediation });
      } catch (error) {
        findings.push({ tag, message: (error as Error).message, remediation: `install ${adapter.name} CLI and ensure it is on PATH` });
      }
    }
    const lines = [
      ...(quiet ? [] : observations.map((item) => `${item.tag.padEnd(20)} ${item.message}`)),
      ...findings.map((item) => `${item.tag.padEnd(20)} ${item.message}${item.remediation ? `\n${" ".repeat(20)} → fix: ${item.remediation}` : ""}`),
      ...(!quiet && findings.length === 0 ? ["OK                   code-native alp-code healthy"] : []),
    ];
    return { output: lines.length ? `${lines.join("\n")}\n` : "", exitCode: findings.length ? 1 : 0 };
  } catch (error) {
    return { output: `ERROR                doctor failed: ${(error as Error).message}\n`, exitCode: 2 };
  }
}

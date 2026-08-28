import { delimiter, dirname, join } from "node:path";
import { agentRegistry } from "../agents/registry";
import { atomicRuntimeFile, baseRuntimeEnvironment, hookCommand, renderCapsulePrompt, resolveRuntimeCommand, runtimeSkillRoots } from "./adapter-files";
import { codexSandboxLines } from "./permission-rules";
import type { PrepareRuntimeInput, RuntimeAdapter, RuntimeHealth, RuntimeLaunchSpec } from "./runtime-adapter";

export interface CodexRuntimeAdapterOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly hooksDirectory?: string;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export class CodexRuntimeAdapter implements RuntimeAdapter {
  readonly name = "codex" as const;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly hooksDirectory: string;

  constructor(options: CodexRuntimeAdapterOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.hooksDirectory = options.hooksDirectory ?? join(this.env.ALP_REPO_ROOT ?? process.cwd(), "hooks");
  }

  private memoryRoot(): string {
    return this.env.ALP_MEMORY_ROOT ?? join(this.env.ALP_REPO_ROOT ?? process.cwd(), "memory");
  }

  async probe(): Promise<RuntimeHealth> {
    const resolved = await resolveRuntimeCommand("codex", this.platform, this.env);
    const command = resolved ?? (this.platform === "win32" ? "codex.cmd" : "codex");
    return resolved
      ? { ok: true, runtime: this.name, message: `${command} available` }
      : { ok: false, runtime: this.name, message: `${command} not found`, remediation: "Install Codex CLI and ensure it is on PATH." };
  }

  async prepare(input: PrepareRuntimeInput): Promise<RuntimeLaunchSpec> {
    const { capsule, policy, artifacts } = input.execution;
    const capsuleFile = await atomicRuntimeFile(
      join(artifacts.runtimeDirectory, "identity-capsule.json"),
      `${JSON.stringify(capsule, null, 2)}\n`,
    );
    const prompt = renderCapsulePrompt(capsule);
    const skillRoots = runtimeSkillRoots(this.env);
    const bootCommand = hookCommand(join(this.hooksDirectory, "session-boot.cjs"));
    const stopCommand = hookCommand(join(this.hooksDirectory, "session-end.cjs"));
    const bootHooks = `[{ hooks = [{ type = "command", command = ${tomlString(bootCommand)}, timeout = 30 }] }]`;
    const stopHooks = `[{ hooks = [{ type = "command", command = ${tomlString(stopCommand)}, timeout = 30 }] }]`;
    const promptFile = await atomicRuntimeFile(join(artifacts.runtimeDirectory, "prompt.md"), `${prompt}\n`);
    const configFile = await atomicRuntimeFile(
      join(artifacts.runtimeDirectory, "codex-config.toml"),
      [
        `model = ${tomlString(input.model)}`,
        `model_reasoning_effort = ${tomlString(input.reasoningEffort)}`,
        `sandbox_mode = ${tomlString(policy.workspaceMode)}`,
        ...codexSandboxLines({
          policy,
          memoryRoot: this.memoryRoot(),
          allRoles: agentRegistry.list().map((definition) => definition.id),
        }),
        "[alp]",
        `execution_id = ${tomlString(capsule.executionId)}`,
        `capsule = ${tomlString(capsuleFile)}`,
        `prompt = ${tomlString(promptFile)}`,
        "",
      ].join("\n"),
    );
    const skillRootsFile = await atomicRuntimeFile(
      join(artifacts.runtimeDirectory, "skill-roots.json"),
      `${JSON.stringify(skillRoots.split(delimiter).filter(Boolean), null, 2)}\n`,
    );
    const env = {
      ...baseRuntimeEnvironment(capsule),
      ALP_EXECUTION_ROOT: dirname(artifacts.directory),
      ALP_MEMORY_ROOT: this.memoryRoot(),
      ALP_IDENTITY_CAPSULE: capsuleFile,
      ALP_RUNTIME_CONFIG: configFile,
      ALP_SKILL_ROOTS: skillRoots,
      ...(policy.workspaceMode === "read-only" ? { ALP_READONLY_DIRS: capsule.activeWorkspace } : {}),
    };
    const command = (await resolveRuntimeCommand("codex", this.platform, this.env))
      ?? (this.platform === "win32" ? "codex.cmd" : "codex");
    return Object.freeze({
      command,
      args: Object.freeze([
        ...(input.interactive ? [] : ["exec", "--skip-git-repo-check"]),
        "--dangerously-bypass-hook-trust",
        "--enable", "hooks",
        "-C", capsule.activeWorkspace,
        "-m", input.model,
        "-c", `model_reasoning_effort=${tomlString(input.reasoningEffort)}`,
        "-c", `hooks.SessionStart=${bootHooks}`,
        "-c", `hooks.Stop=${stopHooks}`,
        "-s", policy.workspaceMode,
        `ALP execution input is in ${promptFile}; read it before continuing.`,
      ]),
      cwd: capsule.activeWorkspace,
      env: Object.freeze(env),
      temporaryFiles: Object.freeze([capsuleFile, promptFile, configFile, skillRootsFile]),
    });
  }
}

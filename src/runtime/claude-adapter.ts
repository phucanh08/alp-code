import { delimiter, dirname, join } from "node:path";
import { atomicRuntimeFile, baseRuntimeEnvironment, hookCommand, renderCapsulePrompt, resolveRuntimeCommand, runtimeSkillRoots } from "./adapter-files";
import type { PrepareRuntimeInput, RuntimeAdapter, RuntimeHealth, RuntimeLaunchSpec } from "./runtime-adapter";

export interface ClaudeRuntimeAdapterOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly hooksDirectory?: string;
}

export class ClaudeRuntimeAdapter implements RuntimeAdapter {
  readonly name = "claude" as const;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly hooksDirectory: string;

  constructor(options: ClaudeRuntimeAdapterOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.hooksDirectory = options.hooksDirectory ?? join(this.env.ALP_REPO_ROOT ?? process.cwd(), "hooks");
  }

  async probe(): Promise<RuntimeHealth> {
    const resolved = await resolveRuntimeCommand("claude", this.platform, this.env);
    const command = resolved ?? (this.platform === "win32" ? "claude.cmd" : "claude");
    return resolved
      ? { ok: true, runtime: this.name, message: `${command} available` }
      : { ok: false, runtime: this.name, message: `${command} not found`, remediation: "Install Claude Code and ensure it is on PATH." };
  }

  async prepare(input: PrepareRuntimeInput): Promise<RuntimeLaunchSpec> {
    const { capsule, policy, artifacts } = input.execution;
    const capsuleFile = await atomicRuntimeFile(
      join(artifacts.runtimeDirectory, "identity-capsule.json"),
      `${JSON.stringify(capsule, null, 2)}\n`,
    );
    const prompt = renderCapsulePrompt(capsule);
    const promptFile = await atomicRuntimeFile(join(artifacts.runtimeDirectory, "prompt.md"), `${prompt}\n`);
    const skillRoots = runtimeSkillRoots(this.env);
    const settingsFile = await atomicRuntimeFile(
      join(artifacts.runtimeDirectory, "claude-settings.json"),
      `${JSON.stringify({
        $schema: "https://json.schemastore.org/claude-code-settings.json",
        alp: { executionId: capsule.executionId, policyHash: capsule.policyHash, capsuleFile, promptFile },
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: hookCommand(join(this.hooksDirectory, "acl-guard.cjs")) }] }],
          Stop: [{ hooks: [{ type: "command", command: hookCommand(join(this.hooksDirectory, "session-end.cjs")) }] }],
        },
        ...(policy.workspaceMode === "read-only" ? {
          sandbox: {
            enabled: true,
            failIfUnavailable: true,
            allowUnsandboxedCommands: false,
            filesystem: { denyWrite: [capsule.activeWorkspace] },
          },
        } : {}),
      }, null, 2)}\n`,
    );
    const skillRootsFile = await atomicRuntimeFile(
      join(artifacts.runtimeDirectory, "skill-roots.json"),
      `${JSON.stringify(skillRoots.split(delimiter).filter(Boolean), null, 2)}\n`,
    );
    const env = {
      ...baseRuntimeEnvironment(capsule),
      ALP_EXECUTION_ROOT: dirname(artifacts.directory),
      ALP_MEMORY_ROOT: this.env.ALP_MEMORY_ROOT ?? join(this.env.ALP_REPO_ROOT ?? process.cwd(), "memory"),
      ALP_IDENTITY_CAPSULE: capsuleFile,
      ALP_RUNTIME_CONFIG: settingsFile,
      ALP_SKILL_ROOTS: skillRoots,
      ...(policy.workspaceMode === "read-only" ? { ALP_READONLY_DIRS: capsule.activeWorkspace } : {}),
    };
    const command = (await resolveRuntimeCommand("claude", this.platform, this.env))
      ?? (this.platform === "win32" ? "claude.cmd" : "claude");
    return Object.freeze({
      command,
      args: Object.freeze([
        "--settings", settingsFile,
        "--model", input.model,
        ...(policy.workspaceMode === "read-only" ? ["--permission-mode", "plan"] : []),
        `ALP execution input is in ${promptFile}; read it before continuing.`,
      ]),
      cwd: capsule.activeWorkspace,
      env: Object.freeze(env),
      temporaryFiles: Object.freeze([capsuleFile, promptFile, settingsFile, skillRootsFile]),
    });
  }
}

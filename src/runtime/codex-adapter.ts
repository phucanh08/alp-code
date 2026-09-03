import { delimiter, dirname, join } from "node:path";
import { agentRegistry } from "../agents/registry";
import { atomicRuntimeFile, baseRuntimeEnvironment, hookCommand, resolveRuntimeCommand, runtimeSkillRoots, taskArguments, writeRuntimeContextFiles } from "./adapter-files";
import { codexSandboxLines, tomlString } from "./permission-rules";
import type { PrepareRuntimeInput, RuntimeAdapter, RuntimeHealth, RuntimeLaunchSpec } from "./runtime-adapter";

export interface CodexRuntimeAdapterOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly hooksDirectory?: string;
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

  /**
   * A hook command Codex can actually run, which on Windows is not the same string Claude
   * Code needs.
   *
   * Codex runs hooks through a bare `cmd.exe /C`. That shell has a documented rule: when the
   * command line starts with a quote and carries more than two of them, it strips the first
   * and the last quote and runs whatever remains. `"<node>" "<script>"` therefore arrives as
   * `C:\Program Files\…\node.exe" "…\session-boot.cjs`, which cmd splits at the first space —
   * measured on Windows as `'C:\Program' is not recognized`, exit 1, no output. Both hooks
   * failed that way, so a Codex session ran with no identity at all.
   *
   * One more quote pair around the whole thing is the documented answer: cmd strips the pair
   * it was going to strip anyway and the inner command survives intact. Claude Code must NOT
   * get this treatment — it spawns via `cmd /d /s /c "<command>"`, where `/s` already consumes
   * one outer pair, so the extra pair would break the string that works there today.
   */
  private hookCommand(script: string): string {
    const command = hookCommand(join(this.hooksDirectory, script));
    return this.platform === "win32" ? `"${command}"` : command;
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
    const contextFiles = await writeRuntimeContextFiles(input.execution, input.interactive);
    const skillRoots = runtimeSkillRoots(this.env);
    const bootCommand = this.hookCommand("session-boot.cjs");
    const stopCommand = this.hookCommand("session-end.cjs");
    const bootHooks = `[{ hooks = [{ type = "command", command = ${tomlString(bootCommand)}, timeout = 30 }] }]`;
    const stopHooks = `[{ hooks = [{ type = "command", command = ${tomlString(stopCommand)}, timeout = 30 }] }]`;
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
        `session_context = ${tomlString(contextFiles.sessionContextFile)}`,
        ...(contextFiles.taskFile === null ? [] : [`task = ${tomlString(contextFiles.taskFile)}`]),
        "",
      ].join("\n"),
    );
    const skillRootsFile = await atomicRuntimeFile(
      join(artifacts.runtimeDirectory, "skill-roots.json"),
      `${JSON.stringify(skillRoots.split(delimiter).filter(Boolean), null, 2)}\n`,
    );
    const env = {
      ...baseRuntimeEnvironment(capsule, contextFiles),
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
        // Đối xứng với `--dangerously-skip-permissions` của Claude: phiên interactive bỏ approval
        // và sandbox. `-s` bị bỏ đi chứ không để lẫn — Codex không báo lỗi khi có cả hai (chỉ
        // `--approve-for-me` mới khai `conflicts_with`), cờ bypass thắng và `-s` thành dòng chết
        // nói sai về chế độ đang chạy. Delegate luôn interactive=false nên vẫn đi nhánh `-s`.
        ...(input.interactive
          ? ["--dangerously-bypass-approvals-and-sandbox"]
          : ["-s", policy.workspaceMode]),
        // Measured on codex-cli 0.149.0: a positional PROMPT becomes a `role: user` message,
        // i.e. turn 1. Interactive must not have one — identity reaches the model as a
        // `role: developer` message from the SessionStart hook, ahead of the user's turn.
        ...taskArguments(contextFiles),
      ]),
      cwd: capsule.activeWorkspace,
      env: Object.freeze(env),
      temporaryFiles: Object.freeze([
        capsuleFile,
        contextFiles.sessionContextFile,
        ...(contextFiles.taskFile === null ? [] : [contextFiles.taskFile]),
        configFile,
        skillRootsFile,
      ]),
    });
  }
}

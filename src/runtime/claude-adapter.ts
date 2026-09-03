import { delimiter, dirname, join } from "node:path";
import { agentRegistry } from "../agents/registry";
import { atomicRuntimeFile, baseRuntimeEnvironment, hookCommand, resolveRuntimeCommand, runtimeSkillRoots, taskArguments, writeRuntimeContextFiles } from "./adapter-files";
import { claudePermissions } from "./permission-rules";
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

  /**
   * Claude Code does not activate its filesystem sandbox on Windows — it reports the
   * feature gate as off and, because ALP asks for `failIfUnavailable`, refuses to start at
   * all. Requesting a sandbox that cannot exist turns every delegated execution on Windows
   * into a startup failure, so the request is made only where it can be honoured. The
   * read-only guarantee is not dropped with it: `claudePermissions` withdraws `Bash`
   * instead, since a shell is the only remaining way such a role could write.
   */
  private sandboxAvailable(): boolean {
    return this.platform !== "win32";
  }

  private memoryRoot(): string {
    return this.env.ALP_MEMORY_ROOT ?? join(this.env.ALP_REPO_ROOT ?? process.cwd(), "memory");
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
    const contextFiles = await writeRuntimeContextFiles(input.execution, input.interactive);
    const skillRoots = runtimeSkillRoots(this.env);
    const settingsFile = await atomicRuntimeFile(
      join(artifacts.runtimeDirectory, "claude-settings.json"),
      `${JSON.stringify({
        $schema: "https://json.schemastore.org/claude-code-settings.json",
        alp: {
          executionId: capsule.executionId,
          policyHash: capsule.policyHash,
          capsuleFile,
          sessionContextFile: contextFiles.sessionContextFile,
          ...(contextFiles.taskFile === null ? {} : { taskFile: contextFiles.taskFile }),
        },
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: hookCommand(join(this.hooksDirectory, "session-boot.cjs")) }] }],
          Stop: [{ hooks: [{ type: "command", command: hookCommand(join(this.hooksDirectory, "session-end.cjs")) }] }],
        },
        permissions: claudePermissions({
          policy,
          memoryRoot: this.memoryRoot(),
          runtimeDirectory: artifacts.runtimeDirectory,
          allRoles: agentRegistry.list().map((definition) => definition.id),
          sandboxed: this.sandboxAvailable(),
        }),
        ...(policy.workspaceMode === "read-only" && this.sandboxAvailable() ? {
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
      ...baseRuntimeEnvironment(capsule, contextFiles),
      ALP_EXECUTION_ROOT: dirname(artifacts.directory),
      ALP_MEMORY_ROOT: this.memoryRoot(),
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
        // Principal ngồi trước phiên interactive và tự duyệt được từng bước, nên prompt quyền chỉ
        // là ma sát. Đánh đổi phải nói rõ: cờ này vô hiệu hoá `permissions.deny` ở settings trên —
        // gồm cả cách ly private memory giữa các role, thứ chỉ Claude cưỡng chế được (§ACL trong
        // permission-rules.ts). Chỉ `alp` (run-main) đặt interactive=true; `alp delegate` luôn
        // false, nên specialist giữ nguyên sandbox và deny list.
        ...(input.interactive
          ? ["--dangerously-skip-permissions"]
          : policy.workspaceMode === "read-only" ? ["--permission-mode", "plan"] : []),
        // Empty when interactive: the principal's own first message is turn 1. Identity,
        // invariants and policy have already arrived via the SessionStart hook.
        ...taskArguments(contextFiles),
      ]),
      cwd: capsule.activeWorkspace,
      env: Object.freeze(env),
      temporaryFiles: Object.freeze([
        capsuleFile,
        contextFiles.sessionContextFile,
        ...(contextFiles.taskFile === null ? [] : [contextFiles.taskFile]),
        settingsFile,
        skillRootsFile,
      ]),
    });
  }
}

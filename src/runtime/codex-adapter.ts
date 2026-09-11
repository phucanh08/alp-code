import { delimiter, dirname, join } from "node:path";
import { defaultAutoCompactTokens } from "../agents/model-context";
import { agentRegistry } from "../agents/registry";
import { memoryRoot as resolveMemoryRoot } from "../state-paths";
import { atomicRuntimeFile, baseRuntimeEnvironment, compactBridgeEnabled, hookCommand, resolveRuntimeCommand, runtimeSkillRoots, taskArguments, writeRuntimeContextFiles } from "./adapter-files";
import { codexMcpOverrides, codexSandboxLines, tomlString } from "./permission-rules";
import type { PrepareRuntimeInput, RuntimeAdapter, RuntimeHealth, RuntimeLaunchSpec } from "./runtime-adapter";
import { hookInvocation, renderHookCommand } from "./hook-command";

export interface CodexRuntimeAdapterOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly hooksDirectory?: string;
  readonly stableCommand?: string;
  readonly assetRoot?: string;
  readonly windowsPathCommand?: string;
}

export class CodexRuntimeAdapter implements RuntimeAdapter {
  readonly name = "codex" as const;

  /**
   * Measured on Codex CLI 0.153.0 (schema 2026-09-03; live 2026-09-04 headless on darwin
   * and win32, and inherited TTY on win32 with `trigger=manual`). Codex reinjects after it
   * finishes, and only once the next turn begins:
   *
   *   PreCompact -> PostCompact -> SessionStart(source="compact")
   *
   * measured at 7s past `PostCompact`, which was a human typing. Two earlier sessions
   * exited straight after compacting, saw no `SessionStart`, and nearly had this pinned
   * `false`. `manual` and `auto` payloads are identical apart from `trigger`.
   */
  readonly compact = Object.freeze({
    preCompact: true,
    postCompact: true,
    sessionStartAfterCompact: true,
  });
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly hooksDirectory: string;
  private readonly stableCommand?: string;
  private readonly assetRoot?: string;
  private readonly windowsPathCommand?: string;

  constructor(options: CodexRuntimeAdapterOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.hooksDirectory = options.hooksDirectory ?? join(this.env.ALP_REPO_ROOT ?? process.cwd(), "hooks");
    this.stableCommand = options.stableCommand;
    this.assetRoot = options.assetRoot;
    this.windowsPathCommand = options.windowsPathCommand;
  }

  private memoryRoot(): string {
    return resolveMemoryRoot(this.env);
  }

  /**
   * A hook command Codex can actually run, which on Windows is not the same string Claude
   * Code needs.
   *
   * Codex splits the hook command into argv itself, and the first token may not be quoted:
   * a command line that *starts with* `"` never resolves an executable. Measured on
   * `codex-cli 0.153.0` (native `codex.exe`), both `"<node>" "<script>"` and the extra
   * quote-pair form `""<node>" "<script>""` that v0.3.1 shipped report
   * `hook: SessionStart Failed`, print nothing and leave the session with no identity —
   * the pair theory was a `cmd /C` rule Codex turns out not to go through. Quoting the
   * *later* arguments is fine: `<node> "<script>"` and `node "<script>"` both run, and the
   * script path stays quoted because it can hold spaces.
   *
   * The interpreter therefore goes in bare. `process.execPath` is exact and used as-is when
   * it has no space; when it does — `C:\Program Files\nodejs\node.exe`, the default install —
   * the only bare spelling left is `node` off PATH, which the installed `alp.cmd` shim
   * already depends on. Claude Code must NOT get this treatment: it spawns via
   * `cmd /d /s /c "<command>"`, where the quoted form is what works today.
   */
  private hookCommand(script: "session-boot" | "session-end" | "compact-record", args: readonly string[] = []): string {
    if (this.stableCommand) return renderHookCommand(hookInvocation(this.stableCommand, script, args), {
      platform: this.platform,
      runtime: "codex",
      ...(this.windowsPathCommand ? { windowsPathCommand: this.windowsPathCommand } : {}),
    });
    const path = join(this.hooksDirectory, `${script}.cjs`);
    if (this.platform !== "win32") return `${hookCommand(path)}${args.length ? ` ${args.join(" ")}` : ""}`;
    const node = process.execPath.includes(" ") ? "node" : process.execPath;
    return `${node} "${path}"${args.length ? ` ${args.join(" ")}` : ""}`;
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
    const skillRoots = runtimeSkillRoots(this.env, this.assetRoot, policy.skillRoots);
    const bootCommand = this.hookCommand("session-boot");
    const stopCommand = this.hookCommand("session-end");
    const bootHooks = `[{ hooks = [{ type = "command", command = ${tomlString(bootCommand)}, timeout = 30 }] }]`;
    const stopHooks = `[{ hooks = [{ type = "command", command = ${tomlString(stopCommand)}, timeout = 30 }] }]`;
    // Gated on the flag (§10), same as Claude — only the two events CB-0 measured as firing
    // on this runtime. `manual` and `auto` were measured identical apart from `trigger`
    // (plan §Runtime capability), so one registration covers both.
    const bridgeEnabled = compactBridgeEnabled(this.env);
    const preCompactCommand = this.hookCommand("compact-record", ["pre", "codex"]);
    const postCompactCommand = this.hookCommand("compact-record", ["post", "codex"]);
    const preCompactHooks = `[{ hooks = [{ type = "command", command = ${tomlString(preCompactCommand)}, timeout = 30 }] }]`;
    const postCompactHooks = `[{ hooks = [{ type = "command", command = ${tomlString(postCompactCommand)}, timeout = 30 }] }]`;
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
          // Unused here: Codex's sandbox restricts writes only, so reading the task file is
          // never in question. Supplied because the grant is part of the shared contract,
          // and making it optional is what let Claude ship without it.
          runtimeDirectory: artifacts.runtimeDirectory,
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
    const autoCompactTokens = policy.autoCompactTokens[this.name] ?? defaultAutoCompactTokens(input.model);
    const env = {
      ...baseRuntimeEnvironment(capsule, contextFiles, artifacts, input.binding),
      ALP_EXECUTION_ROOT: dirname(artifacts.directory),
      ALP_MEMORY_ROOT: this.memoryRoot(),
      ALP_IDENTITY_CAPSULE: capsuleFile,
      ALP_RUNTIME_CONFIG: configFile,
      ALP_SKILL_ROOTS: skillRoots,
      ALP_MODE: policy.mode,
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
        ...(bridgeEnabled && this.compact.preCompact ? ["-c", `hooks.PreCompact=${preCompactHooks}`] : []),
        ...(bridgeEnabled && this.compact.postCompact ? ["-c", `hooks.PostCompact=${postCompactHooks}`] : []),
        // Same reason the hooks ride here: `codex-config.toml` is ALP's file, not the one
        // Codex loads. Vai không khai thì ALP tự tính 90% cửa sổ model — trùng đúng mặc định
        // của Codex, nhưng tính ở đây thì Claude cũng nén ở cùng chỗ.
        ...(autoCompactTokens === null
          ? []
          : ["-c", `model_auto_compact_token_limit=${autoCompactTokens}`]),
        // Granted MCP servers. Codex has no in-process subagent, so a `subagents` grant is
        // simply not translated here — §4.6: subagent là tối ưu hoá, không phải điều kiện.
        ...codexMcpOverrides(policy),
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
        ...taskArguments(contextFiles, policy),
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

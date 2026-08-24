const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const { spawnSync } = require("child_process");
const F = require("./herdr-client.cjs");
const P = require("../../../codex-profile.cjs");
const { FileExecutionStore } = require("../../core/execution-store.cjs");
const { result } = require("../../core/types.cjs");
const {
  BackendUnavailable,
  SpawnFailed,
  ExecutionFailed,
  DelegationTimeout,
  CancelFailed,
} = require("../../core/errors.cjs");
const { delegatedPromptPointer } = require("../../core/context-builder.cjs");

class HerdrBackend {
  constructor(options) {
    this.name = "herdr";
    this.repoRoot = options.repoRoot;
    this.runtime = options.runtime || defaultRuntime();
    this.state = options.state || new FileExecutionStore(path.join(options.stateDir, "herdr.json"));
    this.log = options.logger || (() => {});
    this.spawnProcess = options.spawnProcess || spawnSync;
    this.launchBuilder = options.launchBuilder || null;
  }

  healthCheck() {
    let health;
    try { health = this.runtime.available(); }
    catch (error) {
      return {
        ok: false,
        status: "unavailable",
        message: `Herdr health check thất bại: ${error.message}`,
        remediation: "kiểm Herdr CLI/server và chạy lại alp delegation health herdr",
      };
    }
    if (health.ok && health.version && health.version !== F.VERIFIED_VERSION) {
      return {
        ok: true,
        status: "degraded",
        warning: true,
        message: `Herdr ${health.version} khác bản adapter đã kiểm chứng ${F.VERIFIED_VERSION}`,
        remediation: "cài đúng Herdr adapter version hoặc cập nhật/kiểm thử lại HerdrBackend",
      };
    }
    if (health.ok) return { ok: true, status: "healthy", message: `Herdr ${health.version || "available"}` };
    return {
      ok: true,
      status: "degraded",
      message: `${health.reason}; background execution sẽ dùng foreground compatibility path`,
      remediation: "khởi động Herdr server nếu cần background execution; foreground compatibility vẫn dùng được",
    };
  }

  spawn(input) {
    const { executionId, request, target, context } = input;
    const background = request.executionOptions.background;
    const runtimeKind = request.executionOptions.runtime || "codex";
    const launch = this.launchBuilder
      ? this.launchBuilder(target, context, request.executionOptions, runtimeKind)
      : this.buildLaunch(target, context, request.executionOptions, runtimeKind);

    if (background) {
      const fleet = this.runtime.available();
      if (fleet.ok) {
        const parent = request.parentExecutionId ? this.state.get(request.parentExecutionId) : null;
        let spawned;
        try {
          spawned = this.runtime.spawn({
            role: target.role,
            anchor: parent?.runtimeId || null,
            kind: runtimeKind,
            argv: launch.argv,
            cwd: context.workspace,
            message: `${target.role}: ${request.task.slice(0, 80)}`,
            pointer: (file) => delegatedPromptPointer(file, request.parentRole, target.role),
            env: {
              ALP_DELEGATED_ROLE: target.role,
              ALP_DELEGATION_EXECUTION_ID: executionId,
              ALP_DELEGATION_WORKSPACE: context.workspace,
              ...(context.sandbox === "read-only" ? { ALP_READONLY_DIRS: context.workspace } : {}),
            },
          });
        } catch (error) {
          throw new SpawnFailed(`Herdr spawn thất bại: ${error.message}`, { cause: error });
        }
        this.state.put({
          executionId,
          runtimeId: spawned.pane,
          label: spawned.label,
          mode: "background",
          status: "running",
          workspace: context.workspace,
          createdAt: new Date().toISOString(),
        });
        this.log("execution.runtime_spawned", {
          execution_id: executionId,
          backend: this.name,
          backend_execution_id: spawned.pane,
        });
        return result(executionId, "running", { metadata: { mode: "background" } });
      }
    }

    return this.runForeground(executionId, launch, context, request.executionOptions, background);
  }

  status(executionId) {
    const record = this.state.get(executionId);
    if (!record) throw new ExecutionFailed(`Herdr không có execution \`${executionId}\``);
    if (record.mode !== "background")
      return result(executionId, record.status, record.output ? { output: record.output } : {});

    try {
      const current = this.runtime.status(record.runtimeId);
      this.state.update(executionId, { status: current.status });
      return result(executionId, current.status);
    } catch (error) {
      throw new ExecutionFailed(`Không đọc được Herdr execution: ${error.message}`, { cause: error });
    }
  }

  wait(executionId, options = {}) {
    const record = this.state.get(executionId);
    if (!record) throw new ExecutionFailed(`Herdr không có execution \`${executionId}\``);
    if (record.mode !== "background")
      return result(executionId, record.status, record.output ? { output: record.output } : {});

    let waited;
    let output;
    try {
      waited = this.runtime.wait(record.runtimeId, options.timeoutMs || 0);
      if (!waited.timeout) output = this.runtime.output(record.runtimeId);
    } catch (error) {
      throw new ExecutionFailed(`Herdr wait thất bại: ${error.message}`, { cause: error });
    }
    if (waited.timeout) throw new DelegationTimeout(`Herdr execution \`${executionId}\` chưa xong trước timeout`);
    this.state.update(executionId, { status: waited.status, output });
    return result(executionId, waited.status, output ? { output } : {});
  }

  cancel(executionId) {
    const record = this.state.get(executionId);
    if (!record) throw new CancelFailed(`Herdr không có execution \`${executionId}\``);
    if (record.mode === "background") {
      try { this.runtime.cancel(record.runtimeId); }
      catch (error) { throw new CancelFailed(`Herdr cancel thất bại: ${error.message}`, { cause: error }); }
    }
    this.state.update(executionId, { status: "cancelled" });
  }

  cleanup(executionId) {
    const record = this.state.get(executionId);
    const runtimeId = record?.runtimeId || executionId; // legacy `run-role --release <pane>`
    if (!runtimeId || record?.mode !== "background" && record)
      return;
    try { this.runtime.cleanup(runtimeId); }
    catch (error) { throw new ExecutionFailed(`Herdr cleanup thất bại: ${error.message}`, { cause: error }); }
  }

  orphanExecutions() {
    return this.runtime.orphans().map((entry) => {
      let record = this.state.list().find((candidate) => candidate.runtimeId === entry.pane);
      if (!record) {
        // Import a pre-Delegation-API orphan under an opaque ALP ID. Doctor/consumer never
        // needs the pane ID, while HerdrBackend retains the mapping needed for cleanup.
        const executionId = `exec_legacy_${crypto.createHash("sha256").update(entry.pane).digest("hex").slice(0, 16)}`;
        record = this.state.put({
          executionId,
          runtimeId: entry.pane,
          label: entry.agent,
          mode: "background",
          status: entry.status,
          createdAt: new Date().toISOString(),
        });
      }
      return {
        executionId: record.executionId,
        label: entry.agent,
        status: entry.status,
      };
    });
  }

  buildLaunch(target, context, executionOptions, runtimeKind) {
    const profile = P.profilePath(P.codexHome(), target.role);
    const settings = path.join(this.repoRoot, "identity", target.role, ".claude", "settings.json");
    const headless = !executionOptions.interactive;
    let argv;

    if (runtimeKind === "claude") {
      if (!fs.existsSync(settings))
        throw new BackendUnavailable(`Thiếu ${settings} — chạy scripts/compile-acl.sh`);
      argv = [
        "--settings", settings,
        ...(context.sandbox === "read-only" ? ["--permission-mode", "plan"] : []),
        context.prompt,
      ];
    } else {
      if (!fs.existsSync(profile))
        throw new BackendUnavailable(`Thiếu profile ${profile} — chạy scripts/compile-acl.sh`);
      argv = headless
        ? ["exec", "-p", target.role, "--dangerously-bypass-hook-trust", "-C", context.workspace, "--skip-git-repo-check"]
        : ["-p", target.role, "-C", context.workspace];
      if (context.sandbox === "workspace-write") argv.push("-s", "workspace-write");
      argv.push(context.prompt);
    }
    return { runtimeKind, argv, profile, settings };
  }

  runForeground(executionId, launch, context, executionOptions, backgroundFallback) {
    if (launch.runtimeKind === "claude")
      throw new BackendUnavailable("Herdr unavailable: Claude compatibility execution cần Herdr session");
    const bin = process.platform === "win32" ? "codex.cmd" : "codex";
    const interactive = executionOptions.interactive && !backgroundFallback;
    const spawned = this.spawnProcess(bin, launch.argv, {
      cwd: context.workspace,
      env: {
        ...process.env,
        ALP_DELEGATED_ROLE: context.targetRole,
        ALP_DELEGATION_EXECUTION_ID: executionId,
        ALP_DELEGATION_WORKSPACE: context.workspace,
        ...(context.sandbox === "read-only" ? { ALP_READONLY_DIRS: context.workspace } : {}),
      },
      encoding: interactive ? undefined : "utf8",
      stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"],
      timeout: executionOptions.timeoutMs || undefined,
    });
    if (spawned.error)
      throw new SpawnFailed(`Không chạy được Codex CLI: ${spawned.error.message}`, { cause: spawned.error });
    const status = spawned.status === 0 ? "completed" : "failed";
    const output = interactive ? "" : [spawned.stdout, spawned.stderr].filter(Boolean).join("").trim();
    this.state.put({
      executionId,
      mode: "foreground",
      status,
      workspace: context.workspace,
      output,
      createdAt: new Date().toISOString(),
    });
    return result(executionId, status, {
      ...(output ? { output } : {}),
      ...(status === "failed" ? { error: { code: "ExecutionFailed", message: `Codex exit ${spawned.status}` } } : {}),
      ...(backgroundFallback ? { metadata: { fallback: "foreground" } } : {}),
    });
  }
}

function defaultRuntime() {
  return {
    available: F.available,
    spawn: F.spawn,
    status: F.executionStatus,
    wait: F.waitForExecution,
    output: F.readPane,
    cancel: F.cancelPane,
    cleanup: F.releasePane,
    orphans: F.orphanPanes,
  };
}

module.exports = { HerdrBackend, defaultRuntime };

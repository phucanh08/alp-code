const fs = require("fs");
const os = require("os");
const path = require("path");
const { commandRunner } = require("../command-runner.cjs");
const { FileExecutionStore } = require("../../core/execution-store.cjs");
const { result } = require("../../core/types.cjs");
const {
  BackendUnavailable,
  SpawnFailed,
  ExecutionFailed,
  DelegationTimeout,
  CancelFailed,
} = require("../../core/errors.cjs");

class PaseoBackend {
  constructor(options) {
    this.name = "paseo";
    this.config = options.config || {};
    this.runner = options.runner || commandRunner(this.config.cli || "paseo");
    this.state = options.state || new FileExecutionStore(path.join(options.stateDir, "paseo.json"));
    this.log = options.logger || (() => {});
  }

  healthCheck() {
    const rawTools = this.runtimeToolPolicy();
    if (!rawTools.ok) return rawTools;
    // Paseo có thể mất hơn 5 giây cho lần status đầu tiên sau khi daemon/terminal
    // worker vừa được đánh thức. Spawn vẫn hoạt động, vì vậy đừng báo false-negative.
    const call = this.call(["daemon", "status", "--json"], { timeoutMs: 15000 });
    if (!call.ok) return {
      ok: false,
      status: "unavailable",
      message: call.message,
      remediation: "cài/chạy Paseo và kiểm PASEO_CLI/PASEO_HOST",
    };
    const status = call.data || {};
    const reachable = status.connectedDaemon === "reachable" || status.localDaemon === "running";
    return reachable
      ? { ok: true, status: "healthy", message: `Paseo daemon reachable${status.daemonVersion ? ` (${status.daemonVersion})` : ""}` }
      : {
          ok: false,
          status: "unavailable",
          message: `Paseo daemon: ${status.connectedDaemon || status.localDaemon || "unreachable"}`,
          remediation: "khởi động Paseo daemon và kiểm PASEO_HOST",
        };
  }

  spawn(input) {
    const { executionId } = input;
    const request = input.request || {
      requestId: executionId,
      parentRole: "main",
      targetRole: input.launchSpec?.env.ALP_ROLE || "agent",
      parentExecutionId: null,
      executionOptions: { background: true, interactive: false, timeoutMs: null },
    };
    const policy = this.runtimeToolPolicy();
    if (!policy.ok) throw new BackendUnavailable(policy.message);

    if (input.launchSpec) return this.spawnPrepared({ ...input, request });

    const { target, context } = input;

    const runtime = request.executionOptions.runtime || inferRuntime(target);
    const model = runtime === "codex" ? (target.codex_model || target.model) : target.model;
    // Paseo 0.5.x không expose Codex `read-only` như một mode tạo agent. `auto-review`
    // cũng là workspace-write, nên dùng `auto` và để ALP hook enforce delegated workspace
    // + ALP_READONLY_DIRS. Claude có mode read-only tương đương là `plan`.
    const mode = runtime === "codex"
      ? "auto"
      : context.sandbox === "read-only" ? "plan" : "default";
    const prompt = [context.roleContext, "---", context.prompt].filter(Boolean).join("\n\n");
    const parent = request.parentExecutionId ? this.state.get(request.parentExecutionId) : null;
    const args = [
      "run",
      "--background",
      "--json",
      "--cwd", context.workspace,
      "--title", `alp:${target.role}:${executionId.slice(-8)}`,
      "--provider", runtime,
      ...(model ? ["--model", model] : []),
      ...(target.reasoning_effort && runtime === "codex" ? ["--thinking", target.reasoning_effort] : []),
      ...(mode ? ["--mode", mode] : []),
      "--env", `ALP_DELEGATED_ROLE=${target.role}`,
      "--env", `ALP_DELEGATION_EXECUTION_ID=${executionId}`,
      "--env", `ALP_DELEGATION_WORKSPACE=${context.workspace}`,
      ...(context.sandbox === "read-only" ? ["--env", `ALP_READONLY_DIRS=${context.workspace}`] : []),
      "--label", `alp.execution-id=${executionId}`,
      "--label", `alp.request-id=${request.requestId}`,
      "--label", `alp.parent-role=${request.parentRole}`,
      "--label", `alp.target-role=${request.targetRole}`,
      prompt,
    ];
    const call = this.call(args, {
      timeoutMs: request.executionOptions.timeoutMs || 30000,
      // Paseo derives parent-agent ownership from this backend-only ID. Core only knows
      // the generic parentExecutionId and never sees PASEO_AGENT_ID.
      ...(parent?.runtimeId ? { env: { PASEO_AGENT_ID: parent.runtimeId } } : {}),
    });
    if (!call.ok) throw runtimeFailure("Paseo spawn thất bại", call, SpawnFailed);
    const agentId = call.data?.agentId;
    if (!agentId) throw new SpawnFailed("Paseo `run --json` không trả agentId");

    const status = mapStatus(call.data.status);
    this.state.put({
      executionId,
      runtimeId: agentId,
      status,
      cancelled: false,
      workspace: context.workspace,
      createdAt: new Date().toISOString(),
    });
    this.log("execution.runtime_spawned", {
      execution_id: executionId,
      backend: this.name,
      backend_execution_id: agentId,
    });
    return result(executionId, status, { metadata: { mode: "background" } });
  }

  /**
   * `paseo run` is `run [options] <prompt>` and spawns the runtime itself — there is no exec
   * passthrough. The old `"--", launchSpec.command, ...launchSpec.args` therefore handed the
   * parser `claude` as the prompt and dropped everything after it: every delegated agent
   * started with the literal word `claude` as its task, on Paseo's own model and permission
   * mode. Identity still arrived, because `--env` survives and the SessionStart hook reads
   * `ALP_SESSION_CONTEXT`, which is why the failure looked like a hang rather than a crash.
   *
   * `launchSpec.intent` is that launch expressed in the only vocabulary this CLI accepts.
   */
  spawnPrepared({ executionId, request, launchSpec }) {
    const runtime = path.basename(launchSpec.command).toLowerCase().startsWith("claude") ? "claude" : "codex";
    const intent = launchSpec.intent || {};
    if (!intent.prompt) throw new SpawnFailed("launchSpec.intent.prompt trống; Paseo không có task để giao");
    const args = [
      "run", "--background", "--json",
      "--cwd", launchSpec.cwd,
      "--title", `alp:${launchSpec.env.ALP_ROLE || "agent"}:${executionId.slice(-8)}`,
      "--provider", runtime,
      ...(intent.model ? ["--model", intent.model] : []),
      ...(intent.mode ? ["--mode", intent.mode] : []),
      ...Object.entries(launchSpec.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      "--label", `alp.execution-id=${executionId}`,
      "--label", `alp.request-id=${request.requestId}`,
      intent.prompt,
    ];
    const call = this.call(args, { timeoutMs: request.executionOptions.timeoutMs || 30000 });
    if (!call.ok) throw runtimeFailure("Paseo spawn thất bại", call, SpawnFailed);
    const agentId = call.data?.agentId;
    if (!agentId) throw new SpawnFailed("Paseo `run --json` không trả agentId");
    const status = mapStatus(call.data.status);
    this.state.put({
      executionId,
      runtimeId: agentId,
      status,
      cancelled: false,
      workspace: launchSpec.cwd,
      temporaryFiles: launchSpec.temporaryFiles,
      createdAt: new Date().toISOString(),
    });
    return result(executionId, status, { metadata: { mode: "background" } });
  }

  status(executionId) {
    const record = this.record(executionId);
    const call = this.call(["inspect", record.runtimeId, "--json"], { timeoutMs: 10000 });
    if (!call.ok) throw runtimeFailure("Paseo status thất bại", call, ExecutionFailed);
    const raw = call.data?.Status || call.data?.status;
    let status = mapStatus(raw);
    if (record.cancelled && ["completed", "cancelled"].includes(status)) status = "cancelled";
    // Polling `status` is exactly when the caller wants to see progress, and `wait` blocks.
    // Reading the transcript here is what makes the two agree: before this, `wait` fetched
    // the logs and `status` returned nothing, so a caller who polled after waiting watched
    // the output it had already been given disappear.
    const output = this.transcript(record) || record.output || "";
    this.state.update(executionId, { status, ...(output ? { output } : {}) });
    return result(executionId, status, {
      ...(output ? { output } : {}),
      ...(isPermissionBlocked(raw) ? { error: permissionBlockedError(executionId) } : {}),
    });
  }

  wait(executionId, options = {}) {
    const record = this.record(executionId);
    const timeout = options.timeoutMs ? ["--timeout", `${Math.ceil(options.timeoutMs / 1000)}s`] : [];
    const call = this.call(["wait", record.runtimeId, ...timeout, "--json"], {
      timeoutMs: options.timeoutMs ? options.timeoutMs + 5000 : 24 * 60 * 60 * 1000,
    });
    if (!call.ok) throw runtimeFailure("Paseo wait thất bại", call, ExecutionFailed);
    if (call.data?.status === "timeout")
      throw new DelegationTimeout(`Paseo execution \`${executionId}\` chưa xong trước timeout`);

    const raw = call.data?.status;
    let status = mapStatus(raw);
    if (record.cancelled && status === "completed") status = "cancelled";
    const output = this.transcript(record) || call.data?.message || "";
    this.state.update(executionId, { status, output });
    return result(executionId, status, {
      ...(output ? { output } : {}),
      ...(isPermissionBlocked(raw)
        ? { error: permissionBlockedError(executionId) }
        : status === "failed" ? { error: { code: "ExecutionFailed", message: call.data?.message || "Paseo agent failed" } } : {}),
    });
  }

  /** Last 200 lines of the agent transcript, or "" when Paseo cannot produce them. */
  transcript(record) {
    const logs = this.callText(["logs", record.runtimeId, "--tail", "200"], { timeoutMs: 15000 });
    return logs.ok ? logs.output.trim() : "";
  }

  cancel(executionId) {
    const record = this.record(executionId);
    const call = this.call(["stop", record.runtimeId, "--json"], { timeoutMs: 15000 });
    if (!call.ok) throw runtimeFailure("Paseo cancel thất bại", call, CancelFailed);
    this.state.update(executionId, { status: "cancelled", cancelled: true });
  }

  cleanup(executionId) {
    const record = this.record(executionId);
    const call = this.call(["agent", "archive", record.runtimeId, "--force", "--json"], { timeoutMs: 15000 });
    try {
      if (!call.ok && !/already archived/i.test(call.message))
        throw runtimeFailure("Paseo cleanup thất bại", call, ExecutionFailed);
    } finally {
      cleanupTemporaryFiles(record.temporaryFiles);
    }
  }

  orphanExecutions() { return []; }

  record(executionId) {
    const record = this.state.get(executionId);
    if (!record) throw new ExecutionFailed(`Paseo không có execution \`${executionId}\``);
    return record;
  }

  call(args, options = {}) {
    const text = this.callText(args, options);
    if (!text.ok) return text;
    try { return { ok: true, data: JSON.parse(text.output || "{}") }; }
    catch { return { ok: false, message: `Paseo trả JSON không hợp lệ: ${(text.output || "").slice(0, 200)}` }; }
  }

  callText(args, options = {}) {
    const fullArgs = [...args];
    if (this.config.host && !fullArgs.includes("--host")) fullArgs.push("--host", this.config.host);
    let response;
    const runnerOptions = {
      ...options,
      env: {
        ...(options.env || {}),
        ...(this.config.home ? { PASEO_HOME: this.config.home } : {}),
      },
    };
    try { response = this.runner(fullArgs, runnerOptions); }
    catch (error) {
      return { ok: false, message: error.message, errorCode: error.code || null };
    }
    if (response.error)
      return { ok: false, message: response.error.message, errorCode: response.error.code || null };
    if (response.status !== 0)
      return { ok: false, message: (response.stderr || response.stdout || `exit ${response.status}`).trim() };
    return { ok: true, output: response.stdout || "" };
  }

  runtimeToolPolicy() {
    if (!this.config.runtimeToolsDisabled) {
      return {
        ok: false,
        status: "unsafe",
        message: "Paseo backend bị từ chối: raw Paseo tools phải disabled cho delegated roles",
        remediation: "đặt delegation.backends.paseo.runtime_tools_disabled=true sau khi đã tắt raw runtime tools",
      };
    }

    // Paseo mặc định false. Với daemon local, phát hiện config bật true để fail trước create_agent.
    if (!this.config.host || /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/.test(this.config.host)) {
      const home = this.config.home || path.join(os.homedir(), ".paseo");
      const file = path.join(home, "config.json");
      if (fs.existsSync(file)) {
        try {
          const config = JSON.parse(fs.readFileSync(file, "utf8"));
          if (config.daemon?.mcp?.injectIntoAgents === true || config.mcp?.injectIntoAgents === true) {
            return {
              ok: false,
              status: "unsafe",
              message: `${file}: daemon.mcp.injectIntoAgents=true có thể bypass ALP policy; đặt false rồi paseo reload`,
              remediation: "đặt daemon.mcp.injectIntoAgents=false rồi chạy paseo reload",
            };
          }
        } catch (error) {
          return {
            ok: false,
            status: "unavailable",
            message: `Không đọc được ${file}: ${error.message}`,
            remediation: `sửa quyền hoặc JSON của ${file}`,
          };
        }
      }
    }
    return { ok: true };
  }
}

function cleanupTemporaryFiles(files = []) {
  for (const file of files) fs.rmSync(file, { force: true });
}

function inferRuntime(target) {
  return String(target.model || "").startsWith("claude-") ? "claude" : "codex";
}

/**
 * Paseo reports `permission` when the runtime has stopped to ask a human.
 *
 * A delegated execution is spawned `--background` and non-interactive, so there is no one to
 * answer and the agent parks until something kills it — one sat twelve minutes on nine
 * seconds of CPU before being cancelled by hand. Reporting that as `running` made it
 * indistinguishable from work in progress, and `wait` would have blocked on it for its full
 * 24-hour ceiling.
 *
 * It is `failed` rather than a status of its own because the five-value contract in
 * `execution-backend.ts` is what every caller switches on, and because the condition is
 * genuinely terminal: `PolicyEngine` already decided what this role may do, so a prompt
 * means the runtime and the policy disagree. That is a bug to fix in the grant, not a state
 * to sit in.
 */
function isPermissionBlocked(status) {
  return String(status || "").toLowerCase() === "permission";
}

function permissionBlockedError(executionId) {
  return {
    code: "ExecutionFailed",
    message: `Paseo execution \`${executionId}\` dừng ở permission prompt; delegated run chạy background nên không ai trả lời được. `
      + "Kiểm tra tool grant của role trong src/agents/ và deny list trong src/runtime/permission-rules.ts.",
  };
}

function mapStatus(status) {
  const value = String(status || "").toLowerCase();
  if (["initializing", "created", "queued", "starting"].includes(value)) return "queued";
  if (value === "running") return "running";
  if (["idle", "completed", "archived"].includes(value)) return "completed";
  if (["cancelled", "canceled", "stopped", "closed"].includes(value)) return "cancelled";
  if (["error", "failed", "timeout"].includes(value) || isPermissionBlocked(value)) return "failed";
  return "running";
}

function runtimeFailure(prefix, call, Fallback) {
  const message = `${prefix}: ${call.message}`;
  if (call.errorCode === "ETIMEDOUT" || /timed?\s*out/i.test(call.message))
    return new DelegationTimeout(message);
  if (/daemon|connect|ECONN|ENOENT|not found|unreachable|socket/i.test(call.message))
    return new BackendUnavailable(message);
  return new Fallback(message);
}

module.exports = { PaseoBackend, inferRuntime, isPermissionBlocked, mapStatus, runtimeFailure };

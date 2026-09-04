#!/usr/bin/env node
"use strict";

// CB-0 gate probe: does a native compact hook actually fire when ALP launches a runtime the
// way ALP launches runtimes — inherited TTY, real interactive session, no SDK?
//
// The payload *schemas* are already settled and pinned in EXPECTED below; they were read out
// of the installed binaries on 2026-09-03 (Claude Code 2.1.259, Codex CLI 0.153.0) and the
// evidence lives in plans/260903-2040-cross-runtime-compact-bridge/plan.md §Runtime capability.
// Static analysis cannot answer two things, and those two are the whole reason this script
// exists:
//
//   1. Whether the runtime dispatches these hooks at all in inherited-TTY mode.
//   2. Whether the hook command string survives Windows argv splitting — a live question for
//      Codex specifically, which splits the command itself and chokes on a quoted first token
//      (see the `hookCommand()` comment in src/runtime/codex-adapter.ts).
//
// One file plays two roles. Without `--record` it is the driver: it writes an isolated
// settings/config pointing every hook back at itself, launches the installed CLI, then reports.
// With `--record <EventName>` it is the hook: read stdin, append one line, get out.
//
// Recording is metadata-only by default. Field names and value *types* are what the gate needs;
// the values are a live conversation and are not this script's business. `--reveal-all` exists
// for a developer debugging their own probe run, and says so in the output.
//
// SessionStart is the exception that earns its own output: the recorder injects a unique marker
// via `additionalContext`. After `/compact`, asking the model to repeat the marker is a direct
// end-to-end test of the only reinjection path both runtimes support.

const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const EVENTS = ["SessionStart", "PreCompact", "PostCompact", "Stop", "SessionEnd"];

// Pinned from the binaries' own schemas. `optional` fields are absent in valid payloads, so
// only `required` drives the missing-field check; anything outside both sets is drift.
const EXPECTED = {
  claude: {
    version: "2.1.259",
    // The binary's Zod schema is a floor, not a ceiling: a live run on 2026-09-03 showed
    // SessionStart carrying usage/telemetry fields the schema never mentions, and carrying
    // different ones per `source` (`context_tokens` on resume, `model` on compact).
    SessionStart: {
      required: ["session_id", "transcript_path", "cwd", "hook_event_name", "source"],
      optional: [
        "prompt_id", "permission_mode", "agent_id", "agent_type", "model",
        "seconds_since_last_response", "context_tokens", "prompt_cache_likely_expired",
        "estimated_cache_write_usd",
      ],
    },
    PreCompact: {
      required: ["session_id", "transcript_path", "cwd", "hook_event_name", "trigger", "custom_instructions"],
      optional: ["prompt_id", "permission_mode", "agent_id", "agent_type"],
    },
    PostCompact: {
      required: ["session_id", "transcript_path", "cwd", "hook_event_name", "trigger", "compact_summary"],
      optional: ["prompt_id", "permission_mode", "agent_id", "agent_type"],
    },
  },
  codex: {
    version: "0.153.0",
    SessionStart: {
      required: ["cwd", "hook_event_name", "model", "permission_mode", "session_id", "source", "transcript_path"],
      optional: [],
    },
    PreCompact: {
      required: ["cwd", "hook_event_name", "model", "session_id", "transcript_path", "trigger", "turn_id"],
      optional: ["agent_id", "agent_type"],
    },
    PostCompact: {
      required: ["cwd", "hook_event_name", "model", "session_id", "transcript_path", "trigger", "turn_id"],
      optional: ["agent_id", "agent_type"],
    },
  },
};

// Enum-valued and version-valued fields. These carry no conversation content, they are exactly
// what the gate table asks for, so they are recorded verbatim without `--reveal-all`.
const SAFE_FIELDS = new Set(["hook_event_name", "source", "trigger", "reason", "permission_mode", "model"]);

const MAX_STDIN = 1024 * 1024;

function fail(message) {
  process.stderr.write(`probe-compact-hooks: ${message}\n`);
  process.exit(2);
}

function flag(name, argv) {
  const at = argv.indexOf(name);
  return at === -1 ? null : (argv[at + 1] ?? null);
}

// ---------------------------------------------------------------- recorder role

/**
 * Shape of one field, plus — for strings — a short digest.
 *
 * The digest is what makes correlation answerable without recording the values. Whether
 * `PreCompact.prompt_id` equals `PostCompact.prompt_id` decides whether the reducer can pair a
 * `started` with its `completed` at all, and comparing two digests answers that while leaving
 * the identifiers themselves off disk.
 */
function describe(value) {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (typeof value === "string") {
    return {
      type: "string",
      length: value.length,
      digest: crypto.createHash("sha256").update(value).digest("hex").slice(0, 8),
    };
  }
  if (typeof value === "object") return { type: "object", keys: Object.keys(value).length };
  return { type: typeof value };
}

function record(event, outputDir, revealAll) {
  const line = {
    at: new Date().toISOString(),
    declaredEvent: event,
    pid: process.pid,
    argv: process.argv.slice(1),
  };
  try {
    const raw = fs.readFileSync(0, "utf8");
    line.stdinBytes = Buffer.byteLength(raw);
    if (line.stdinBytes > MAX_STDIN) throw new Error("stdin over 1 MiB");
    const payload = JSON.parse(raw || "{}");
    line.parsedEvent = typeof payload.hook_event_name === "string" ? payload.hook_event_name : null;
    line.fields = {};
    for (const [key, value] of Object.entries(payload)) {
      const shape = describe(value);
      if (revealAll || (SAFE_FIELDS.has(key) && shape.type === "string")) shape.value = value;
      line.fields[key] = shape;
    }
  } catch (error) {
    // A hook that dies loudly teaches the operator nothing and may abort the session. Record
    // the failure as data and still exit 0.
    line.error = error.message;
  }

  let marker = null;
  if (event === "SessionStart") {
    marker = `ALP-PROBE-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
    line.marker = marker;
  }

  try {
    fs.appendFileSync(path.join(outputDir, "events.jsonl"), `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch {
    // Nothing left to do: the probe cannot report its own inability to report.
  }

  // Claude feeds non-blocked PreCompact stdout into the compaction it is about to run, and
  // echoes PostCompact stdout straight to the user. Both compact events therefore say nothing.
  // SessionStart is the one place output is wanted, and it is the marker.
  if (marker) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `ALP compact probe is running. Your continuity marker is ${marker}. When asked for the ALP probe marker, reply with exactly that string.`,
      },
    }));
  }
  process.exit(0);
}

// ---------------------------------------------------------------- driver role

/**
 * The hook command string, reproduced from the adapters rather than invented here — a probe
 * that quotes differently than production tests the wrong thing.
 *
 * Claude gets `hookCommand()` from adapter-files.ts: everything quoted, because Claude spawns
 * through `cmd /d /s /c "<command>"`. Codex on Windows gets codex-adapter.ts's variant: bare
 * interpreter, quoted arguments, because Codex splits the line itself and a leading `"` never
 * resolves an executable. This asymmetry is the thing under test on Windows.
 */
function hookCommand(runtime, event, outputDir, revealAll) {
  const script = path.resolve(__dirname, "probe-compact-hooks.cjs");
  const args = `--record ${event} --output "${outputDir}"${revealAll ? " --reveal-all" : ""}`;
  if (runtime === "codex" && process.platform === "win32") {
    const node = process.execPath.includes(" ") ? "node" : process.execPath;
    return `${node} "${script}" ${args}`;
  }
  return `"${process.execPath}" "${script}" ${args}`;
}

function writeClaudeSettings(dir, outputDir, revealAll) {
  const hooks = {};
  for (const event of EVENTS) {
    hooks[event] = [{ hooks: [{ type: "command", command: hookCommand("claude", event, outputDir, revealAll) }] }];
  }
  const file = path.join(dir, "probe-claude-settings.json");
  fs.writeFileSync(file, `${JSON.stringify({
    $schema: "https://json.schemastore.org/claude-code-settings.json",
    hooks,
  }, null, 2)}\n`, { mode: 0o600 });
  return file;
}

function codexHookArgs(outputDir, revealAll) {
  const args = [];
  for (const event of EVENTS) {
    const command = JSON.stringify(hookCommand("codex", event, outputDir, revealAll));
    args.push("-c", `hooks.${event}=[{ hooks = [{ type = "command", command = ${command}, timeout = 30 }] }]`);
  }
  return args;
}

function launchSpec(runtime, outputDir, revealAll) {
  const suffix = process.platform === "win32" ? ".cmd" : "";
  return {
    command: `${runtime}${suffix}`,
    args: runtime === "claude"
      ? ["--settings", writeClaudeSettings(outputDir, outputDir, revealAll)]
      : ["--dangerously-bypass-hook-trust", "--enable", "hooks", ...codexHookArgs(outputDir, revealAll)],
  };
}

/**
 * Everything the probe would run, printed and not run. This is the first thing to reach for on
 * Windows: if a hook does not fire there, the argv-splitting of the command string is the prime
 * suspect, and it is far easier to read it here than out of a failed session.
 */
function dryRun(runtime, outputDir, revealAll) {
  const spec = launchSpec(runtime, outputDir, revealAll);
  process.stdout.write([
    "",
    `platform: ${process.platform}   node: ${process.execPath}`,
    `runtime:  ${runtime}`,
    "",
    "hook command per event (exactly what the CLI receives and must split):",
    ...EVENTS.map((event) => `  ${event.padEnd(13)} ${hookCommand(runtime, event, outputDir, revealAll)}`),
    "",
    "launch:",
    `  ${spec.command} ${spec.args.map((arg) => (arg.includes(" ") ? `'${arg}'` : arg)).join(" ")}`,
    "",
    ...(runtime === "claude" ? ["settings written to:", `  ${spec.args[1]}`, ""] : [
      "note: `-c` is a clap *global* arg. Anything you pass after `--` that repeats `-c` must stay",
      "      at the same level as the `-c hooks.*` above — putting it after the `exec` subcommand",
      "      makes clap replace the parent's values, dropping every hook with no error at all.",
      "",
    ]),
  ].join("\n"));
  return 0;
}

function launch(runtime, outputDir, revealAll, extraArgs) {
  const { command, args } = launchSpec(runtime, outputDir, revealAll);

  process.stdout.write([
    "",
    `Launching ${command} with probe hooks on ${EVENTS.join(", ")}.`,
    "",
    "In the session, in this order:",
    "  1. Send any prompt and let it answer          → proves the session is live",
    "  2. Ask: \"what is the ALP probe marker?\"       → proves SessionStart injected context",
    "  3. Run /compact                               → fires PreCompact then PostCompact",
    "  4. Ask for the ALP probe marker again         → proves SessionStart(source=compact) reinjects",
    "  5. Exit the CLI",
    "",
    `Recording to ${path.join(outputDir, "events.jsonl")}`,
    "",
  ].join("\n"));

  // The gate asks specifically about inherited-TTY dispatch, so the report must not claim it
  // when the run was headless (`claude -p`, `codex exec`). Record what actually happened.
  const mode = process.stdout.isTTY ? "inherited-TTY" : "headless (no TTY)";
  fs.writeFileSync(path.join(outputDir, "run.json"), `${JSON.stringify({
    at: new Date().toISOString(),
    platform: process.platform,
    runtime,
    mode,
    command,
    extraArgs,
  }, null, 2)}\n`, { mode: 0o600 });

  const result = spawnSync(command, [...args, ...extraArgs], { stdio: "inherit", cwd: process.cwd() });
  if (result.error) fail(`could not launch ${command}: ${result.error.message}`);
  return result.status ?? 0;
}

// ---------------------------------------------------------------- report

function readEvents(outputDir) {
  const file = path.join(outputDir, "events.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function safeValue(entry, field) {
  const shape = entry.fields?.[field];
  return shape && "value" in shape ? shape.value : null;
}

function report(runtime, outputDir) {
  const events = readEvents(outputDir);
  const expected = EXPECTED[runtime];
  const out = [];
  const line = (text = "") => out.push(text);

  line("");
  line(`# CB-0 probe report — ${runtime} (pinned schema: ${expected.version})`);
  line("");
  if (!events.length) {
    line("NO EVENTS RECORDED.");
    line("");
    line("Either no hook fired, or the hook command failed to launch. Check the CLI's own hook");
    line("diagnostics — Codex prints `hook: <Event> Failed` and Claude reports hook errors in");
    line("/doctor. On Windows this is the expected shape of an argv-splitting failure.");
    process.stdout.write(`${out.join("\n")}\n`);
    return 1;
  }

  line(`${events.length} hook invocation(s) recorded.`);
  line("");
  line("| # | declared | parsed | trigger/source | fields | stdin bytes |");
  line("|---|---|---|---|---:|---:|");
  events.forEach((entry, index) => {
    const detail = safeValue(entry, "trigger") ?? safeValue(entry, "source") ?? safeValue(entry, "reason") ?? "—";
    const fields = entry.fields ? Object.keys(entry.fields).length : 0;
    line(`| ${index + 1} | ${entry.declaredEvent} | ${entry.parsedEvent ?? `ERROR: ${entry.error ?? "unparsed"}`} | ${detail} | ${fields} | ${entry.stdinBytes ?? 0} |`);
  });
  line("");

  // Gate answers. These are the cells the plan's CB-0 table still carries as unmeasured.
  const seen = (event) => events.filter((entry) => entry.parsedEvent === event);
  const compactStarts = seen("SessionStart").filter((entry) => safeValue(entry, "source") === "compact");
  let run = null;
  try { run = JSON.parse(fs.readFileSync(path.join(outputDir, "run.json"), "utf8")); } catch { /* --record-only run */ }
  const mode = run ? run.mode : "unknown (no run.json)";

  line("## Gate");
  line("");
  line(`- launch mode: **${mode}**${run ? ` on ${run.platform}` : ""}`);
  line(`- PreCompact fired: ${seen("PreCompact").length ? "YES" : "NO"}`);
  line(`- PostCompact fired: ${seen("PostCompact").length ? "YES" : "NO"}`);
  line(`- SessionStart re-fired with source=compact: ${compactStarts.length ? "YES" : "NO"}`);
  line(`- event order: ${events.map((entry) => entry.parsedEvent ?? "?").join(" → ")}`);
  line(`- Markers injected: ${seen("SessionStart").map((entry) => entry.marker).filter(Boolean).join(", ") || "none"}`);
  line("");
  line("Whether the model could still quote the marker after /compact is the one answer this");
  line("script cannot read for you — record it from the transcript by hand.");
  line("");

  // Identifier correlation. A reducer can only pair `started` with `completed` if some id is
  // stable across the two, so print the digests side by side and let the reader see it.
  const idFields = ["session_id", "prompt_id", "turn_id", "transcript_path"];
  const present = idFields.filter((field) => events.some((entry) => entry.fields?.[field]));
  if (present.length) {
    line("## Identifier correlation (sha256 prefix; equal digest = equal value)");
    line("");
    line(`| event | ${present.join(" | ")} |`);
    line(`|---|${present.map(() => "---").join("|")}|`);
    for (const entry of events) {
      const cells = present.map((field) => entry.fields?.[field]?.digest ?? "—");
      line(`| ${entry.parsedEvent ?? "?"} | ${cells.join(" | ")} |`);
    }
    line("");
  }

  // Schema drift. Silence here means the pinned contract still holds for this version.
  const drift = [];
  for (const entry of events) {
    const contract = expected[entry.parsedEvent];
    if (!contract || !entry.fields) continue;
    const actual = Object.keys(entry.fields);
    const known = new Set([...contract.required, ...contract.optional]);
    const missing = contract.required.filter((field) => !actual.includes(field));
    const unexpected = actual.filter((field) => !known.has(field));
    if (missing.length || unexpected.length) drift.push({ event: entry.parsedEvent, missing, unexpected });
  }
  line("## Schema drift vs pinned contract");
  line("");
  if (!drift.length) {
    line("None. Payloads match the schemas read from the binary; the plan's gate table stands.");
  } else {
    line("DRIFT DETECTED — the installed CLI no longer matches the pinned schema. Update both");
    line("EXPECTED in this file and the gate table in plan.md before continuing to CB-3.");
    line("");
    for (const item of drift) {
      if (item.missing.length) line(`- ${item.event}: missing required ${item.missing.join(", ")}`);
      if (item.unexpected.length) line(`- ${item.event}: unexpected ${item.unexpected.join(", ")}`);
    }
  }
  line("");

  const file = path.join(outputDir, "report.md");
  fs.writeFileSync(file, `${out.join("\n")}\n`, { mode: 0o600 });
  process.stdout.write(`${out.join("\n")}\n\nWritten to ${file}\n`);
  return drift.length ? 1 : 0;
}

// ---------------------------------------------------------------- entry

function main() {
  const argv = process.argv.slice(2);
  const revealAll = argv.includes("--reveal-all");
  const outputDir = flag("--output", argv);

  const recordEvent = flag("--record", argv);
  if (recordEvent) {
    if (!outputDir) process.exit(0);
    return record(recordEvent, outputDir, revealAll);
  }

  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write([
      "Usage: node scripts/probe-compact-hooks.cjs --runtime <claude|codex> --output <dir> [options]",
      "",
      "  --runtime <claude|codex>  Which installed CLI to probe. Required.",
      "  --output <dir>            Where to record. Required, and never defaulted — this",
      "                            directory receives a live conversation's hook metadata.",
      "  --report-only             Re-print the report from an earlier run; launch nothing.",
      "  --dry-run                 Print the hook command strings and launch line, run nothing.",
      "                            First stop when a hook does not fire on Windows.",
      "  --reveal-all              Record every field value, not just the enum fields.",
      "                            Off by default: payloads reference a real session.",
      "  --                        Everything after is passed through to the CLI.",
      "",
      "Refuses to run under CI unless ALP_LIVE_RUNTIME_TESTS=1: it needs a human at a TTY.",
      "",
    ].join("\n"));
    return 0;
  }

  const runtime = flag("--runtime", argv);
  if (runtime !== "claude" && runtime !== "codex") fail("--runtime must be `claude` or `codex`");
  if (!outputDir) fail("--output <dir> is required (no default: this records live session metadata)");

  const resolved = path.resolve(outputDir);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });

  if (argv.includes("--report-only")) return report(runtime, resolved);
  if (argv.includes("--dry-run")) return dryRun(runtime, resolved, revealAll);

  if (process.env.CI && process.env.ALP_LIVE_RUNTIME_TESTS !== "1") {
    fail("refusing to run under CI: this probe needs an interactive TTY. Set ALP_LIVE_RUNTIME_TESTS=1 to override.");
  }
  if (revealAll) process.stdout.write("\n⚠️  --reveal-all: full field values will be written to disk.\n");

  const passthroughAt = argv.indexOf("--");
  const extraArgs = passthroughAt === -1 ? [] : argv.slice(passthroughAt + 1);
  launch(runtime, resolved, revealAll, extraArgs);
  return report(runtime, resolved);
}

process.exit(main());

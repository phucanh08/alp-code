#!/usr/bin/env node
"use strict";

// Pre/PostCompact hook: appends exactly one line to context/compact-events.jsonl.
//
// Zero dependency, on purpose (plan §1): this hook writes a raw-but-filtered envelope, never
// normalizes it, never reads the journal back, and never touches checkpoint.json or
// continuity.md. Normalizing into a CompactEventV1 happens later, in TypeScript with Zod, when
// `alp context status|validate` replays the journal — so this file cannot regress a compiled
// dependency graph and stays a single `appendFileSync` at its core.
//
// Fail-open by design (invariant 7): every branch below either appends one line or does
// nothing, and nothing here may throw past `main()`. A missing execution ID means this launch
// did not go through ALP at all — that is not an error, just silence.
//
// argv: `compact-record.cjs <pre|post> <claude|codex>`. Both are supplied by the adapter that
// registers the hook, not read from the payload — trusting the payload's own idea of its phase
// or runtime would let it pick which bucket it lands in.

const fs = require("node:fs");

const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 16 * 1024;
const MAX_VALUE_LENGTH = 256;
const EXECUTION_ID_PATTERN = /^exec_[a-zA-Z0-9_-]+$/;

// Mirrors `SOURCE_WHITELIST` in src/context/compact-payload.ts. Kept as a second copy rather
// than a shared import: this file has no dependency graph to begin with, and the two lists are
// pinned against the same measured schema (§Runtime capability), so a drift between them would
// show up immediately as a normalizer that drops a field the hook thought it kept.
const SOURCE_WHITELIST = {
  claude: ["session_id", "trigger", "model", "prompt_id", "agent_id", "agent_type"],
  codex: ["session_id", "trigger", "model", "turn_id", "agent_id", "agent_type"],
};

function filterSource(runtime, payload) {
  const whitelist = SOURCE_WHITELIST[runtime] || [];
  const source = {};
  if (payload !== null && typeof payload === "object") {
    for (const key of whitelist) {
      const value = payload[key];
      if (typeof value === "string") source[key] = value.slice(0, MAX_VALUE_LENGTH);
      else if (typeof value === "number" || typeof value === "boolean") source[key] = String(value);
    }
  }
  return source;
}

/** Reads stdin fully; returns `null` rather than the buffer when it exceeds the 1 MiB cap. */
function readStdin() {
  let buffer;
  try {
    buffer = fs.readFileSync(0);
  } catch {
    return Buffer.alloc(0);
  }
  return buffer.length > MAX_STDIN_BYTES ? null : buffer;
}

function main() {
  const phase = process.argv[2];
  const runtime = process.argv[3];
  if (phase !== "pre" && phase !== "post") return;
  if (runtime !== "claude" && runtime !== "codex") return;

  // A native launch that never went through `alp` sets none of this — silence, not an error.
  const executionId = process.env.ALP_DELEGATION_EXECUTION_ID || "";
  const policyHash = process.env.ALP_POLICY_HASH || "";
  const journal = process.env.ALP_COMPACT_EVENTS || "";
  if (!EXECUTION_ID_PATTERN.test(executionId) || policyHash.length === 0 || journal.length === 0) return;

  const buffer = readStdin();
  let source;
  if (buffer === null) {
    source = { parseError: "stdin exceeded 1 MiB" };
  } else {
    try {
      source = filterSource(runtime, JSON.parse(buffer.length === 0 ? "{}" : buffer.toString("utf8")));
    } catch (error) {
      // Name the failure only — never the content that failed to parse.
      source = { parseError: String(error && error.message || "invalid JSON").slice(0, MAX_VALUE_LENGTH) };
    }
  }

  const envelope = {
    v: 1,
    at: new Date().toISOString(),
    executionId,
    policyHash,
    runtime,
    phase,
    source,
  };
  const line = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) return;

  try {
    fs.appendFileSync(journal, line, { encoding: "utf8", mode: 0o600, flag: "a" });
  } catch {
    // A read-only or missing journal must never fail the compaction it is recording.
  }
}

try {
  main();
} catch {
  // Nothing above should throw, but this hook's contract is exit 0 no matter what.
}
process.exit(0);

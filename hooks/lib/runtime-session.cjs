"use strict";

// Ghi con trỏ `{session_id, transcript_path}` của phiên native vào `ALP_RUNTIME_SESSION`, để
// history bridge (P4) đọc lại transcript sau khi process này đã thoát. Bản .cjs của
// `src/hooks/runtime-session.ts` — cùng luật: hai field string, cắt trần, ghi atomic,
// fail-open. Thiếu field → không ghi (Codex `Stop` có thể không mang path).

const fs = require("node:fs");
const path = require("node:path");

const MAX_VALUE_LENGTH = 1024;

function stringField(payload, key) {
  const value = payload && typeof payload === "object" ? payload[key] : undefined;
  return typeof value === "string" && value.length > 0 ? value.slice(0, MAX_VALUE_LENGTH) : null;
}

function recordRuntimeSession(payload) {
  const file = process.env.ALP_RUNTIME_SESSION;
  if (!file) return false;
  try {
    const sessionId = stringField(payload, "session_id");
    const transcriptPath = stringField(payload, "transcript_path");
    if (sessionId === null || transcriptPath === null) return false;
    const record = { v: 1, sessionId, transcriptPath, recordedAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
    return true;
  } catch {
    return false;
  }
}

/** stdin của hook là JSON payload; đọc hỏng → `{}` — không bao giờ ném. */
function readHookPayload() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

module.exports = { recordRuntimeSession, readHookPayload };

# Spike — transcript runtime đọc lại được gì? (P4 history bridge)

**Ngày:** 2026-09-11. **CLI:** Claude Code `2.1.268`, Codex CLI `0.154.0`.
**Cách probe:** đọc fixture thật trên máy dev (phiên Claude của chính plan này ở
`~/.claude/projects/<slug>/<session>.jsonl`; các rollout Codex ở `~/.codex/sessions/2026/09/11/`),
đối chiếu payload hook đã pin trong `scripts/probe-compact-hooks.cjs` (2026-09-03, Claude 2.1.259 /
Codex 0.153.0). Không launch runtime thật lần nữa: phần hook-payload đã có bằng chứng live, phần format
file mới là câu hỏi P4 hỏi.

## Bảng probe

| Câu hỏi | Claude 2.1.268 | Codex 0.154.0 |
|---|---|---|
| Transcript đọc được ở đâu? | `transcript_path` có trong **mọi** payload hook (SessionStart/PreCompact/PostCompact pin sẵn; Stop có `transcript_path` + `last_assistant_message`, `hook session-end` đang đọc field sau). File: `$CLAUDE_CONFIG_DIR/projects/<cwd-slug>/<session_id>.jsonl`. | `transcript_path` có trong SessionStart/PreCompact/PostCompact (pin 0.153.0). File: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<session_id>.jsonl`. |
| Có version trong file? | Có: **mỗi dòng** `user`/`assistant` mang `version: "2.1.268"`. | Có: dòng đầu `session_meta.payload.cli_version: "0.154.0"`. |
| User/assistant/tool tách được, ID ổn định? | Có. Dòng `type: user\|assistant`, `uuid` + `parentUuid` (chuỗi liên kết), `timestamp`, `sessionId`. `message.content` là string (prompt) hoặc block `text` / `thinking` / `tool_use{id,name,input}` / `tool_result{tool_use_id,content,is_error}`. `isMeta: true` = context ALP/CLI tiêm, `isSidechain: true` = subagent. Dòng khác (`mode`, `bridge-session`, `attachment`, `queue-operation`, `last-prompt`, `ai-title`, `atis-latch`, `file-history-snapshot`, `system`) là housekeeping — bỏ. | Có. Mỗi dòng `{timestamp, ordinal, type, payload}`; `ordinal` đơn điệu tăng. `response_item` → `message{id,role:user\|assistant\|developer,content[{type:input_text\|output_text,text}]}`, `function_call{id,call_id,name,arguments}` / `function_call_output{call_id,output}`, `custom_tool_call{call_id,name,input}` / `custom_tool_call_output{call_id,output[]}`, `reasoning` (**encrypted** — bỏ), `agent_message` (sub-agent). Mọi `response_item` mang `internal_chat_message_metadata_passthrough.turn_id`; `event_msg.task_started/task_complete{turn_id}` đóng khung turn. `developer` role = context tiêm — bỏ. |
| Hook nào bắn ở terminal để collect delta? | `Stop` (ALP đã đăng ký `session-end`) và `SessionEnd`. Payload Stop có `session_id` + `transcript_path`. | `Stop` (ALP đã đăng ký `session-end`). |
| Format pin được theo CLI version như `compact` capability? | Pin theo `version` trên dòng: parser P4 pin `2.1.x`. Version khác → vẫn parse best-effort nhưng completeness hạ `partial`. | Pin theo `session_meta.cli_version`: parser pin `0.154.x`. Khác → `partial`. |
| Compaction native có dấu trong transcript? | **Không** thấy `compact_boundary` / `isCompactSummary` trong 0/N file local. ALP đã có journal riêng qua PreCompact/PostCompact (P-compact) — bridge không cần đọc từ transcript. | Có: dòng `type: "compacted"` với `replacement_history[]`. Bridge ghi nhận như boundary, **không** copy `replacement_history` (nó là context đã nén, không phải message mới). |

## Kết luận

- **Không runtime nào `final-only`.** Cả hai đọc lại được message + tool call theo thứ tự với ID
  ổn định → bridge mặc định `complete` khi version khớp pin, `partial` khi lệch version hoặc gặp dòng
  không parse được, `final-only` khi không đọc được transcript (path thiếu/ngoài state dir/ENOENT) —
  lúc đó chỉ còn boundary + `last_assistant_message` đã có sẵn trong `output`.
- **Cả hai format là private.** Đúng như plan: parser nằm ở `src/runtime/{claude,codex}-history-bridge.ts`
  với version pin; core (`src/thread/history-*.ts`) chỉ biết `ThreadEntry`. Dòng lạ → skip + đếm vào
  `skipped`, không throw, không parse sai im lặng.
- **Đường lấy `transcript_path`:** hook `session-boot` (SessionStart) và `session-end` (Stop) ghi
  `{v, sessionId, transcriptPath, recordedAt}` vào `ALP_RUNTIME_SESSION` (`context/runtime-session.json`,
  0600). SessionStart ghi trước để process chết giữa chừng vẫn còn path; Stop ghi đè (cùng giá trị).
  Bridge canonicalize (`realpath`) và **từ chối** path nằm ngoài state dir của runtime
  (`CLAUDE_CONFIG_DIR ?? ~/.claude`, `CODEX_HOME ?? ~/.codex`) → `final-only`.
- **Cursor:** Claude = `{ lineOffset, lastUuid }`; Codex = `{ lineOffset, lastOrdinal }`. Cùng file +
  cursor + digest text → collect hai lần không append hai lần.
- **Không copy:** `thinking`/`reasoning`, `tool_result.content`/`*_output` raw (chỉ summary ≤ 512 byte
  đã redact + `isError`), `isMeta`/`developer` context, `attachment`, encrypted payload.

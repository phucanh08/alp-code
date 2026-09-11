# P4 — History bridge + compaction provenance

**Mục tiêu:** Thread có normalized history (message/tool/change refs) với completeness khai báo trung thực — mirror từ transcript runtime-owned, không xây model gateway.
**Phụ thuộc:** P3. **Có spike:** probe transcript Claude/Codex phải xong trước khi viết bridge runtime-specific; kết quả spike có thể hạ cả phase xuống `final-only`.

---

## Bối cảnh

- Hook đã có: `SessionStart`/`Stop`/`PreCompact`/`PostCompact` ở `src/runtime/claude-adapter.ts:105-115`, `codex-adapter.ts:162-166`; payload đã whitelist `session_id` (`src/cli/hook-entry.ts:14-15`).
- Compact journal + probe script (`scripts/probe-compact-hooks.cjs`) là mẫu cho "probe trước, pin capability sau".
- ALP không sở hữu transcript (stdio inherit). Đây là **mirror**, và mirror phải nói nó thiếu gì.

## Spike — probe transcript (làm trước, ghi kết quả)

Cho mỗi runtime, xác minh bằng fixture thật, ghi vào `plans/260911-1811-thread-unit-of-work/research/runtime-history-bridge.md`:

| Câu hỏi | Claude | Codex |
|---|---|---|
| Transcript đọc được ở đâu (path/API), có version? | `transcript_path` trong hook payload? | session dir? |
| User/assistant/tool turn có tách được, có ID ổn định? | | |
| Hook nào bắn ở terminal để collect delta? | `Stop`/`SessionEnd` | `Stop` |
| Format có pin được theo CLI version như `compact` capability không? | | |

Kết quả quyết định `HistoryCompleteness` mặc định của bridge đó. **Không hard-code format private không stable vào core.** Default toàn cục: `final-only`; `complete` chỉ khi probe trả lời được cả bốn ô.

## Thiết kế

### Bridge tách khỏi `RuntimeAdapter`

```ts
interface RuntimeHistoryBridge {
  readonly runtime: RuntimeId
  probe(): Promise<{ completeness: HistoryCompleteness; pinnedVersion: string | null }>
  collectDelta(input: { execution: PreparedExecution; cursor: RuntimeHistoryCursor | null })
    : Promise<{ entries: readonly ThreadEntry[]; cursor: RuntimeHistoryCursor; completeness: HistoryCompleteness }>
}
type HistoryCompleteness = "complete" | "partial" | "final-only" | "unsupported"
```

Registry riêng keyed by runtime. **Vì sao không nhét vào adapter:** adapter trả lời "launch thế nào"; bridge trả lời "đọc lại được gì" — runtime launch được vẫn có thể `unsupported` ở bridge.

### Entries + refs

```ts
type ThreadEntry = ThreadUserMessage | ThreadAssistantMessage | ThreadToolCallRef | ThreadChangeRef | ThreadExecutionBoundary
interface ThreadMessageRef { id; sequence; executionId; kind; artifact; digest; createdAt }
```

| Kind | Lưu | Không lưu |
|---|---|---|
| user/assistant | canonical text sau redaction | env dump |
| tool | tên, executionId, thứ tự, summary đã redact, ref artifact nếu execution đã có | raw args/output |
| change | workspace, paths, commit SHA (nếu có), diff artifact ref | full diff trong `thread.json` |
| boundary | executionId, sequence, outcome, `historyCompleteness` | |

Payload immutable ở `messages/<seq>.json`; `thread.json` chỉ refs.

### Thời điểm collect

Chỉ khi `settleRoot` (P1 bước 7) và `alp thread sync <id>` (explicit). Không poll. Live steer ngoài phạm vi.

### Idempotent

`cursor` + native event ID/digest → cùng delta collect hai lần không append hai lần. Test bắt buộc.

### Compaction record

```ts
interface ThreadCompactionRecordV1 {
  id; threadId
  fromMessageSequence; toMessageSequence
  inputDigest; outputContextRevision; outputContextDigest
  strategy: "deterministic"; droppedCount; createdAt
}
```

P2 đã ghi bản rút gọn; P4 thay bằng record đầy đủ. Thread compaction ≠ runtime native compaction (journal riêng, không trộn).

### Security/privacy

1. Redact token/key-like (reuse pattern redaction sẵn có nếu có; nếu không, regex set nhỏ + fixture) **trước** khi ghi payload.
2. Native transcript path canonicalize; không follow symlink ra ngoài runtime state dir.
3. Artifact ref không escape `threads/<id>/` (invariant 9 P0).
4. Payload digest sai → mark `unavailable`, không đưa vào context tương lai.
5. Output lớn/binary → ref, không copy.

## Việc phải làm

1. Spike probe hai runtime → `research/runtime-history-bridge.md`. **Dừng ở đây, báo principal** nếu cả hai `final-only`: phần 3–6 co lại còn boundary + change refs.
2. Test fail trước: order deterministic; idempotent; unsupported runtime không crash `continue`; redaction fixtures (token, private key, `Authorization:` header); completeness in ra ở `show`.
3. `src/thread/history-types.ts`, `history-bridge.ts` (interface + registry), `history-redact.ts`.
4. `src/runtime/claude-history-bridge.ts`, `codex-history-bridge.ts` — theo spike.
5. `src/thread/thread-service.ts`: `collectHistory(executionId)` gọi trong `settleRoot`; `sync`.
6. `src/cli/commands/thread.ts`: `sync`; `show` in `History: complete|partial|final-only|unsupported`.

## File đụng tới

| File | Hành động | Đổi gì |
|---|---|---|
| `plans/260911-1811-thread-unit-of-work/research/runtime-history-bridge.md` | tạo | kết quả spike |
| `src/thread/{history-types,history-bridge,history-redact}.ts` | tạo | contract + registry + redaction |
| `src/runtime/{claude,codex}-history-bridge.ts` | tạo | theo spike |
| `src/thread/thread-service.ts`, `src/cli/commands/thread.ts` | sửa | collect/sync/show |
| `test/thread/history-*.test.ts`, `test/fixtures/thread-history/*` | tạo | |

## Rủi ro

| Failure mode | Giảm thiểu |
|---|---|
| Runtime đổi schema transcript | probe pin version; lệch → hạ completeness, không parse sai im lặng |
| Duplicate collect (settle + sync) | cursor + event digest |
| Process chết giữa chừng, transcript dở | collect best-effort, boundary `partial` |
| Secret lọt vào Thread | redaction test; tool raw không copy |
| Spike kéo dài | timebox; `final-only` là đường ra hợp lệ, không chặn P5 |

## Tiêu chí hoàn thành

- `research/runtime-history-bridge.md` có bảng probe cả hai runtime, ngày và CLI version.
- `npx vitest run test/thread` xanh, gồm idempotent + redaction.
- `alp thread show` in completeness đúng với bridge đã pin; runtime `unsupported` vẫn `continue` được.
- `npm test` xanh.

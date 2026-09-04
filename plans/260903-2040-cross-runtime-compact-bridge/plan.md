---
title: "ALP Cross-runtime Compact Bridge"
description: "Giữ objective, decisions và constraints sống qua native compaction của Claude Code và Codex CLI, bằng một journal append-only và một checkpoint file — không SDK, không model API, không lock."
status: pending
priority: P1
effort: 4.75-5.75d
branch: feat/compact-bridge
tags: [feature, context, runtime, hooks]
created: 2026-09-03
revised: 2026-09-03
---

# ALP Cross-runtime Compact Bridge — Master Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Sau khi Claude Code hoặc Codex CLI tự compact, session vẫn còn objective, decisions, constraints và next actions của ALP — và ALP biết chuyện compaction đã xảy ra.

**Architecture:** Runtime sở hữu transcript, context window và thuật toán compact. ALP giữ một checkpoint nhỏ bên ngoài runtime, reinject nó qua `SessionStart`, và ghi lifecycle compaction vào một journal append-only.

**Tech stack:** TypeScript 5.9, Node.js built-ins, Zod 4, Vitest 3, Claude Code hooks, Codex CLI hooks.

---

## 1. Quyết định kiến trúc

ALP không xây "Context Engine" kiểm soát mọi model turn. `RuntimeAdapter` chỉ `probe()` và `prepare()`; phiên interactive trao thẳng TTY cho child process (`stdio: "inherit"`). Không có điểm chèn ổn định trước mỗi model request.

Phiên bản phù hợp với codebase hiện tại là **Cross-runtime Compact Bridge**:

```text
Claude Code / Codex CLI
          │  PreCompact
          ▼
 hooks/compact-record.cjs  ──► append 1 dòng vào compact-events.jsonl
          │
          │  native compact (runtime tự làm)
          ▼
 hooks/compact-record.cjs  ──► append 1 dòng
          │
          │  SessionStart(source=compact)
          ▼
 hooks/session-boot.cjs    ──► đọc continuity.md, trả additionalContext
```

### Ownership

| Concern | Owner |
|---|---|
| Raw conversation history | Runtime |
| Context-window accounting | Runtime |
| Auto-compact threshold | Runtime |
| Native compact algorithm + summary | Runtime |
| Recent-tail preservation | Runtime |
| Identity và execution policy | ALP |
| Objective + explicit pins (checkpoint) | ALP |
| Compact lifecycle journal | ALP |
| Restore/reinjection policy | ALP |

### Khác biệt lớn nhất so với bản v1 của plan này

Bản v1 để checkpoint và compaction-state ghi chung, cần CAS/lock giữa hook và CLI, có hai trường `generation`, một bounded `seenDedupeKeys`, và một hook phải `require(dist/)`. Tất cả biến mất khi tách ownership ghi cho đúng:

- **Compact hook không bao giờ ghi checkpoint hay continuity.** Compaction không đổi objective hay pins, nên hook chỉ cần `appendFileSync` một dòng JSONL. Một write `O_APPEND` dưới 16 KiB là atomic — không lock, không read-modify-write, không mất update.
- **`compaction-state.json` không tồn tại.** State là hàm thuần trên journal, tính lại khi `alp context status` chạy. Không có projection để đồng bộ, không có projection để hỏng.
- **`generation` chỉ có một nguồn:** số event `completed` trong journal. Không lưu trong checkpoint.
- **Hook không load `dist/`.** Nó ghi lại một envelope thô-đã-lọc; việc normalize sang event trung lập xảy ra lúc *đọc*, trong TypeScript, nơi có Zod và có test.

Kết quả: hook ~60 dòng plain Node, không dependency, không thể làm hỏng dữ liệu cũ.

---

## 2. Thực trạng đã xác minh

### ALP hiện tại (đọc code, 2026-09-03)

- `src/runtime/runtime-adapter.ts` chỉ có `probe()` và `prepare()`.
- `src/backend/local-process-backend.ts` dùng `stdio: "inherit"` cho phiên interactive.
- `src/runtime/claude-adapter.ts` và `codex-adapter.ts` chỉ đăng ký `SessionStart` và `Stop`.
- `hooks/session-boot.cjs` inject `ALP_SESSION_CONTEXT` qua `additionalContext`, cố tình **không** load `dist/` vì lý do tốc độ.
- `hooks/session-end.cjs` load `dist/` để finalize state — precedent cho hook "nặng", nhưng nó chạy một lần lúc kết thúc.
- `FileExecutionStore.create()` (`src/execution/execution-store.ts`) dựng `policy.json`, `state.json`, `runtime/` trong staging dir rồi `rename` — chỗ đúng để thêm `context/`.
- `ExecutionService.prepare()` (`src/execution/execution-service.ts:135`) là nơi duy nhất có cả capsule lẫn artifacts — chỗ đúng để seed checkpoint.
- `renderSessionContext()` có sẵn `delegationSection()`: một section chỉ hiện khi role có `Bash`, dạy role cách gọi một lệnh `alp`. Đây là khuôn mẫu cho continuity section.
- `temporaryFiles` bị xoá sau khi child kết thúc (`local-process-backend.ts:339,350,481`) — chỉ những file được liệt kê. `context/` là thư mục anh em của `runtime/` nên sống sót.
- `src/agents/compaction.ts` là specialist delegate thủ công, output contract của nó (objectives, constraints, decisions, state, open items, next actions, anchors) trùng đúng field set của checkpoint — giữ nguyên để V1.1 cắm thẳng vào.

### Runtime capability

Đo trên máy 2026-09-03 bằng static analysis hai binary đã cài (Claude Code `2.1.259`, Codex CLI
`0.153.0`). Đây là schema runtime tự khai, không phải suy diễn.

**Claude Code 2.1.259** — Zod schema trong binary:

```js
PreCompact  = base.and({ hook_event_name: "PreCompact",  trigger: "manual"|"auto", custom_instructions: string|null })
PostCompact = base.and({ hook_event_name: "PostCompact", trigger: "manual"|"auto", compact_summary: string })
base        = { session_id, transcript_path, cwd, prompt_id?, permission_mode?, agent_id?, agent_type? }
SessionStart.source = "startup"|"resume"|"clear"|"compact"|"fork"
```

**Codex CLI 0.153.0** — JSON Schema `pre-compact.command.input` / `post-compact.command.input`
nhúng thẳng trong binary, hai event cùng shape:

```json
{ "cwd", "hook_event_name", "model", "session_id", "transcript_path": string|null,
  "trigger": "manual"|"auto", "turn_id", "agent_id"?, "agent_type"? }
```

`pre-compact.command.output` và `post-compact.command.output` chỉ có
`continue` / `stopReason` / `suppressOutput` / `systemMessage` — **không có `hookSpecificOutput`**.
`session-start.command.output` thì có, và `session-start.command.input.source` gồm `"compact"`.

Ba hệ quả đóng luôn ba câu hỏi mở của bản v1:

1. **Không runtime nào phát token count ở compact event.** Cả hai payload đều không có field usage.
   `preTokens`/`postTokens`/`contextWindowUsedTokens` bị bỏ khỏi v1 — field vĩnh viễn `null` là
   nhánh chết.
2. **Không runtime nào nhận context qua `PostCompact`.** Claude: `executePostCompactHooks` chỉ
   gom `output` thành `userDisplayMessage`, không hề đọc `hookSpecificOutput`. Codex: schema output
   không có field đó. §8.6 fallback 2 bị xoá.
3. **Cả hai đều phát `SessionStart` với `source="compact"`.** Đường reinjection chính hợp lệ trên
   cả hai runtime.

Thêm hai chi tiết ảnh hưởng hook body:

- Claude `PreCompact` **chặn được** compaction (`blocked` → "Compaction blocked by PreCompact hook")
  và stdout không-blocked được nạp vào chính lần compact đó.
- Claude `PostCompact` stdout được echo cho người dùng.

Cả hai củng cố invariant "exit 0, stdout rỗng" ở §8.4 bước 6.

Còn lại **chưa đo được bằng static analysis** và vẫn là gate CB-0: hook có thực sự dispatch trong
chế độ inherited-TTY của ALP không, và quoting hook command trên Windows cho Codex.

`PostCompact.compact_summary` (Claude) có tồn tại; ALP chủ động bỏ qua — đó là provider history,
runtime đã giữ nó rồi. Codex không phát field này.

### Paseo 0.7.2 reference

Reference implementation, không phải dependency. Chi tiết: [`research/paseo-compaction-reference.md`](./research/paseo-compaction-reference.md).

Invariant mượn về: provider tự compact; event trung lập chỉ mang lifecycle metadata; compact summary
không được phát lại như assistant message; reducer idempotent (duplicate/late/anonymous event không
tăng generation hai lần); state dựng lại bằng replay journal của chính ALP; root và delegated
execution giữ state riêng; capability pin theo version đo được.

Không mượn: app-server transport, Agent SDK, in-memory correlation, Paseo timeline product.

**Hai chỗ ALP cố tình lệch khỏi Paseo, cả hai do transport khác nhau:**

1. **"Usage reset sau compact"** — Paseo đọc `preTokens`/`postTokens` từ metadata `compact_boundary`
   của **Agent SDK stream**. Hook CLI của Claude 2.1.259 và Codex 0.153.0 **không có field usage nào**
   (§Runtime capability). Invariant này không áp dụng được ở transport của ALP, nên bỏ hẳn thay vì
   giữ field luôn `null`.
2. **`interrupted`** — Paseo đóng row loading ở cuối turn, và report khuyến nghị ALP gọi trạng thái
   đó là `interrupted`/`unknown`. ALP không có tín hiệu "cuối turn" đáng tin (`Stop` của Claude fire
   mỗi assistant turn, xem §10), nên một `started` chưa khớp `completed` chỉ đơn giản là `pending`
   trong state derive ra. Cùng ý nghĩa "đừng coi là thành công", ít khái niệm hơn.

---

## 3. Goals

1. Sau compaction, session còn objective + explicit pins của ALP.
2. Không tạo synthetic user turn — reinject chỉ qua hook context channel.
3. Không copy, không phát lại native compact summary.
4. Checkpoint **có nội dung thật** ngay từ session đầu tiên, không chờ người dùng gõ lệnh.
5. Cùng một checkpoint schema cho Claude và Codex.
6. Checkpoint sống ngoài `runtime/`, sống sót cleanup.
7. Compact hook không thể làm hỏng dữ liệu đã ghi, kể cả khi bị kill giữa chừng.
8. Duplicate / late / out-of-order compact event không làm generation tăng hai lần.
9. Có CLI để xem, kiểm tra và pin.
10. Runtime thiếu capability thì nói thật, không giả vờ đã reinject.

## 4. Non-goals

- Assemble toàn bộ model context trước từng turn.
- Prune tool output trong native transcript.
- Thay native context-window accounting.
- SessionStore/EventStore chung.
- Vector retrieval, semantic search, DAG summary.
- Pi, OpenCode, runtime thứ ba.
- App-server transport, Agent SDK, Rust rewrite.
- Hook gọi nested `claude`/`codex`.
- Tự động biến mọi thứ trong transcript thành long-term memory.
- `alp context compact` — ALP không sở hữu stdin của child; dùng `/compact` native.

---

## 5. Invariants

1. **Zero synthetic turn:** checkpoint chỉ đi qua hook context channel.
2. **Native ownership:** ALP không sửa hoặc xoá native transcript.
3. **Single writer per file:** `checkpoint.json` và `continuity.md` chỉ do process ALP (prepare, CLI) ghi; `compact-events.jsonl` chỉ do hook append. Không file nào có hai loại writer.
4. **Append-only journal:** hook chỉ `appendFileSync` một dòng < 16 KiB. Không đọc, không rewrite.
5. **Policy binding:** checkpoint mang đúng `executionId` và `policyHash`.
6. **Fail closed on integrity:** checkpoint sai schema/hash thì không inject.
7. **Fail open on availability:** lỗi ghi journal không được làm runtime chết hoặc block compact.
8. **No summary promotion:** native summary không vào checkpoint, không vào continuity, không vào journal.
9. **Bounded injection:** continuity có hard byte limit duy nhất.
10. **Atomic checkpoint write:** temp file + `rename`, theo đúng convention `atomicRuntimeFile`.
11. **Monotonic generation:** generation = số event `completed` đã dedupe; chỉ tăng.
12. **No recursion:** compact hook không launch agent/runtime.
13. **No project pollution:** artifact nằm dưới execution root, không ghi vào active workspace.
14. **Idempotent lifecycle:** một native compaction chỉ sinh đúng một logical completion.

---

## 6. Data model

### `ContinuityCheckpointV1` — file `context/checkpoint.json`

Writer: `ExecutionService.prepare()` (seed) và `alp context pin|unpin`. Không ai khác.

```ts
interface ContinuityCheckpointV1 {
  readonly version: 1;
  readonly executionId: string;
  readonly policyHash: string;
  readonly runtime: "claude" | "codex" | null;   // null cho tới khi adapter chạy
  readonly createdAt: string;
  readonly updatedAt: string;

  /** Seeded từ `capsule.task`. Đây là thứ làm checkpoint không rỗng ngay từ đầu. */
  readonly objective: string | null;
  readonly decisions: readonly ContinuityPin[];
  readonly constraints: readonly ContinuityPin[];
  readonly openItems: readonly ContinuityPin[];
  readonly nextActions: readonly ContinuityPin[];

  readonly integrity: { readonly checkpointSha256: string };
}

interface ContinuityPin {
  readonly id: string;                              // uuid
  readonly text: string;
  readonly source: "execution" | "principal" | "agent";
  readonly createdAt: string;
}
```

Bỏ so với v1: `generation` (derive từ journal), `state` (trùng `openItems`), `evidence` (YAGNI — evidence thuộc về report, không thuộc continuity).

### Journal line — file `context/compact-events.jsonl`

Writer: chỉ `hooks/compact-record.cjs`. Hook ghi **envelope thô đã lọc**, không normalize:

```jsonc
{
  "v": 1,
  "at": "2026-09-03T15:04:05.123Z",
  "executionId": "exec_...",
  "policyHash": "...",
  "runtime": "claude",
  "phase": "pre",                 // "pre" | "post", lấy từ argv của hook
  "source": { "session_id": "...", "trigger": "manual", "...": "..." }
}
```

`source` chỉ chứa scalar thuộc whitelist đo được ở §Runtime capability — `session_id`, `trigger`, `model`,
`turn_id` (Codex), `prompt_id` (Claude), `agent_id`, `agent_type` — mỗi value cắt ở 256 ký tự. Mọi thứ khác bị bỏ. `compact_summary` không nằm trong whitelist và dù có cũng bị loại theo invariant 8.

### `CompactEventV1` + `CompactionStateV1` — derived, không phải file

Tính bằng hàm thuần trên journal, chạy trong `alp context status|validate` và trong test:

```ts
interface CompactEventV1 {
  readonly dedupeKey: string;                       // runtime + sessionId + runtimeEventId + phase
  readonly runtime: "claude" | "codex";
  readonly phase: "started" | "completed";
  readonly trigger: "manual" | "auto" | "unknown";
  readonly runtimeSessionId: string | null;
  readonly runtimeEventId: string | null;
  readonly observedAt: string;
}

interface CompactionStateV1 {
  readonly generation: number;                      // số `completed` đã dedupe
  readonly pending: CompactEventV1 | null;          // `started` chưa có `completed` khớp
  readonly lastCompleted: CompactEventV1 | null;
}
```

Dedupe scan cả journal (bị chặn bởi rotation, xem §7) nên không có bounded-set để rò.

### Canonical hashing

- SHA-256 trên JSON canonical không chứa `integrity.checkpointSha256`.
- Object keys sort; array order giữ nguyên.
- Không dùng mtime hay path làm nguồn sự thật.

### Size limits — một đơn vị duy nhất là byte UTF-8

```text
checkpoint.json          <= 128 KiB
một pin                  <=   4 KiB
continuity.md (rendered) <=  24 KiB      # cũng là injection limit; không có số thứ hai
journal line             <=  16 KiB
raw hook stdin           <=   1 MiB
compact-events.jsonl     <=   1 MiB      # rotate .1 một lần
```

Vượt limit: reject pin với lỗi rõ; drop unknown provider field; không truncate policy field.

---

## 7. Storage layout

```text
~/.alp/executions/<execution-id>/
├── policy.json
├── state.json
├── runtime/                       # temporary, bị cleanup — behavior hiện tại
└── context/                       # 0700, sống sót cleanup
    ├── checkpoint.json            # 0600, ALP-written
    ├── continuity.md              # 0600, ALP-written, projection để inject
    └── compact-events.jsonl       # 0600, hook-appended
```

Không copy raw transcript, hook payload hay native summary.

Retention: journal đạt 1 MiB thì rename thành `.1` (ghi đè bản `.1` cũ) và bắt đầu file mới. Replay đọc `.1` rồi tới file hiện tại. Không có background cleanup service.

---

## 8. Lifecycle

### 8.1 Prepare — nơi checkpoint có nội dung

`ExecutionService.prepare()`, sau khi `store.create()` trả artifacts:

1. Seed `checkpoint.json` generation-less với `objective = capsule.task`, pins rỗng, `integrity` tính xong.
2. Render `continuity.md` từ checkpoint đó.
3. Cả hai ghi atomic, mode `0600`.

Đây là điểm sửa quan trọng nhất so với bản v1, vốn cố tình để objective `null` và do đó luôn inject rỗng. Với execution interactive, `capsule.task` là `"Interactive principal session; the task arrives from the principal."` — vô nghĩa để inject, nên renderer bỏ qua objective khớp chuỗi sentinel đó và chờ pin thật. Với delegated execution, `capsule.task` là task thật và đáng giữ.

### 8.2 Producer — làm sao pins có nội dung

Hai nguồn, không cần model call nào:

1. **Principal:** `alp context pin decision -- "..."`.
2. **Agent tự ghi:** `renderSessionContext()` thêm một `continuitySection`, dựng theo đúng khuôn `delegationSection` — chỉ hiện khi `policy.allowedTools.includes("Bash")`, nêu đúng lệnh, nói rõ khi nào dùng:

   > Ghi lại quyết định và ràng buộc **ngay khi chốt**, đừng đợi cuối phiên. Sau khi runtime compact, chỉ những gì đã pin còn lại.
   > ```
   > alp context pin decision -- "chọn X vì Y"
   > alp context pin constraint -- "không đụng tới Z"
   > ```
   > Pin là dòng một câu, không phải tóm tắt. Không pin secret, không pin nội dung file.

   Gating theo `Bash` giải quyết luôn chuyện role read-only (search, librarian, compaction…) chạy `--permission-mode plan` và bị rút `Bash` — chúng không thấy section, không thử lệnh chạy không được. `source: "agent"` vì thế chỉ tồn tại ở nơi nó thực sự dùng được.

### 8.3 SessionStart

`hooks/session-boot.cjs` đọc hai file, trả **đúng một** `additionalContext`:

1. `ALP_SESSION_CONTEXT` — identity, authority, policy (như hiện tại).
2. `ALP_CONTINUITY_CONTEXT` — nội dung `continuity.md`, nếu file tồn tại và không rỗng.

Hook vẫn không load `dist/`, vẫn fail-open: continuity mất/hỏng thì warning và chỉ inject session context. Turn count vẫn bằng 0 trước prompt thật của principal.

Chạy cho mọi `source`, gồm `startup`, `resume` và `compact` — không cần phân biệt, vì file luôn là bản mới nhất.

Đo được trên Claude: `SessionStart(source="compact")` fire **trước** `PostCompact`. Hook này vì thế
không được phép phụ thuộc vào việc compact event đã được ghi journal hay chưa. Nó chỉ đọc
`continuity.md` — vốn không dẫn xuất từ compact event — nên thứ tự đó không đổi gì.

### 8.4 Pre/PostCompact

`hooks/compact-record.cjs <pre|post>`:

1. Đọc stdin, hard-stop ở 1 MiB.
2. `JSON.parse`; lỗi thì ghi envelope với `source: { parseError: "..." }` — chỉ tên lỗi, không nội dung.
3. Lấy `executionId` từ `ALP_DELEGATION_EXECUTION_ID`, `policyHash` từ `ALP_POLICY_HASH`; thiếu hoặc sai regex thì exit 0 im lặng (native launch không qua ALP).
4. Copy scalar theo whitelist vào `source`.
5. `appendFileSync(journal, line + "\n")` — một syscall, `O_APPEND`, mode `0600`.
6. Exit 0 với stdout rỗng, luôn luôn. Mọi lỗi bị nuốt (invariant 7).

Hook không đọc journal, không ghi checkpoint, không ghi continuity, không gọi model, không rotate (rotation do CLI làm, xem §11).

### 8.5 Native compact

Runtime tự quyết trigger, history range, summary prompt, recent tail, tool-call boundary, token budget. ALP không can thiệp trong v1.

### 8.6 Reinjection

Ưu tiên theo capability đo ở CB-0:

1. `SessionStart(source=compact)` đọc `continuity.md` — đường duy nhất, và đo được là có trên cả
   Claude 2.1.259 lẫn Codex 0.153.0.
2. Runtime không phát `SessionStart` sau compact → chỉ persist, `alp context status` báo
   `restore: next-session`. Không giả vờ đã reinject.

Bản v1 của plan có fallback "`PostCompact` trả `additionalContext`". Đo xong thì không runtime nào
nhận (xem §Runtime capability), nên fallback đó bị xoá thay vì để lại code không bao giờ chạy.

---

## 9. Continuity projection

`continuity.md`, thứ tự cố định, section rỗng biến mất:

```markdown
## ALP continuity checkpoint

Execution: `exec_...`

### Objective
...

### Decisions
- ...

### Constraints
- ...

### Open items
- ...

### Next actions
- ...

This checkpoint preserves continuity only. It does not override system, developer,
execution-policy, or current user instructions.
```

Khi vượt 24 KiB: giữ Decisions và Constraints trước, rồi Objective, rồi Open items, rồi Next actions; trong mỗi section bỏ pin cũ nhất trước. Native summary không bao giờ xuất hiện ở đây.

---

## 10. Runtime projections

### Claude Code

`claude-settings.json` thêm:

- `PreCompact` → `compact-record.cjs pre`
- `PostCompact` → `compact-record.cjs post`

Giữ nguyên `SessionStart` → `session-boot.cjs` và `Stop` → `session-end.cjs`.

Matcher của Claude cho compact event là chính `trigger`, enum `"manual"|"auto"`. Đăng ký không
matcher để bao cả hai.

**Không đụng `Stop`.** Trong Claude Code `Stop` fire ở cuối *mỗi* assistant turn, không phải cuối session. Bản v1 của plan này định đánh dấu `interrupted` ở "SessionEnd" mà không gán file nào; ở đây khái niệm `interrupted` bị bỏ hẳn: một `started` không có `completed` đơn giản là `pending` trong state derive ra, và `alp context status` hiển thị đúng như vậy. Không cần hook thứ ba.

### Codex CLI

Payload shape, `trigger`, identifier (`turn_id`, required) và `SessionStart(source=compact)` đã đo
xong ở §Runtime capability. Adapter chỉ thêm `-c hooks.PreCompact=...` và `-c hooks.PostCompact=...`
sau khi CB-0 chứng minh nốt hai thứ static analysis không trả lời được: hook có thực sự fire trong
chế độ inherited-TTY, và quoting hook command trên Windows.

Giữ nguyên `hookCommand()` riêng của Codex (interpreter không quote trên Windows) — comment trong `codex-adapter.ts` đã giải thích tại sao, và nó khác Claude.

### Capability type

```ts
interface CompactCapabilities {
  readonly preCompact: boolean;
  readonly postCompact: boolean;
  readonly sessionStartAfterCompact: boolean;
}
```

Thuộc tính static trên adapter, pin theo version đã probe kèm comment ghi ngày. Production không chạy shell probe mỗi session.

Giá trị pin cho hai runtime đã đo (2026-09-03): cả ba `true` trên Claude `2.1.259` và Codex `0.153.0`.

Bỏ khỏi v1 vì đo ra hằng số, không đổi được hành vi nào: `stableEventId` (dedupeKey đã có fallback
fingerprint), `triggerMetadata` (cả hai runtime luôn gửi `trigger`), `tokenMetadata` và
`postCompactAdditionalContext` (cả hai runtime luôn không có).

### Feature flag

`compactBridgeEnabled(env)` trong `adapter-files.ts`: bật khi `ALP_COMPACT_BRIDGE === "1"`. Cả hai adapter gọi nó trước khi đăng ký compact hook. Rollback = bỏ biến môi trường. Stage 4 đổi default trong đúng hàm này.

---

## 11. CLI surface

```text
alp context status [execution-id]
alp context validate [execution-id]
alp context pin <decision|constraint|open-item|next-action> -- <text>
alp context unpin <pin-id>
```

Bỏ `alp context show` — `status` in đủ, và checkpoint là file JSON đọc được bằng `cat`.

Resolve execution ID: positional → `ALP_DELEGATION_EXECUTION_ID` → fail với usage. Không tự chọn "latest" mơ hồ.

`status` in: objective, số pin theo loại, generation, pending/last-completed, trigger, và `restore` mode theo capability. Không dump provider history.

`validate` kiểm: checkpoint schema + digest + policy binding, mọi dòng journal parse được và hợp schema, replay ra state ổn định. Đây là chỗ duy nhất Zod chạy trên dữ liệu journal — hook không validate, theo quyết định §1.

`pin` / `unpin`: verify policy binding → sanitize control character → enforce 4 KiB → cập nhật checkpoint atomic → rerender `continuity.md` atomic. Cả hai chạy trong một process CLI, không có writer thứ hai, nên không cần lock.

`status` và `validate` cũng là nơi rotate journal khi vượt 1 MiB — đọc-rồi-rename ở process CLI, không phải ở hook.

`helpText()` trong `src/cli/alp.ts` thêm một dòng cho `alp context`.

---

## 12. Failure policy

| Failure | Behavior |
|---|---|
| Hook payload không parse được | Append envelope với `parseError`; native compact vẫn chạy |
| Hook thiếu executionId / policyHash | Exit 0 im lặng — đây là native launch, không phải lỗi |
| Hook bị kill giữa chừng | Journal mất tối đa dòng đang ghi; file cũ nguyên vẹn; replay bỏ dòng hỏng |
| Journal có dòng không parse được | `validate` báo số dòng; replay bỏ qua; state vẫn tính được |
| Duplicate completion | Cùng dedupeKey → bỏ; generation không đổi |
| Completion không có start | Đếm là completion; `pending` vẫn `null` |
| Late completion cho event cũ | Khớp theo runtime event ID; không đóng pending mới hơn |
| Checkpoint schema/hash sai | Không inject; warning; giữ file hỏng để chẩn đoán |
| Checkpoint ghi hỏng giữa chừng | temp file bị bỏ; bản cũ nguyên vẹn |
| Runtime không hỗ trợ hook | Capability `false`; native compact chạy như cũ |

Exit code và stdout behavior phải test riêng cho từng runtime — một runtime có thể hiểu non-zero là block. Mặc định của `compact-record.cjs` là exit 0, stdout rỗng.

---

## 13. Security and privacy

- `context/` mode `0700`; file `0600` trên POSIX.
- Validate execution ID (`/^exec_[a-zA-Z0-9_-]+$/`) trước mọi path join — dùng lại pattern trong `execution-bridge.ts`.
- Không persist full hook stdin. `source` chỉ scalar whitelist, mỗi value ≤ 256 ký tự.
- Native summary không rời provider history.
- Checkpoint không thay đổi `ExecutionPolicy`.
- Pin từ CLI của principal → `source: "principal"`; pin do agent gọi (có `ALP_DELEGATED_ROLE`) → `source: "agent"`.
- Child execution không đọc được checkpoint của sibling — path bind theo `executionId` của chính nó.

---

## 14. Performance budget

Đo trên local SSD, tách phần ALP kiểm soát được khỏi phần không:

```text
compact-record.cjs, thân hook          p95 <   5 ms   # parse + 1 appendFileSync
compact-record.cjs, tổng end-to-end    p95 < 120 ms   # bị chi phối bởi node cold start
session-boot.cjs, phần continuity      p95 <   5 ms   # thêm 1 readFileSync
alp context status                     p95 <  50 ms
alp context validate                   p95 < 150 ms   # Zod trên toàn journal
```

Con số "tổng" không thể nhỏ hơn thời gian khởi động `node`, và bản v1 của plan này đặt 50 ms cho một hook có `require(dist/)` kéo theo Zod và agent registry — không đạt được. Giữ hook zero-dependency là cách duy nhất giữ con số này thấp và đúng.

Không network call. Không spawn runtime. Không đọc transcript.

---

## 15. File plan

### Create

**Core (5 file):**

- `src/context/types.ts` — `ContinuityCheckpointV1`, `ContinuityPin`, `CompactEventV1`, `CompactionStateV1`, `CompactCapabilities`.
- `src/context/checkpoint.ts` — Zod schema, canonical hash, size limits, atomic read/write/seed.
- `src/context/compact-journal.ts` — envelope schema, append (bản TS cho CLI/test), replay, dedupe + reduce, rotation.
- `src/context/compact-payload.ts` — whitelist field và normalizer envelope → `CompactEventV1` cho từng runtime.
- `src/context/continuity.ts` — renderer bounded Markdown.

**Surface (3 file):**

- `src/cli/commands/context.ts` — status / validate / pin / unpin.
- `hooks/compact-record.cjs` — một script, phase lấy từ argv, zero dependency.
- `scripts/probe-compact-hooks.cjs` — opt-in live capability recorder.

**Test (7 file):**

- `test/context/checkpoint.test.ts`
- `test/context/compact-journal.test.ts`
- `test/context/compact-payload.test.ts`
- `test/context/continuity.test.ts`
- `test/hooks/compact-record.test.ts`
- `test/cli/alp-context.test.ts`
- `test/e2e/compact-continuity.test.ts`

### Modify

- `src/execution/types.ts` — thêm `contextDirectory`, `checkpointFile`, `continuityFile`, `compactEventsFile` vào `ExecutionArtifactPaths`.
- `src/execution/execution-store.ts` — `mkdir(join(staging, "context"), { mode: 0o700 })` trước `rename`.
- `src/execution/execution-service.ts` — seed checkpoint + continuity sau `store.create()`.
- `src/runtime/render-session-context.ts` — thêm `continuitySection()`.
- `src/runtime/runtime-adapter.ts` — thêm `readonly compact: CompactCapabilities` vào interface.
- `src/runtime/adapter-files.ts` — `ALP_CONTINUITY_CONTEXT` + `ALP_POLICY_HASH` + `ALP_COMPACT_EVENTS` vào `baseRuntimeEnvironment` (nhận thêm `artifacts`), và `compactBridgeEnabled()`.
- `src/runtime/claude-adapter.ts` — đăng ký `PreCompact`/`PostCompact` sau flag.
- `src/runtime/codex-adapter.ts` — như trên, chỉ những event CB-0 xác nhận; nhận `hooksDirectory` từ caller.
- `src/cli/alp.ts` — parse `context`, thêm vào `AlpDependencies`, thêm dòng vào `helpText()`, truyền `hooksDirectory` cho `CodexRuntimeAdapter` (hiện Claude có, Codex không).
- `hooks/session-boot.cjs` — merge continuity vào `additionalContext`.
- `test/execution/execution-service.test.ts` — layout `context/` + checkpoint seeded.
- `test/runtime/runtime-adapters.test.ts` — hook registration, env parity, flag off/on.
- `test/runtime/render-session-context.test.ts` — continuity section theo grant `Bash`.
- `test/hooks/session-boot.test.ts` — merge, thiếu file, file hỏng, oversize.
- `test/e2e/harness.ts` — fake runtime phát được compact event.
- `docs/architecture.md`, `README.md`.

### Explicitly unchanged

`src/backend/local-process-backend.ts`, `src/delegation/**`, `src/memory/**`, `hooks/session-end.cjs`, native transcript, runtime model selection.

---

## 16. Implementation roadmap

## Phase CB-0 — Runtime contract spike

**Priority:** blocking · **Estimate:** 0.75 day *(giảm từ 1 day: phần schema đã đo xong 2026-09-03 bằng static analysis, chỉ còn probe dispatch chạy thật)*

### Task 0.1: Hook recorder — ✅ DONE (2026-09-03)

**Files:** `scripts/probe-compact-hooks.cjs`.

Một file, hai vai. Không `--record` thì là driver: sinh settings/config cô lập trỏ mọi hook về
chính nó, launch CLI đã cài bằng `stdio: "inherit"` (đúng chế độ ALP dùng), rồi in report. Có
`--record <EventName>` thì là hook: đọc stdin, append một dòng, exit 0.

Đã làm:

1. `--runtime claude|codex` + `--output <dir>` bắt buộc, không default — thư mục này nhận metadata
   của một phiên hội thoại thật.
2. Đăng ký cả 5 event (`SessionStart`, `PreCompact`, `PostCompact`, `Stop`, `SessionEnd`) — cả hai
   runtime đều nhận đủ tên này.
3. Ghi timestamp, event khai báo vs event parse được, **tên field + kiểu + độ dài**. Value bị redact
   mặc định; chỉ field enum (`hook_event_name`, `source`, `trigger`, `reason`, `permission_mode`,
   `model`) ghi verbatim vì đó chính là thứ bảng gate hỏi. `--reveal-all` để debug, có cảnh báo.
4. So field set thu được với `EXPECTED` (pin từ schema ở §Runtime capability). Lệch → in drift, exit 1.
5. **Marker reinjection.** `SessionStart` trả `additionalContext` chứa `ALP-PROBE-xxxxxxxx` random.
   Hỏi model marker sau `/compact` là test end-to-end trực tiếp đường reinjection duy nhất còn lại.
   Hai compact event in **stdout rỗng** — Claude nạp stdout của `PreCompact` vào chính lần compact
   đó và echo stdout của `PostCompact` cho user.
6. `hookCommand()` sao chép nguyên xi từ adapter, không tự chế: Claude dùng dạng quote-hết của
   `adapter-files.ts`, Codex trên Windows dùng dạng interpreter-trần của `codex-adapter.ts`. Probe
   quote khác production là probe sai thứ.
7. Từ chối chạy khi `CI` set, trừ khi `ALP_LIVE_RUNTIME_TESTS=1`.
8. `--dry-run` in ra command string từng event + dòng launch, không chạy gì. Đây là thứ cầm lên
   đầu tiên khi hook không fire trên Windows.
9. `--report-only` in lại report của lần chạy trước.

**Verification:**

```bash
node scripts/probe-compact-hooks.cjs --runtime codex --output /tmp/alp-codex-probe --dry-run
node scripts/probe-compact-hooks.cjs --runtime claude --output /tmp/alp-claude-probe
node scripts/probe-compact-hooks.cjs --runtime codex  --output /tmp/alp-codex-probe
```

Kịch bản trong phiên (script tự in ra): gửi một prompt → hỏi marker → `/compact` → hỏi marker lại
→ thoát. Report ghi `report.md` cạnh `events.jsonl`, exit 1 nếu không event nào hoặc có drift.

Thêm sau khi chạy thật (2026-09-03):

- **Digest thay vì giá trị.** Mỗi string field ghi kèm 8 hex đầu của sha256. Đủ để so bằng nhau —
  chính là cách xác định `prompt_id` có ghép được `started` với `completed` không — mà không đưa
  identifier lên đĩa. Report in bảng correlation.
- **`run.json` + nhãn chế độ chạy.** Report in `inherited-TTY` hay `headless (no TTY)`. Bản đầu
  in cứng "fired in inherited-TTY mode" trong khi chạy `-p` — tức là khẳng định thứ chưa hề test.
- **Thứ tự event** in nguyên chuỗi, vì đó là cách phát hiện `SessionStart(compact)` đến trước
  `PostCompact`.
- `EXPECTED.claude.SessionStart.optional` nới ra cho các field telemetry chỉ thấy khi chạy thật.

Đã chạy thật trên darwin: Claude headless đủ vòng đời compact, 3 lần liên tiếp giống hệt nhau;
Codex tới `SessionStart` thì hết usage limit. Windows đã đo ngày 2026-09-04 (Codex, headless), và
inherited-TTY cũng đã đo cùng ngày trên cả hai runtime — xem §Gate CB-0. **Gate đã qua.**

Thêm sau lần đo Windows (2026-09-04):

- **Resolve binary thay vì đoán đuôi.** `launchSpec()` từng hard-code `${runtime}.cmd` trên win32;
  bản cài winget không có `.cmd` nào và probe chết ở `EINVAL`. Giờ đi PATH + PATHEXT như
  `resolveRuntimeCommand()`, và gỡ shim npm như `windows-shim.ts`. Probe phải launch runtime
  giống production, không chỉ quote hook giống production.

### Task 0.2: Freeze contract

**Files:** create `src/context/types.ts`, `src/context/compact-payload.ts`, `test/context/compact-payload.test.ts`.

**Steps:**

1. Thêm fixture Claude (redacted, từ field chính thức) và fixture Codex (redacted, từ probe).
2. Test failing cho: phase, trigger, session ID, event ID (`turn_id` ở Codex, `prompt_id` ở Claude), và **whitelist** — field ngoài whitelist bị bỏ, `compact_summary` không bao giờ lọt.
3. Implement normalizer từng runtime: unknown field bỏ qua, required field sai kiểu thì reject.
4. Pin `CompactCapabilities` cho mỗi adapter kèm comment ghi CLI version + ngày probe.

**Test:** `npm test -- test/context/compact-payload.test.ts`

**Xong 2026-09-04.** 18 test, cả suite 260 test xanh, `tsc --noEmit` sạch. Ba điểm chốt lại khác
với lúc viết task:

- Fixture lấy từ payload đo thật ngày 2026-09-04 chứ không từ field chính thức, nên nó giữ cả
  những chỗ schema không nói: Claude `PreCompact`/`PostCompact` **không** mang `model` trong khi
  `SessionStart` của nó có, và `custom_instructions` là `null` chứ không vắng mặt.
- `trigger` sai giá trị thì **không** reject, nó degrade thành `"unknown"` — kiểu dữ liệu có sẵn
  trạng thái đó, và một trigger lạ trong tương lai không đáng làm hỏng cả lần replay. Reject dành
  cho thứ nói rằng dòng đó không phải do hook của ALP viết: runtime lạ, phase lạ, `source` không
  phải object. Đây là chỗ diễn giải "required field sai kiểu thì reject" hẹp lại một cách có chủ ý.
- `dedupeKey` ưu tiên `sequence` do ALP cấp, rồi mới tới id của runtime. Có test cho đúng ca đã đo
  ở `codex exec`: hai compaction dùng chung một `turn_id` vẫn phải ra hai key khác nhau.

`CompactCapabilities` pin `true` cả ba trên cả hai adapter, comment kèm version và ngày probe.
`RuntimeAdapter` có thêm `readonly compact`, nên ba stub trong test phải khai nó — đó là ý đồ: một
adapter mới không được phép im lặng bỏ qua câu hỏi này.

**Gate CB-0.** Bảng dưới điền ngày 2026-09-03 bằng schema đọc trực tiếp từ binary đã cài
(bằng chứng đầy đủ ở §Runtime capability):

| Runtime | Version | Pre | Post | Trigger | Event ID | Tokens | SessionStart sau compact | Post nhận additionalContext |
|---|---|---|---|---|---|---|---|---|
| Claude | 2.1.259 | có | có | `manual`\|`auto` | `prompt_id` (optional) | **không** | có (`source="compact"`) | **không** |
| Codex | 0.153.0 | có | có | `manual`\|`auto` | `turn_id` (required, **không unique theo compaction**) | **không** | có (`source="compact"`) | **không** |

Ghi chú:
- Claude `PreCompact` chặn được compaction và stdout của nó nạp vào lần compact đó; `PostCompact`
  stdout hiện cho người dùng. → hook phải exit 0, stdout rỗng.
- Claude `PostCompact` có `compact_summary`, Codex không. ALP bỏ qua cả hai (invariant 8).

**Probe chạy thật, darwin, 2026-09-03/04** (`scripts/probe-compact-hooks.cjs`):

| Câu hỏi | Claude 2.1.259 | Codex 0.153.0 |
|---|---|---|
| Hook command string chạy được | ✅ | ✅ (`hook: SessionStart Completed`) |
| SessionStart dispatch | ✅ | ✅ |
| `additionalContext` tới được model | ✅ model đọc lại đúng marker | ✅ marker `ALP-PROBE-03E66B2E` |
| PreCompact / PostCompact dispatch | ✅ (`manual`) | ✅ (`auto`, 6 lần trong một phiên) |
| SessionStart phát lại `source="compact"` | ✅ | ✅ |
| Marker sống sót qua compaction | ✅ | ✅ (sau 6 lần auto-compact) |
| Schema khớp bản pin | ✅ | ✅ |

Chế độ chạy là **headless** (`claude -p`, `codex exec`), không phải inherited-TTY. Report của probe
in rõ chế độ để không nhận vơ. Inherited-TTY được đo riêng bằng tay, cùng ngày, và cho cùng kết
quả — xem cuối §Gate CB-0.

Cách ép auto-compaction trên Codex (không có `/compact` trong `exec`): bóp context window bằng
hai key top-level của `ConfigToml`, rồi giao một task nhiều turn:

```
codex ... -c model_context_window=12000 -c model_auto_compact_token_limit=2000 exec ...
```

Một cái bẫy đã dính: `-c` là clap global arg. Đặt nó **sau** subcommand `exec` thì lượt
subcommand **thay thế** toàn bộ `-c` ở cấp cha — mất sạch `-c hooks.*`, phiên chạy không hook nào
fire và không báo lỗi gì. Mọi `-c` phải nằm cùng một cấp.

**Bốn phát hiện chỉ probe chạy thật mới thấy được**, không có trong schema:

1. **Thứ tự event không như giả định, và hai runtime ngược nhau.** Đo được:
   ```
   Claude:  PreCompact → SessionStart(source="compact") → PostCompact
   Codex:   PreCompact → PostCompact → SessionStart(source="compact")
   ```
   Trên Claude reinjection xảy ra **trước** khi `PostCompact` báo compaction xong. Vô hại với thiết kế này —
   `continuity.md` do ALP sở hữu, không dẫn xuất từ compact event — nhưng phải nói rõ: ngay sau
   reinjection, journal mới chỉ có `started`, nên `alp context status` hiển thị `pending` một
   khoảnh khắc là **đúng, không phải bug**. Và mọi thiết kế kiểu "chỉ reinject sau khi compaction
   completed" là bất khả thi trên Claude. Codex thì ngược lại, journal đã có `completed` trước khi
   reinject. Điểm hợp nhất duy nhất của cả hai là: **`SessionStart(source="compact")` là chỗ
   reinject**, không phải `PostCompact`. Reader của `continuity.md` vì thế không được giả định gì
   về trạng thái journal tại thời điểm đọc.

2. **`prompt_id` là correlator dùng được.** Cùng một giá trị ở `PreCompact`, `SessionStart(compact)`
   và `PostCompact` (đo bằng digest sha256, không lộ giá trị). `session_id` cũng không đổi qua
   compaction. `dedupeKey = runtime|sessionId|eventId|phase` chạy được với `eventId = prompt_id`.
   Lưu ý `prompt_id` là id của *turn*, không phải của compaction — `SessionEnd` dùng chung id đó.

   **Trên Codex thì không có correlator như vậy.** `turn_id` là id của *root turn*: cả 6 lần
   auto-compact trong một phiên `exec` dùng chung một `turn_id` (digest `87f9ca04`), và `Stop`
   cũng dùng chung nó. `dedupeKey = runtime|sessionId|eventId|phase` sẽ gộp nhầm 6 compaction
   thành một. Codex phải dùng **sequence tăng dần do ALP tự cấp**, không dùng `turn_id`.
   `session_id`, `transcript_path`, `cwd` đều không đổi qua compaction trên cả hai runtime.

3. **Schema trong binary là sàn, không phải trần.** `SessionStart` thật mang thêm field Zod schema
   không hề khai, và **khác nhau theo `source`**:
   - `source="resume"`: `seconds_since_last_response`, `context_tokens`,
     `prompt_cache_likely_expired`, `estimated_cache_write_usd`
   - `source="compact"`: `model`
   Đây là lý lẽ mạnh nhất cho thiết kế whitelist ở §7: copy đúng field đã biết, bỏ mọi thứ khác.
   Một normalizer kiểu blacklist sẽ rò mấy field này vào journal.

   Hệ quả với quyết định bỏ token: `context_tokens` **có tồn tại**, nhưng chỉ ở `source="resume"` —
   **không** ở `source="compact"`, không ở `PreCompact`, không ở `PostCompact`. Không có đường nào
   lấy được context size sau compaction. Quyết định bỏ `contextWindowUsedTokens` giữ nguyên; lý do
   chính xác là "không event nào liên quan compaction mang nó", chứ không phải "không payload nào có".

4. **`compact_summary` nặng 22–32 KB** qua ba lần đo. Vượt xa giới hạn 16 KiB một dòng journal.
   Invariant 8 (không bao giờ ghi summary) không chỉ là chuyện sạch sẽ — ghi vào là vỡ định dạng.
   Giới hạn stdin 1 MiB ở §8.4 là đúng chỗ.

Ngoài ra Codex tự clamp timeout hook `SessionEnd` xuống 3s (`warning: clamping SessionEnd hook
timeout to 3s`) — không ảnh hưởng compact hook, nhưng đừng trông vào `timeout = 30` đã khai.

**Thêm hai phát hiện từ lần đo Codex (2026-09-04):**

5. **Auto-compaction dồn dập.** 6 lần trong ~90 giây, cách nhau ~13s, mỗi lần kèm một
   `SessionStart(source="compact")`. Đường ghi checkpoint phải rẻ và idempotent; không được coi
   compaction là sự kiện hiếm. `alp context status` cũng phải chịu được journal có nhiều cặp
   `started`/`completed` liên tiếp cùng `sessionId`.

6. **Codex `PostCompact` không mang summary.** Payload đúng 7 field, 349 byte. Claude cho
   22–32 KB `compact_summary`, Codex cho **không gì cả**. Bất kỳ thiết kế nào định dùng summary
   của runtime làm nội dung checkpoint là chết trên Codex — củng cố invariant 8. Token count thì
   đọc được từ transcript rollout (`event_msg` kiểu `token_count`), nhưng **không** từ hook
   payload; nếu sau này cần token thật thì đó là đường duy nhất, và nó tốn một lần đọc file.

**Probe chạy thật, win32, 2026-09-04** (Codex 0.153.0 headless, `codex.exe` từ winget):

Ô Windows của gate đã đóng. 72 hook invocation, **23 lần auto-compact** trong một phiên `exec`,
không drift schema. Chuỗi event giống hệt darwin:

```
Codex/win32:  PreCompact → PostCompact → SessionStart(source="compact")
```

Ba phát hiện darwin được xác nhận lại trên Windows, không cái nào là hành vi riêng của macOS:
`turn_id` giữ nguyên một digest (`8f8ac1f2`) qua cả 23 compaction — nên nó vẫn không dùng làm
correlator được (phát hiện 2); `PostCompact` đúng 7 field, 420 byte, **không** `compact_summary`
(phát hiện 6); và auto-compaction vẫn dồn dập, ở đây còn dày hơn darwin.

Về chính câu hỏi quoting: dạng lệnh hook mà `hookCommand()` sinh trên Windows —
`node "<script>" …`, interpreter trần vì `process.execPath` là
`C:\Program Files\nodejs\node.exe` và có space — **chạy được**, cả 72 lần. Ghi chú trong
`codex-adapter.ts` đúng như đã viết.

7. **Cái hỏng trên Windows không phải quoting, mà là cách probe launch runtime.** `launchSpec()`
   hard-code `${runtime}.cmd` trên win32. Đó chỉ đúng với bản cài npm; bản winget đặt
   `codex.exe`/`claude.exe` trần trên PATH và **không có `.cmd` nào cả**, nên probe chết ở
   `spawnSync codex.cmd EINVAL` trước khi một hook nào kịp fire — và triệu chứng "không hook nào
   fire trên Windows" trông y hệt lỗi quoting mà probe sinh ra để phát hiện. Đã sửa: resolve
   binary theo PATH + PATHEXT như `resolveRuntimeCommand()` production, rồi gỡ shim `.cmd`/`.bat`
   theo đúng cách `windows-shim.ts` làm (Node từ chối spawn `.cmd`, và `shell: true` sẽ cho
   cmd.exe parse lần hai cái command string đầy quote và backslash).

**Lần đo inherited-TTY thứ nhất, win32, 2026-09-04 — một nửa dùng được:**

`run.json` ghi `"mode": "inherited-TTY"` trên cả hai runtime, và đây là phần **kết luận được**:

| | Claude 2.1.240 | Codex 0.153.0 |
|---|---|---|
| `SessionStart` dispatch trong TTY | ✅ | ✅ |
| `additionalContext` tới được model | ✅ `ALP-PROBE-ADA5B5DB` | ✅ `ALP-PROBE-746A2E7F` |
| `Stop` dispatch trong TTY | ✅ | ✅ |

Tức là **đường reinject mà cả thiết kế này dựa vào — `SessionStart` + `additionalContext` — chạy
trong inherited-TTY trên cả hai runtime.** Đó là rủi ro lớn nhất của CB-3 và nó đã hạ.

**Cả hai runtime fire compact hook trong inherited-TTY.** Đo trên win32, 2026-09-04, mỗi runtime
hai phiên độc lập, phiên cuối đóng sạch (`SessionEnd` có mặt, `report.md` tự ghi):

```
Claude/win32/TTY:  PreCompact(manual) → SessionStart(source="compact") → PostCompact(manual)
Codex /win32/TTY:  PreCompact(manual) → PostCompact(manual) → SessionStart(source="compact")
```

**Cả hai thứ tự khớp đúng bản đo darwin headless.** Điểm 1 của §"Bốn phát hiện" — hai runtime
ngược nhau, và điểm hợp nhất duy nhất là `SessionStart(source="compact")` — đứng vững ở cả hai
chế độ chạy và cả hai OS. Đó không phải hành vi riêng của macOS, của headless, hay của `auto`.

**`PreCompact` có thể fire mà không có `PostCompact` đi kèm.** Phiên Claude `d4b3edc6`:

```
01:30:33  PreCompact(manual)     ← không có PostCompact nào theo sau
01:31:00  Stop
01:31:03  PreCompact(manual)     ← lần này mới đi hết vòng
01:31:36  SessionStart(compact)
01:31:37  PostCompact(manual)
```

Một compaction được khởi động rồi bỏ dở. Reducer của journal vì thế phải chịu được `started` mồ
côi **không phải như trường hợp hiếm**, mà như chuyện thường ngày — và `alp context status` không
được coi `started` không cặp là dữ liệu hỏng. Đây cũng là lý do thứ hai để không dùng
`PostCompact` làm điểm reinject.

Và so với `auto` đã đo headless, **payload giống hệt nhau về cấu trúc**:

| | PreCompact | PostCompact |
|---|---|---|
| field, cả `manual` lẫn `auto` | `session_id, turn_id, transcript_path, cwd, hook_event_name, model, trigger` | như trên |
| khác biệt | chỉ giá trị `trigger` | chỉ giá trị `trigger` |

Chênh lệch byte (346/347 `manual` so với 419/420 `auto`) chỉ là độ dài `cwd` của hai lần chạy,
không phải field thừa. Ô "manual có khác auto không" vì thế đóng: **không khác**, một normalizer
là đủ cho cả hai.

**Codex phát `SessionStart(source="compact")` ở đầu lượt kế tiếp, không phải lúc compaction xong.**
Hai phiên đầu (`4176f076`, `6b63a715`) đều thoát ngay sau khi compact nên không thấy nó, và suýt
nữa đã được ghi thành "Codex không bao giờ phát". Phiên `08864a48` làm đủ bước 4 và cho câu trả
lời:

```
01:40:55.888  PreCompact(manual)      turn=ce65e50a
01:41:00.261  PostCompact(manual)     turn=ce65e50a
01:41:07.361  SessionStart(compact)   marker ALP-PROBE-7920E75E   ← +7.1s, là lúc người gõ prompt
01:41:09.748  Stop                    turn=aa89b528
```

Khoảng 7.1 giây giữa `PostCompact` và `SessionStart` là thời gian gõ phím của người dùng, không
phải độ trễ của Codex — nếu nó phát ngay sau compaction thì khoảng đó dưới một giây. Đối chiếu
Claude cùng ngày: `PreCompact` 01:31:03 → `SessionStart(compact)` 01:31:36 → `PostCompact`
01:31:37, tức trên Claude việc reinject nằm **bên trong** chính quá trình compaction.

**Và context có tới được model thật.** Bước 4 hỏi lại marker, model trả `ALP-PROBE-7920E75E` —
đúng marker của `SessionStart(source="compact")`, khác marker `ALP-PROBE-A35ABFD3` lúc mở phiên.
Đây là bằng chứng đầu-cuối cho đường reinject trên Codex trong inherited-TTY, không chỉ là chuyện
hook có chạy.

Hệ quả cho `alp context status`: trên Codex có một khoảng giữa "compaction xong" và "lượt sau bắt
đầu" mà journal đã `completed` nhưng chưa reinject lần nào. Không mất gì — khoảng đó không có
lượt model nào — nhưng nó là **ảnh gương** của trường hợp `pending` trên Claude đã ghi ở phát hiện
1, và reader của `continuity.md` vẫn không được giả định gì về trạng thái journal.

**`turn_id` của Codex hành xử khác nhau giữa TTY và headless.** Trong TTY, mỗi compaction có
`turn_id` riêng, khác `turn_id` của các `Stop` xung quanh, và `PreCompact`/`PostCompact` của cùng
một compaction dùng chung nó (`39ae8923`, rồi `eb5456d4`). Trong `exec`, cả 23 compaction dùng
chung một `turn_id` gốc. Quyết định ở phát hiện 2 — Codex phải dùng sequence do ALP tự cấp — vì
thế **giữ nguyên**: `turn_id` đúng trong TTY nhưng gộp nhầm trong `exec`, và bridge phải chạy
được ở cả hai.

**Claude: `/compact` chạy được ngay khi gõ đúng.** Phiên `d4b3edc6` cho đủ vòng đời. Hai lần đầu
(`fbf7677d`, và lần 01:22) không phải lỗi runtime: user message được ghi đúng là `" /compact"`,
**có space ở đầu**, nên Claude Code không nhận ra slash command và gửi thẳng cho model; model tóm
tắt hộ và terminal trông y hệt lúc thành công. Transcript `9315fac7-….jsonl` có 0
`compact_boundary`, trong khi transcript khác cùng máy cùng version thì có — format không phải
vấn đề, lệnh mới là.

**Hai bài học về cách đọc số đo, không phải về runtime:**

1. *Model sẽ đóng vai.* Hỏi `/compact` như một prompt thì cả hai model đều đáp lại như thể đã
   compact — Claude "I'll summarize the conversation so far.", Codex thậm chí đáp đúng chuỗi
   "Context compacted." mà Codex dùng làm UI string. Không đọc transcript của runtime thì không
   phân biệt được. Report cũ in `PreCompact fired: NO` cho cả "hook không dispatch" lẫn "không có
   compaction nào", nên nó đọc như bằng chứng CB-3 chết. Đã đổi thành `not observed` kèm cách tự
   kiểm chứng.
2. *`events.jsonl` là file đang sống.* Bản đọc đầu tiên bắt được 3 event và kết luận "hook không
   fire trong TTY"; compaction thật xảy ra 7 phút sau đó và ghi tiếp vào cùng file. Chỉ đọc khi
   phiên đã đóng, hoặc đọc lại trước khi kết luận. `report.md` vắng mặt lẽ ra đã là dấu hiệu —
   driver bị Ctrl+C giết nên chưa ai chốt sổ; `--report-only` dựng lại được, nhưng nó dựng lại
   *trạng thái tại thời điểm gọi*, không phải trạng thái cuối.

**Trạng thái gate:**

**Không còn ô nào. Gate CB-0 đã qua.**

| Câu hỏi | Runtime | Kết quả |
|---|---|---|
| ~~`PreCompact`/`PostCompact` dispatch trong inherited-TTY~~ | ~~cả hai~~ | ✅ 2026-09-04, `trigger=manual` |
| ~~`SessionStart(source="compact")` trong inherited-TTY~~ | ~~cả hai~~ | ✅ 2026-09-04 — Claude trong lúc compact, Codex ở đầu lượt sau |
| ~~`additionalContext` tới được model sau compaction~~ | ~~cả hai~~ | ✅ 2026-09-04, model đọc lại đúng marker mới |
| ~~Compaction `manual` có khác `auto` không~~ | ~~Codex~~ | ✅ 2026-09-04 — không khác, chỉ giá trị `trigger` |
| ~~Quoting hook command trên Windows~~ | ~~Codex~~ | ✅ 2026-09-04, 72 lần, không drift |

Tổng cộng bốn tổ hợp đã đo thật, không tổ hợp nào mâu thuẫn tổ hợp nào: darwin/headless/`auto`,
win32/headless/`auto`, win32/TTY/`manual` cho Claude, win32/TTY/`manual` cho Codex. Thiết kế ở §7
— checkpoint do ALP sở hữu, reinject tại `SessionStart(source="compact")`, không bao giờ đọc
`compact_summary` — không phải sửa gì sau gate.

Docs của cả hai hãng đều nói `PreCompact`/`PostCompact` fire với `trigger` ∈ {`manual`, `auto`}
và **không** có ngoại lệ nào cho TTY ([Claude Code hooks](https://code.claude.com/docs/en/hooks),
[Codex hooks](https://learn.chatgpt.com/docs/hooks)). Số đo Codex khớp docs. Ô Claude còn trống là
vì lệnh chưa chạy, không vì hành vi khác docs.

Nhân tiện từ docs Codex: hook entry có field **`command_windows` / `commandWindows`** — override
riêng cho Windows. Đó là cơ chế chính thức cho đúng vấn đề mà `hookCommand()` trong
`codex-adapter.ts` đang tự né bằng cách bỏ quote quanh interpreter. Cách hiện tại **đã đo là chạy**
(72 lần, xem trên) nên không phải bug; nhưng nếu sau này chạm vào chỗ đó thì `command_windows` là
đường sạch hơn, và nó cho phép quote interpreter tử tế thay vì phụ thuộc `node` trên PATH.

Hai ô còn lại đều cần **người ngồi trước TTY thật** — không chạy được qua tool harness, vì
`stdio: "inherit"` ở đó vẫn không phải TTY (`run.json` sẽ ghi `headless (no TTY)`) và không ai gõ
được `/compact`.

**Runbook chạy lại gate.** Gate đã qua ngày 2026-09-04; giữ runbook này để chạy lại khi CLI lên
version mới, vì phần inherited-TTY không tự động hoá được. Mở terminal thật (không phải qua
agent), rồi mỗi runtime một lần:

```bash
node scripts/probe-compact-hooks.cjs --runtime claude --output ~/alp-probe/claude-tty
node scripts/probe-compact-hooks.cjs --runtime codex  --output ~/alp-probe/codex-tty
```

Không truyền `-p`/`exec`, và không bóp context window — lần này đo `manual`, để auto khỏi chen
vào. Trong phiên, đúng thứ tự script tự in ra: gửi một prompt → hỏi "what is the ALP probe
marker?" → `/compact` → hỏi marker lại → thoát.

**Ba cái bẫy đã làm hỏng các lần đo ngày 2026-09-04**, mỗi cái tốn một phiên:

- **`/compact` phải là slash command thật.** Gõ tay, đừng paste, không space nào trước dấu `/`.
  Claude Code nhận `" /compact"` là văn bản thường; model tóm tắt hộ và trông y như compact thành
  công. Trên Codex, gõ `/` cho popup hiện rồi chọn `compact`. Dấu hiệu đúng: Claude hiện UI
  compaction, Codex in xác nhận của chính nó chứ không phải một lượt assistant.
- **Bước 4 không được bỏ.** Sau `/compact` phải gửi thêm một prompt rồi mới thoát. Codex phát
  `SessionStart(source="compact")` ở **đầu lượt sau**, nên phiên thoát ngay sau compaction sẽ
  không thấy nó — hai phiên đầu đã thoát sớm và suýt nữa kết luận thành "Codex không bao giờ phát".
- **Thoát bằng lệnh thoát của CLI** (`/exit`, `Ctrl+D`), đừng Ctrl+C — Ctrl+C giết cả driver và
  mất `report.md`. Lỡ rồi thì `--report-only` dựng lại được, nhưng chỉ dựng lại *trạng thái tại
  thời điểm gọi*: `events.jsonl` là file đang sống, đọc lúc phiên còn mở thì thấy thiếu event.

Đọc kết quả:

1. `run.json` phải ghi `"mode": "inherited-TTY"`. Nếu vẫn `headless` thì terminal đó không phải
   TTY và số đo không tính.
2. **Xác minh compaction có thật**, trước khi tin bất kỳ ô nào trong §Gate: Claude
   `~/.claude/projects/<cwd-slug>/<session>.jsonl` phải có compact boundary; Codex
   `~/.codex/sessions/<ngày>/rollout-*.jsonl` phải cho thấy context co lại, không phải thêm một
   cặp `task_started`/`task_complete` với token tăng.
3. `report.md` §Gate, cả ba dòng phải `YES`: `PreCompact` / `PostCompact` /
   `SessionStart source=compact`. Cột `trigger/source` phải là `manual`.
4. Bộ field của `PreCompact`/`PostCompact` phải khớp bản `auto` đã pin — trên Codex là
   `session_id, turn_id, transcript_path, cwd, hook_event_name, model, trigger`. Chênh byte giữa
   hai lần chạy là độ dài `cwd`, không phải field thừa.
5. Marker sau `/compact` phải là marker **mới**, khác marker lúc mở phiên — đó là bằng chứng
   `additionalContext` thật sự tới được model, không chỉ là hook có chạy. Script không đọc hộ
   được, chép tay từ transcript.

Muốn đo `auto` trong TTY (gate không đòi, nhưng nếu cần tách trigger khỏi chế độ chạy): bóp
context window bằng đúng hai key đã dùng ở lần đo headless
(`model_context_window=12000`, `model_auto_compact_token_limit=2000`), truyền sau `--`, và nhớ mọi
`-c` phải nằm cùng một cấp.

Lưu ý version: bảng gate pin Claude 2.1.259, máy đo win32 có 2.1.240. Phần inherited-TTY vì thế
đo trên 2.1.240 và report **không báo drift** — payload của hai bản này giống nhau ở những field
gate quan tâm. Nhưng nếu lần chạy lại nào báo drift thì phải phân biệt: lệch version hay lệch hành
vi. Cách rẻ nhất là chạy lại trên đúng version đã pin trước khi sửa `EXPECTED`.

**Commit:** `test(context): pin native compact hook contracts`

---

## Phase CB-1 — Checkpoint và journal core

**Priority:** P1 · **Estimate:** 1.5 days

### Task 1.1: Checkpoint schema + store

**Files:** create `src/context/checkpoint.ts`, `test/context/checkpoint.test.ts`.

**Steps:**

1. Test failing: round-trip, bad version / executionId / policyHash / timestamp, oversize pin, oversize file.
2. Implement Zod schema + inferred type.
3. Implement canonical serialization và digest; test cùng giá trị logic → cùng hash bất kể key order.
4. Implement `readCheckpoint` (fail closed khi hash sai), `writeCheckpoint` (temp + rename, `0600`, theo convention `atomicRuntimeFile`), `seedCheckpoint`.
5. Test interrupted write: bản cũ nguyên vẹn.
6. Reject cross-execution policy binding.

**Test:** `npm test -- test/context/checkpoint.test.ts`

**Xong 2026-09-04.** 13 test. "Interrupted write" hoá ra test được gọn nhất qua thứ tự sẵn có
chứ không cần mock fs: `writeCheckpoint` chạy `checkpointSchema.parse` **trước** khi đụng đĩa,
nên một checkpoint bị reject (pin oversize, tổng oversize) không bao giờ tới
`atomicRuntimeFile` — file cũ, nếu có, không đổi một byte. Test khẳng định đúng điều đó: ghi
một bản hợp lệ, thử ghi đè bằng bản hỏng, đọc lại file thấy nguyên bản đầu.

Một bug thật bắt được nhờ test round-trip: `writeCheckpoint` nhận tham số gõ là
`Omit<ContinuityCheckpointV1, "integrity">`, nhưng caller thường truyền thẳng một checkpoint
đầy đủ đã có `integrity` (từ `seedCheckpoint` hoặc lần đọc trước) — TypeScript chỉ excess-check
literal, không check biến, nên `integrity` cũ lọt qua runtime và bị hash nhầm cùng nội dung.
Sửa bằng cách destructure bỏ `integrity` tường minh trước khi hash, bất kể type nói gì.

### Task 1.2: Durable artifact layout + seed

**Files:** modify `src/execution/types.ts`, `src/execution/execution-store.ts`, `src/execution/execution-service.ts`, `test/execution/execution-service.test.ts`.

**Steps:**

1. Sửa test kỳ vọng execution directory có `context/`.
2. Mở rộng `ExecutionArtifactPaths` với 4 path mới.
3. `mkdir` `context/` trong staging trước `rename`; assert mode `0700` trên POSIX.
4. `ExecutionService.prepare()` seed checkpoint (`objective = capsule.task`) + render continuity sau `store.create()`.
5. Giữ deny-first: execution bị từ chối không tạo `context/`.

**Test:** `npm test -- test/execution/execution-service.test.ts`

**Xong 2026-09-04.** Bước 4 ("seed checkpoint + render continuity") kéo theo cả
`src/context/continuity.ts` (đúng là Task 2.1, đứng sau trong roadmap) vì `prepare()` không
có gì để gọi nếu renderer chưa tồn tại — làm luôn cho đúng thứ tự phụ thuộc thật, thay vì viết
một renderer tạm rồi ném đi. `test/context/continuity.test.ts` (7 test) coi như xong luôn ở
đây; Task 2.1 phía dưới chỉ còn việc treo cờ "đã xong" khi tới lượt.

Hằng số sentinel interactive (`"Interactive principal session; the task arrives from the
principal."`) được kéo ra khỏi `run-main.ts` thành `INTERACTIVE_TASK_SENTINEL` xuất từ
`continuity.ts` — renderer phải so khớp đúng chuỗi đó để bỏ qua objective, hai bản sao cùng
một hằng số là chỗ chờ drift, nên chỉ giữ một.

Fixture ID trong test cũ dùng `exec-immutable` (gạch ngang) — qua được `assertExecutionId`
lỏng của `execution-store.ts` nhưng không qua nổi regex `^exec_[a-zA-Z0-9_-]+$` chặt hơn mà
`checkpoint.ts` dùng (khớp production thật: `exec_${randomUUID()...}`). Đổi ID trong test
sang `exec_immutable`; đây là chỗ hai lớp validate trong cùng codebase vốn đã không đồng nhất
từ trước, không phải lỗi mới.

### Task 1.3: Journal + reducer

**Files:** create `src/context/compact-journal.ts`, `test/context/compact-journal.test.ts`.

**Steps:**

1. Test envelope schema, append, replay `.1` + current.
2. Test reducer: completion bình thường; duplicate; completion không start; late completion cho event cũ; start còn treo → `pending`.
3. Test `completed` tăng generation đúng một lần, kể cả khi journal có nhiều dòng cùng dedupeKey.
4. Test dòng hỏng bị bỏ mà state vẫn tính được.
5. Test rotation ở 1 MiB và replay xuyên rotation.
6. Implement dedupeKey: `runtime|sessionId|eventId|phase`, fallback fingerprint bounded của `source`.

**Test:** `npm test -- test/context/compact-journal.test.ts`

**Xong 2026-09-04.** 9 test. `dedupeKey` không tự cài lại lần hai trong journal — tái dùng
nguyên hàm `normalizeCompactEvent()` đã có từ Task 0.2, gọi không kèm `sequence` (đó là tham
số chỉ có ý nghĩa cho ca `exec` của Codex đã test riêng ở `compact-payload.test.ts`; ghép nó
vào journal replay là việc chưa ai yêu cầu — YAGNI). Khoá ghép cặp start/complete (`pairKey`)
là chính `dedupeKey` bỏ đoạn `|phase` cuối, không phải logic tính lại: tránh hai nơi phải đồng
bộ định nghĩa "danh tính một compaction".

Reducer chỉ theo dõi **một** pending duy nhất — start mới luôn đè start cũ chưa khớp, và một
completed chỉ dọn pending khi `pairKey` khớp đúng cái đang treo. Test "orphaned PreCompact"
(đo thật trên Claude 2026-09-04, xem gate CB-0) chính là ca này: pre1 treo mãi, pre2 đến sau
thay chỗ, post đóng pre2 — cuối cùng `pending: null`, không phải "hai cái cùng treo".

**Commit:** `feat(context): add continuity checkpoint and compact journal`

---

## Phase CB-2 — Producer và reinjection

**Priority:** P1 · **Estimate:** 1 day

### Task 2.1: Continuity renderer

**Files:** create `src/context/continuity.ts`, `test/context/continuity.test.ts`.

**Steps:**

1. Snapshot test thứ tự section cố định.
2. Test section rỗng biến mất; checkpoint hoàn toàn rỗng → chuỗi rỗng (session-boot sẽ bỏ qua).
3. Test objective bằng sentinel interactive thì không render.
4. Test 24 KiB bound giữ Decisions/Constraints trước, bỏ pin cũ nhất trong section trước.
5. Test không có đường nào để summary/content field lọt vào.

**Xong 2026-09-04, làm sớm trong Task 1.2** (`ExecutionService.prepare()` cần renderer thật
để seed `continuity.md`, xem ghi chú ở Task 1.2). 7 test, cả 5 bước trên đều có. Thứ tự cắt
khi vượt 24 KiB là danh sách rời `nextActions → openItems → objective → constraints →
decisions`, cắt hết một mục mới sang mục kế; objective bị bỏ nguyên khối (không có gì nhỏ hơn
để cắt từ một chuỗi objective).

### Task 2.2: Agent producer

**Files:** modify `src/runtime/render-session-context.ts`, `test/runtime/render-session-context.test.ts`.

**Steps:**

1. Test failing: role có `Bash` thấy continuity section; role không có thì không.
2. Implement `continuitySection()` theo đúng khuôn `delegationSection()` — cùng vị trí gating, cùng giọng.
3. Test section nêu đúng cả 4 kind pin và không dạy identity flag nào.
4. Test snapshot session context cũ chỉ thêm đúng khối này.

### Task 2.3: Hook entrypoint

**Files:** create `hooks/compact-record.cjs`, `test/hooks/compact-record.test.ts`.

**Steps:**

1. Viết hook zero-dependency: `readFileSync(0)` giới hạn 1 MiB, parse, whitelist, `appendFileSync`, exit 0.
2. Test: payload hợp lệ ghi đúng một dòng; JSON hỏng ghi `parseError` không kèm nội dung; input 2 MiB bị từ chối; thiếu `ALP_DELEGATION_EXECUTION_ID` → exit 0, không ghi gì; executionId sai regex → exit 0, không ghi gì; journal read-only → exit 0.
3. Test hook **không** đụng `checkpoint.json` và `continuity.md`.
4. Test hai process hook chạy song song → hai dòng nguyên vẹn (invariant 4).
5. Pin exit code và stdout rỗng.

**Test:** `npm test -- test/hooks/compact-record.test.ts test/context`

### Task 2.4: SessionStart reinjection

**Files:** modify `hooks/session-boot.cjs`, `src/runtime/adapter-files.ts`, `test/hooks/session-boot.test.ts`.

**Steps:**

1. Test failing: session context + continuity gộp thành đúng một `additionalContext`.
2. Test continuity thiếu / rỗng / hỏng / oversize → fallback về chỉ session context, có warning.
3. Thêm `ALP_CONTINUITY_CONTEXT`, `ALP_POLICY_HASH`, `ALP_COMPACT_EVENTS` vào `baseRuntimeEnvironment` (đổi signature nhận `artifacts`).
4. Giữ fallback `.alp/agents/<role>.md` cho native direct launch.
5. Xác nhận không sinh positional task.
6. Giữ hook không load `dist/`.

**Commit:** `feat(context): seed, record and reinject continuity`

---

## Phase CB-3 — Runtime adapter integration

**Priority:** P1 · **Estimate:** 0.75 day

### Task 3.1: Flag + Claude

**Files:** modify `src/runtime/adapter-files.ts`, `src/runtime/runtime-adapter.ts`, `src/runtime/claude-adapter.ts`, `test/runtime/runtime-adapters.test.ts`.

**Steps:**

1. Thêm `compactBridgeEnabled(env)` và `CompactCapabilities` vào contract adapter.
2. Test failing: `ALP_COMPACT_BRIDGE=1` → settings có `PreCompact`/`PostCompact`; không set → không có.
3. Dùng matcher đo được ở CB-0 cho manual và auto.
4. Dùng lại `hookCommand()` sẵn có.
5. Continuity file vào `env`, **không** vào `temporaryFiles` (nếu vào sẽ bị cleanup xoá).
6. Chứng minh interactive launch vẫn không có task file/argument.

### Task 3.2: Codex

**Files:** modify `src/runtime/codex-adapter.ts`, `src/cli/alp.ts`, `test/runtime/runtime-adapters.test.ts`.

**Steps:**

1. Chỉ thêm event CB-0 xác nhận; capability không có thì báo `false` và test kỳ vọng persist-only.
2. Giữ nguyên interpreter không quote trên Windows của Codex.
3. Truyền `hooksDirectory` cho `CodexRuntimeAdapter` trong `defaultDependencies` (hiện chỉ Claude được truyền; Codex đang dựa vào `ALP_REPO_ROOT` do `scripts/alp.cjs` set — thêm hai hook nữa thì phụ thuộc ngầm này thành rủi ro thật).
4. Parity assertion cho hook command và env giữa hai runtime.

### Task 3.3: Conformance matrix

```text
runtime      claude | codex
mode         interactive | headless
platform     POSIX | Windows quoting fixture
flag         off | on
continuity   empty | populated | corrupt
```

**Test:** `npm test -- test/runtime/runtime-adapters.test.ts test/hooks/session-boot.test.ts`

Kỳ vọng: cú pháp khác nhau theo runtime; checkpoint logic và invariant zero-turn giống nhau.

**Commit:** `feat(runtime): wire compact bridge into claude and codex`

---

## Phase CB-4 — CLI

**Priority:** P1 · **Estimate:** 0.75 day

### Task 4.1: Parser + read commands

**Files:** modify `src/cli/alp.ts`, create `src/cli/commands/context.ts`, `test/cli/alp-context.test.ts`.

**Steps:**

1. Test parse cho status / validate / pin / unpin; reject kind lạ, thiếu `--`, text rỗng, execution ID mơ hồ.
2. Thêm `contextCommand` vào `AlpDependencies`; thêm dòng vào `helpText()`.
3. `status` in generation, pending/last-completed, trigger, usage, restore mode — không dump history.
4. `validate` kiểm checkpoint schema + digest + policy binding, mọi dòng journal, và replay ổn định; báo số dòng hỏng.
5. `status`/`validate` rotate journal khi vượt 1 MiB.

### Task 4.2: Pin mutations

**Files:** modify `src/cli/commands/context.ts`, `test/cli/alp-context.test.ts`.

**Steps:**

1. Resolve execution ID tường minh hoặc từ env; `source` = `agent` khi có `ALP_DELEGATED_ROLE`, ngược lại `principal`.
2. Add pin với UUID ổn định; sanitize control character; enforce 4 KiB.
3. Cập nhật checkpoint và rerender continuity atomic trong cùng một lệnh.
4. `unpin` chỉ xoá đúng ID; ID không tồn tại → exit non-zero, checkpoint không đổi.
5. Test pin không đụng journal và không đụng transcript.

**Test:** `npm test -- test/cli/alp-context.test.ts test/cli/alp.test.ts`

**Commit:** `feat(cli): add alp context checkpoint commands`

---

## Phase CB-5 — E2E và docs

**Priority:** P1 · **Estimate:** 0.5–1 day

### Task 5.1: Happy path

**Files:** modify `test/e2e/harness.ts`, create `test/e2e/compact-continuity.test.ts`.

Fake runtime học thêm một chế độ: đọc fixture payload từ env và gọi thẳng `compact-record.cjs`.

**Scenario:**

1. Prepare interactive main execution → checkpoint seeded, continuity render được.
2. SessionStart đầu tiên có identity, không có synthetic task.
3. `alp context pin decision` + `pin constraint`.
4. Phát PreCompact fixture, rồi PostCompact fixture (có event ID).
5. SessionStart(compact) → continuity chứa cả hai pin.
6. Generation = 1; `pending` = `null`.
7. Native summary/content không xuất hiện ở đâu trong `context/`.
8. `policyHash` không đổi.
9. Chạy cùng fixture logic cho cả Claude và Codex.

### Task 5.2: Failure E2E

- Checkpoint hỏng → không inject, session vẫn chạy.
- Journal có dòng rác → `status` vẫn ra state, `validate` báo dòng.
- Hook bị kill giữa write → bản cũ nguyên vẹn.
- Duplicate và out-of-order completion.
- Start không có completion → `pending`, không có `completed` giả.
- Reinjection không được hỗ trợ → `restore: next-session`.
- Hai lần compact liên tiếp → generation 1 rồi 2.
- Compact rồi Stop bình thường → `session-end.cjs` finalize như cũ.
- Flag off → không hook nào được đăng ký, mọi thứ khác không đổi.

### Task 5.3: Docs

**Files:** modify `docs/architecture.md`, `README.md`.

Ghi: ranh giới ownership; storage layout; lệnh `alp context`; cảnh báo privacy (đừng pin secret); bảng capability theo runtime; giới hạn restore; cách chạy live probe.

`docs/architecture.md` giữ dưới 800 dòng theo house rule — cắt gọn nếu cần.

### Final verification

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

**Commit:** `docs(context): document cross-runtime compact bridge`

---

## 17. Acceptance criteria

1. Session mới có `checkpoint.json` với `objective` từ capsule task, không cần ai gõ lệnh.
2. Role có `Bash` nhìn thấy hướng dẫn pin trong session context; role read-only thì không.
3. Claude manual compact giữ và reinject pin; auto compact đi cùng đường.
4. Codex hoặc verified tương đương, hoặc được đánh dấu persist-only một cách trung thực.
5. Hai lần compact liên tiếp → generation 1, 2; replay journal ra cùng state và cùng usage.
6. Không compact lifecycle nào sinh user message hay positional prompt.
7. Native transcript chỉ do runtime sửa.
8. Checkpoint sống sót cleanup `runtime/`.
9. Checkpoint hỏng không bao giờ được inject.
10. Hook bị kill không làm hỏng dữ liệu đã ghi.
11. Truy cập cross-execution thất bại.
12. `ALP_COMPACT_BRIDGE` unset → hành vi giống hệt trước milestone này.
13. Toàn bộ test suite hiện có vẫn xanh.
14. Có bằng chứng probe ghi rõ version Claude/Codex đã test.

---

## 18. Rollout

| Stage | Nội dung |
|---|---|
| 1 | Ship core + probe, `ALP_COMPACT_BRIDGE` mặc định off. Thu bằng chứng contract thật. |
| 2 | Claude opt-in: `ALP_COMPACT_BRIDGE=1`. Theo dõi latency hook, số checkpoint hỏng, kích thước continuity. |
| 3 | Codex opt-in, chỉ những capability CB-0 chứng minh. Không ép parity bằng assertion. |
| 4 | Default on: đổi default trong `compactBridgeEnabled()` sau khi cả hai runtime qua E2E và ít nhất một smoke test manual + auto thật trên mỗi họ OS. |

Rollback là một biến môi trường. `SessionStart`/`Stop`, native compact và execution state không đổi.

---

## 19. Deferred

Chỉ cân nhắc sau khi bridge ổn định:

- **V1.1 — `alp context refresh`:** launch một headless execution của agent `compaction` (đã tồn tại, output contract đã trùng field set của checkpoint) để đề xuất pins có cấu trúc; principal duyệt. Chạy ngoài compact hook, tốn một model call.
- **V1.2 — Delegation continuity:** parent truyền pins đã chọn sang child; child trả structured outcome. Không copy transcript.
- **V1.3 — Memory promotion:** promote pin đã chọn vào `MemoryService` qua policy grant. Không auto-promote native summary.
- **V2 — Managed context runtime:** chỉ mở lại ý tưởng assemble/prune per turn nếu ALP chuyển sang transport mà nó thực sự sở hữu event loop. Dự án khác, không phải mở rộng ngầm của bridge này.

---

## 20. Final decision

> **Claude Code và Codex thực thi và compact session. ALP giữ một checkpoint nhỏ, có nội dung thật, ở ngoài, và trả nó lại sau mỗi lần compact.**

Giá trị đến ngay trên kiến trúc hiện tại, dependency không tăng, và không hứa quyền kiểm soát mà một CLI launcher không có.

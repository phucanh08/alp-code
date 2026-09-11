# Review — P1 Thread as Unit of Work

**Ngày:** 2026-09-11  
**Repo:** `phucanh08/alp-code`  
**Mục tiêu:** chốt kiến trúc `Thread` như durable unit of work, tách khỏi `Execution` và `Process`, học đúng điểm mạnh của Amp nhưng giữ nguyên security boundary của ALP.

## 1. Kết luận

ALP đang thiếu một primitive nằm **trên Execution**, không thiếu thêm một Agent.

Primitive mới phải trả lời câu hỏi:

> Công việc này là gì, đã trao đổi gì, đã chạy bao nhiêu lần, context hiện tại là gì, và lần chạy tiếp theo phải tiếp tục từ đâu?

Trong khi các primitive hiện tại tiếp tục trả lời các câu hỏi khác:

- `AgentDefinition`: vai này là ai, được khai báo thế nào?
- `Thread`: unit of work lâu dài là gì?
- `Execution`: một lần chạy cụ thể được cấp quyền gì?
- `ExecutionGraph`: trong một lần chạy, execution nào gọi execution nào và budget/cancellation lan ra sao?
- `Runtime`: Claude/Codex/... được launch thế nào?
- `Process`: PID/process/backend lifecycle thực tế là gì?

Kiến trúc đích:

```text
AgentDefinition
      │
      │ declares role
      ▼
Thread T-1
├── durable identity / lifecycle
├── message + change references
├── thread context projection
├── compaction history
├── parentThreadId (provenance only)
└── root execution history
      │
      ├── Execution E-1 ── ExecutionGraph G-1 ── Runtime ── Process
      ├── Execution E-2 ── ExecutionGraph G-2 ── Runtime ── Process
      └── Execution E-3 ── ExecutionGraph G-3 ── Runtime ── Process
```

**Không** biến `ExecutionGraph` thành Thread. Mỗi root execution continuation của Thread có graph riêng; delegated children thuộc graph đó.

## 2. Nguồn tham chiếu

### Amp

Amp hiện mô tả Thread là một conversation gồm prompt, reply, tool calls và changed files; Thread là unit of work. Cùng một Thread có thể mở từ web, CLI, app và Slack; nơi agent chạy được tách khỏi nơi user quan sát/tương tác. Amp cũng hỗ trợ tiếp tục một Thread bằng ID từ CLI và chạy Thread trên local/orb/runner.

Tham chiếu:
- https://ampcode.com/docs/threads
- https://ampcode.com/docs/cli
- https://ampcode.com/docs/cli/runners
- https://ampcode.com/docs/cli/remote-control
- https://ampcode.com/docs/orbs

### ALP hiện tại

Các boundary đã có và phải giữ:

- `src/execution/types.ts`: `ExecutionPolicy`, `IdentityCapsule`, `StoredExecutionState`.
- `src/execution/execution-service.ts`: authorize → materialize.
- `src/execution/graph/*`: durable execution tree, reservation, limits, deadline, reconciliation, cascade cancellation.
- `src/backend/execution-backend.ts`: một backend execution/process.
- `src/cli/commands/run-main.ts`: hiện mỗi interactive invocation sinh một root execution mới.
- `src/context/*`: continuity/compaction đang scoped theo execution.
- `plans/260911-0623-execution-graph/*`: P0 đã chốt graph logical authority, backend process authority.
- `plans/260903-2040-cross-runtime-compact-bridge/*`: runtime vẫn sở hữu raw native conversation; ALP sở hữu policy/continuity bridge.

## 3. Scope challenge

### Nếu không làm

ALP sẽ tiếp tục đồng nhất “một lần chạy runtime” với “một công việc”. Hậu quả:

- không có identity bền vững qua nhiều lần chạy;
- đổi Claude → Codex đồng nghĩa mất unit-of-work chung;
- reconnect/continue chỉ có thể dựa vào provider-native session;
- UI/web/mobile/cloud sau này buộc phải bám vào process/runtime;
- execution history không có aggregate cấp task;
- context cross-execution phải vá bằng memory hoặc provider transcript, sai abstraction.

### Tối thiểu phải làm

P1 cần đủ để:

1. tạo Thread bền vững;
2. bind immutable Execution vào Thread;
3. một Thread có nhiều root Execution theo thứ tự;
4. context từ E-1 handoff sang E-2 mà không cần cùng process/runtime;
5. có normalized history đủ để Thread không chỉ là `executionId[]`;
6. tiếp tục Thread từ CLI bằng Thread ID;
7. giữ nguyên execution policy/capability/cancellation security model;
8. có future seam cho web/mobile/remote executor nhưng không xây cloud runtime ở P1.

## 4. Quyết định kiến trúc

### D1 — Thread nằm trên Execution Graph

`Thread` không sở hữu child execution trực tiếp. Thread chỉ giữ `rootExecutionRefs`.

```text
Thread
└── rootExecution E-2
    └── ExecutionGraph G-2
        ├── E-2 main
        ├── E-2a search
        └── E-2b review
```

Lý do: nếu Thread giữ mọi execution phẳng, nó trùng trách nhiệm của graph và phá parent/depth/cancellation semantics.

### D2 — `parentThreadId` không phải authority

`parentThreadId` chỉ mô tả fork/handoff lineage.

Nó **không**:
- cấp capability;
- kế thừa workspace write;
- quyết định `delegatesTo`;
- cascade cancel;
- cộng depth;
- thay `parentExecutionId`.

### D3 — Security vẫn Execution-scoped

Mỗi Execution tiếp tục materialize immutable:

```text
ExecutionPolicy
IdentityCapsule
definitionHash
policyHash
```

P1 thêm immutable provenance:

```ts
thread: {
  id: ThreadId
  contextRevision: number
  contextDigest: string
}
```

Field này được hash cùng policy snapshot để execution không thể bị attach sang Thread khác bằng metadata mutation.

**Quan trọng:** `thread.*` không bao giờ được PolicyEngine dùng để mở rộng quyền.

### D4 — Thread status không duplicate process status

Durable lifecycle:

```ts
type ThreadStatus = "open" | "closed" | "archived"
```

`running/idle/failed` là **derived activity**, lấy từ root execution/graph/backend gần nhất. Không lưu hai nguồn truth cho cùng một lifecycle.

### D5 — P1 linear Thread: tối đa một active root execution

Trong một Thread, P1 chỉ cho một root execution active tại một thời điểm.

Delegated executions bên trong graph vẫn concurrent theo graph limits.

Lợi ích:
- không có concurrent thread-context writers;
- execution sequence xác định;
- `continue` có semantics rõ;
- không phải giải branch/merge context ngay P1.

Fork song song dùng Thread mới với `parentThreadId`.

### D6 — Continuity execution-scoped vẫn giữ nguyên

`ContinuityCheckpointV1` hiện tại không đổi ownership.

Thêm `ThreadContextSnapshotV1` để handoff **giữa executions**.

```text
ThreadContext
   ↓ seed
Execution checkpoint
   ↓ completion projection
next ThreadContext revision
```

Không rename checkpoint hiện tại thành Thread context.

### D7 — Không coi native provider transcript là canonical Thread store

P1 thêm normalized Thread history riêng.

Raw Claude/Codex transcript vẫn runtime-owned. ALP chỉ mirror những gì có thể thu thập đáng tin cậy, kèm `completeness`.

Nếu runtime không export được đầy đủ tool call:
- ghi final response/change refs;
- đánh dấu `partial`;
- không fabricate history.

### D8 — Không duplicate secrets vào Thread

Thread history chỉ lưu:
- user/assistant message canonical;
- redacted tool metadata;
- artifact/change refs/digests;
- execution outcomes.

Raw tool input/output nhạy cảm vẫn nằm trong execution/runtime artifact nếu provider có lưu, không copy nguyên khối vào Thread.

### D9 — Thread không chọn nơi process chạy

ThreadService yêu cầu “start/continue execution”; placement vẫn đi qua execution/runtime/backend boundary.

P1 chỉ triển khai local backend hiện tại.

Không thêm `Orb`, scheduler, cloud queue hay daemon chỉ để có Thread.

### D10 — Bare `alp` vẫn dễ dùng

Sau cutover:

```text
alp
  -> tạo Thread mới
  -> tạo root Execution #1
  -> launch interactive runtime

alp thread continue thread_x
  -> đọc Thread context
  -> tạo root Execution #2
  -> có thể chọn mode/model khác
  -> launch runtime
```

Một Thread có thể:

```text
E-1 Claude investigate
E-2 Codex implement
E-3 Claude review
```

mà `thread_x` không đổi.

## 5. Những gap hiện tại phải giải đúng

### Conversation ownership gap

`run-main.ts` đang dùng interactive `stdio: inherit`; first user prompt đi thẳng vào native runtime. Vì vậy ALP hiện không tự nhiên nhìn thấy mọi turn.

Không được claim full Thread parity chỉ vì có `thread.json`.

P1 phải có runtime-history bridge capability và integration probes trước khi bật “complete history”.

### Crash window

Flow mới có nhiều durable object:

```text
Thread reservation
ExecutionGraph root
Execution artifacts
Backend process record
```

Thứ tự và recovery phải rõ; không dual-write mù.

### Context/policy confusion

Thread context là model input, không phải security policy. Nội dung Thread có thể bị prompt-injection; runtime permission vẫn fail-closed theo immutable ExecutionPolicy.

## 6. Quan hệ với plan khác

### Execution Graph

`260911-0623-execution-graph` đã xong và là prerequisite đã thỏa.

Thread dùng graph, không sửa graph thành unit-of-work.

### Cross-runtime compact bridge

Tái sử dụng:
- execution checkpoint;
- compact journal;
- adapter/hook knowledge.

Nhưng Thread context là layer mới phía trên, không thay execution continuity.

### Native Binary Distribution

Plan `260907-2322-native-binary-distribution` còn pending và đụng:
- CLI bootstrap;
- `run-main`;
- state paths;
- migration/state preservation.

Khuyến nghị: Thread P1 **blocks** Native Binary. Sau khi principal duyệt Thread plan, cập nhật `blockedBy` của Native Binary để tránh đóng distribution contract trước khi thêm `~/.alp/threads`.

## 7. Red-team summary

### CHẶN nếu không xử lý

1. Thread store cấp quyền hoặc PolicyEngine đọc mutable Thread state.
2. `parentThreadId` được dùng như parent execution.
3. Hai active root execution cùng update Thread context.
4. Claim complete history khi adapter không thu được đầy đủ native transcript.

### NÊN SỬA trong P1

1. Root execution history dùng typed refs, không `ExecutionId[]` thô.
2. Thread lifecycle status tách derived activity.
3. Thread binding nằm trong immutable execution snapshot.
4. Crash recovery có reservation/reconcile.
5. Thread content được đánh dấu untrusted relative to policy.
6. Tool history phải redact/minimize.

## 8. Phán quyết

**GO — nhưng triển khai thành một domain mới `src/thread/`, không mở rộng `ExecutionGraph` thành Thread và không xây thêm Agent.**

Plan triển khai: `plans/260911-1811-thread-unit-of-work/`.

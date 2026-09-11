---
title: Thread
description: Một việc kéo dài qua nhiều lượt chạy, nhiều runtime, nhiều tiến trình — mà mỗi lượt vẫn là một snapshot quyền độc lập.
---

> **Một câu:** Thread là **một việc** (`thread_…`) — nó sống qua nhiều [execution](../execution/), nhiều runtime, nhiều tiến trình; còn mỗi execution trong nó vẫn là một lượt chạy có policy riêng, hash riêng, và không thừa kế quyền từ Thread.

## Vì sao cần một tầng nữa

Trước Thread, "phiên" của ALP là một execution: gõ `alp`, làm việc, đóng terminal — hết. Muốn làm tiếp việc hôm qua thì mở một execution mới và kể lại từ đầu, hoặc dựa vào `--resume` của runtime, thứ chỉ hoạt động khi runtime hôm nay đúng là runtime hôm qua.

Thread tách hai câu hỏi đã bị gộp:

| Câu hỏi | Ai trả lời |
|---|---|
| *Việc gì đang làm, tới đâu rồi?* | **Thread** |
| *Lượt chạy này được phép làm gì?* | **Execution** — như trước, không đổi |

Tách ra thì một việc bắt đầu bằng Claude Code có thể tiếp tục bằng Codex CLI ở lượt sau, vì thứ đi tiếp không phải transcript của runtime mà là một bản chiếu context do ALP giữ.

## Bảy khái niệm, một dòng mỗi cái

```text
AgentDefinition = vai, khai báo trong code       Execution      = một lượt chạy đã authorize, bất biến
Thread          = một việc, bền, nhiều lượt      ExecutionGraph = cây delegation/huỷ của MỘT lượt chạy
Runtime         = adapter / CLI của model         Process        = tiến trình OS do backend sinh
Memory          = tri thức dùng lại qua nhiều Thread
```

Hai ranh giới hay nhầm:

- **Thread ≠ ExecutionGraph.** Graph là cây của *một* root và các con nó uỷ quyền; Thread là *chuỗi* các root. Con được uỷ quyền nằm trong graph của cha, **không** nằm trong `executions` của Thread — nó thừa kế binding Thread từ node cha để hook và `alp thread show` tìm được, chỉ thế thôi.
- **Thread ≠ Memory.** Thread là một việc; [Memory](../memory/) là thứ đáng nhớ qua nhiều việc. Đóng Thread **không** tự ghi memory.

## Thread không phải nguồn quyền

Đây là invariant, không phải mô tả:

- `PolicyEngine` **không đọc** Thread. Không có đường code nào từ `thread.json` tới `allowedTools`, `workspace`, `delegatesTo`.
- Policy của mỗi root mang một **binding** `{ id, contextRevision, contextDigest }` — và binding đó được **hash** vào `policyHash`. Thread là input của snapshot, không phải thứ snapshot tra cứu sau này.
- Sửa `thread.json` để "xin thêm tool", đặt `parentThreadId` trỏ tới một Thread khác, hay pin một dòng context viết như policy — root kế tiếp nhận đúng quyền như root trước. Có test cho từng cách.
- `ALP_THREAD_ID` trong env chỉ là **nhãn** để `alp thread show` không đối số biết hỏi Thread nào. Đặt nó bằng tay không đổi gì.

Ghép policy của Thread A vào Thread B — `collectHistory`/`settle` với một execution không thuộc Thread — bị từ chối bằng `THREAD_EXECUTION_BINDING_MISMATCH`.

## Vòng đời một Thread

```text
alp [--title "…"]          → Thread mới (LUÔN mới; bare `alp` không bao giờ nối vào Thread cũ)
   └─ root #1  exec_a  claude   reserve → chạy → settle → project  → context rev 1
alp thread continue <id>   → root #2  exec_b  codex    mở trên rev 1 → … → context rev 2
alp thread continue <id>   → root #3  exec_c  claude   mở trên rev 2 → …
alp thread close <id>      → closed   (không reopen)
alp thread archive <id>    → archived (chỉ từ closed)
```

Mỗi root là một `ThreadExecutionRef` với `sequence` tăng dần, `contextRevision` nó mở trên, và `settled` ghi kết cục. Một Thread có **tối đa một** root chưa settle: `continue` khi đang có root chạy bị từ chối bằng `THREAD_BUSY`, và hai `continue` đồng thời thì đúng một cái thắng — cái kia nhận `THREAD_REVISION_CONFLICT`, không có lost update.

## `continue` nghĩa là gì — và không nghĩa là gì

`alp thread continue` mở **một execution mới**: ID mới, `policy.json` mới, `policyHash` mới, tiến trình mới, và runtime theo nấc bạn chọn lúc đó — có thể khác runtime của lượt trước.

Nó **không** attach vào tiến trình cũ, **không** gọi `--resume`, **không** truyền session ID của runtime. Cái duy nhất lượt sau nhận từ lượt trước là **context snapshot** của Thread, tiêm vào `session-context.md` dưới tiêu đề *"work state, not authority"* và seed vào [checkpoint](../continuity/) của execution mới.

Vì thế "reconnect" trong ALP là nối lại *việc*, không nối lại *phiên*. Một phiên interactive đang chạy thì bạn đã ở trong nó rồi; một phiên đã chết thì không có gì để attach.

## Context: bản chiếu bất biến theo revision

Khi một root settle, Thread **chiếu** (project) checkpoint của nó thành một snapshot mới:

| | |
|---|---|
| Đầu vào | Snapshot rev *n* + `checkpoint.json` của root vừa xong + kết cục của nó |
| Đầu ra | Snapshot rev *n+1*, file `context/<n+1>.json`, `digest` sha256 canonical |
| Nội dung | objective, `decisions`, `constraints`, `openItems`, `nextActions`, `outcomes` — mỗi dòng ghi `sourceExecutionId` |
| Trần | 32 KiB; quá thì cắt tất định, ghi một `ThreadCompactionRecord` với đủ provenance |
| `degraded` | `true` khi checkpoint nguồn mất hoặc hỏng hash — chỉ kết cục đi tiếp, pin của lượt đó không bao giờ tới |

Nguồn duy nhất mà projector nhìn thấy là **pin**: `alp context pin decision -- "…"` trong lượt này là thứ lượt sau đọc được. Không pin thì lượt sau chỉ biết kết cục.

Chuỗi digest `rev0 → rev1 → rev2` nằm trong binding của từng root, nên `policy.json` của root #3 tự chứng minh nó mở trên đúng snapshot nào. Snapshot đổi sau khi đọc → `THREAD_CONTEXT_TAMPERED`.

## History: bản ghi có thật, không bịa

Sau khi một root settle, ALP hỏi runtime của nó xem transcript còn đọc được không và chép các entry vào `messages/<seq>.json`, kèm mức đầy đủ:

| `history` | Nghĩa |
|---|---|
| `complete` | Đọc được toàn bộ transcript native |
| `partial` | Đọc được một phần (file xoay, một số dòng hỏng — đếm trong `skipped`) |
| `final-only` | Không đọc được transcript; chỉ có kết cục |
| `unsupported` | Runtime không có transcript ALP biết đọc |

Mức của cả Thread là **mức xấu nhất** trong các root. `alp thread sync` chạy lại việc chép cho mọi root đã settle, và chạy lại thì **không** nhân đôi entry: mỗi entry có ID theo ID native của runtime.

Text tool input đi qua bộ lọc secret trước khi ghi. Đây là bản ghi để tra, không phải nguồn context — projector không đọc `messages/`.

## Trên đĩa

```text
~/.alp/threads/<thread_id>/
  thread.json          index: status, revision, executions[], currentContext, messages[], compactions[]
  context/<rev>.json   snapshot của từng revision, bất biến, có digest
  messages/<seq>.json  entry history, mỗi cái một digest
  compactions/*.json   bản ghi mỗi lần cắt context
  .lock/               lease liên tiến trình
```

Thư mục `0700`, file `0600`, ghi temp → rename → chmod như execution. `thread.json` có `revision` và mọi lần ghi phải là `previous + 1` dưới lease. Lease Thread và lease Graph **không bao giờ lồng nhau** — mỗi bước giữ đúng một cái — nên không có deadlock giữa `continue` và `delegate`.

`get(id)` mở thẳng thư mục theo ID; `list` mới quét. Không có Thread "mới nhất" được đoán ngầm.

## Execution cũ, không có Thread

Graph và policy ghi trước ngày cutover không có key `thread`. Chúng đọc lên là `thread: null`, `alp delegation tree` in `thread legacy-unthreaded`, và ALP **không** dựng Thread giả cho chúng. Mọi root `alp` sau cutover đều có Thread; con được uỷ quyền mang đúng binding của cha.

## Kiểm chứng

```bash
alp thread list                 # Thread mở trong workspace này
alp thread show <thread-id>     # reconcile trước, rồi in execution + context + history
alp thread context <thread-id>  # snapshot hiện tại, từng dòng kèm execution nguồn
alp thread reconcile <thread-id>
alp thread sync <thread-id>
```

`show` luôn reconcile trước: câu "còn chạy không" đến từ graph và backend, không từ ref mà một tiến trình đã chết để lại. Một root mà tiến trình biến mất trước khi settle được đóng `interrupted` — và `continue` sau đó chiếu nốt context của nó rồi mới mở root mới, nên không mất revision.

## Liên quan

- [Execution](../execution/) — một root của Thread là gì trên đĩa
- [Execution graph](../execution-graph/) — cây con của một root; con không thuộc Thread
- [Checkpoint và continuity](../continuity/) — lớp *trong* một execution mà Thread chiếu ra
- [Memory](../memory/) — thứ sống qua nhiều Thread

---
title: Checkpoint và continuity
description: Objective và pin sống qua compaction — một file, hai người ghi, một hash toàn vẹn.
---

> **Một câu:** Continuity là **những gì một execution không được phép quên khi runtime nén transcript của chính nó** — một objective và bốn loại pin, giữ ngoài context window.

Runtime tự compact khi gần hết cửa sổ, và việc nén đó là của runtime chứ không phải của ALP. ALP chỉ giữ một checkpoint nhỏ bên ngoài, rồi tiêm lại sau mỗi lần nén.

## Continuity không phải Thread context, không phải memory

| | Continuity | [Thread context](../thread/) | [Memory](../memory/) |
|---|---|---|---|
| Phạm vi | **Một** execution | **Một** Thread, nhiều execution | Xuyên Thread |
| Sống được bao lâu | Tới khi execution kết thúc | Tới khi Thread archive | Tới khi bị xoá |
| Địa chỉ | `context/checkpoint.json` của execution đó | `~/.alp/threads/<id>/context/<rev>.json` | Logical ID có scope |
| Ai ghi | `prepare()` seed, `alp context pin` sửa | Chiếu tất định từ checkpoint khi root settle | Agent có grant `memory` |
| Trả lời | "Lượt này đang làm dở gì" | "Việc này tới đâu rồi" | "Ta biết những gì" |

Một quyết định kiến trúc quan trọng thuộc về **memory**. Một blocker của chiều nay thuộc về **continuity** — và nếu bạn pin nó, lượt sau của cùng Thread nhận được nó qua **Thread context**. Pin là đường duy nhất từ lượt này sang lượt sau: projector không đọc transcript.

Checkpoint của một root mới không rỗng: ngoài `objective`, nó được seed bằng các pin từ snapshot Thread mà root đó mở trên. Đó vẫn là work state — bảng quyền ở đầu `session-context.md` không đổi vì bất kỳ dòng nào trong đó.

## `checkpoint.json`

```jsonc
{
  "version": 1,
  "executionId": "exec_abc123",
  "policyHash": "…",
  "runtime": "claude",        // null cho tới khi một adapter thật sự launch
  "createdAt": "…",
  "updatedAt": "…",
  "objective": "…",           // seed từ capsule.task
  "decisions":   [ /* pin */ ],
  "constraints": [ /* pin */ ],
  "openItems":   [ /* pin */ ],
  "nextActions": [ /* pin */ ],
  "integrity": { "checkpointSha256": "…" }
}
```

`objective` được seed từ `capsule.task`, và đó là thứ giữ cho một checkpoint mới không rỗng. Phiên interactive có task là một chuỗi sentinel thay vì nhiệm vụ thật — renderer nhận ra và bỏ qua nó, vì "phiên interactive, nhiệm vụ đến từ principal" không phải một objective đáng tiêm lại.

Ba trường từng có trong bản v1 nháp và **bị bỏ**: `generation` (suy ra từ journal, không lưu), `state` (trùng `openItems`), `evidence` (thuộc về một báo cáo, không thuộc về continuity).

## Đúng hai người ghi

`ExecutionService.prepare()` seed nó, và `alp context pin|unpin` sửa nó. **Không có writer thứ ba.**

Đây là một invariant, không phải một quan sát: một file mà bất kỳ ai cũng ghi được là một file mà không ai giải thích được nội dung. Runtime không ghi vào đây, hook `compact-record` không chạm vào đây, adapter cũng không.

## Bốn loại pin

| Loại | Dùng cho | Lệnh |
|---|---|---|
| `decision` | Lựa chọn đã chốt, kèm lý do | `alp context pin decision -- "…"` |
| `constraint` | Ranh giới không được vi phạm | `alp context pin constraint -- "…"` |
| `open-item` | Câu hỏi hoặc blocker chưa xong | `alp context pin open-item -- "…"` |
| `next-action` | Bước cụ thể tiếp theo | `alp context pin next-action -- "…"` |

Mỗi pin có `id` (UUID), `text`, `source` (`execution` / `principal` / `agent`) và `createdAt`. Gỡ bằng `alp context unpin <id>`.

Mỗi pin là **một câu**, không phải một bản tóm tắt — luật này được cưỡng chế ở CLI, nơi control character bị collapse và kích thước bị cắt.

| Giới hạn | Giá trị |
|---|---|
| Một pin | 4 KiB |
| Cả checkpoint | 128 KiB |
| Bản render tiêm vào context | 24 KiB |

:::danger[Không pin dữ liệu nhạy cảm]
Pin nằm trên đĩa và được tiêm **thẳng** vào context window sau mỗi lần compaction. Không pin secret, không pin nội dung file.
:::

## Hash toàn vẹn

`integrity.checkpointSha256` là SHA-256 của phần thân đã canonical hoá — key được sort đệ quy trước khi serialize, nên cùng dữ liệu luôn cho cùng digest bất kể thứ tự ghi.

`alp context validate` tính lại và so. Lệch nghĩa là file đã bị sửa ngoài hai writer hợp pháp, và đó là một finding, không phải một cảnh báo bỏ qua được.

## Cắt khi quá khổ

Bản render (`continuity.md`) có thứ tự section cố định: Objective → Decisions → Constraints → Open items → Next actions. Section rỗng bị bỏ hẳn.

Quá 24 KiB thì cắt theo thứ tự **ít chịu lực nhất trước**:

```text
nextActions → openItems → objective → constraints → decisions
```

Mỗi section bỏ **entry cũ nhất trước**, từng cái một, trước khi đụng tới section kế tiếp. Objective bị bỏ nguyên khối vì không có gì nhỏ hơn để bỏ bên trong nó.

Thứ tự này nói lên một quan điểm: một `next-action` lỗi thời là thứ rẻ nhất để mất, còn một `decision` đã chốt là thứ đắt nhất — quên nó là làm lại từ đầu một cuộc tranh luận đã xong.

Chỉ `executionId`, `objective` và `text` của từng pin tới được output. Không có trường nào trên `ContinuityCheckpointV1` để một bản tóm tắt do runtime tự sinh đi nhờ qua.

## Journal compaction

`context/compact-events.jsonl` là nhật ký thô, mỗi dòng một sự kiện, do hook `compact-record` nối vào. Nó **không** phải checkpoint, và không ai chuẩn hoá nó lúc ghi.

| | Giá trị |
|---|---|
| Một dòng tối đa | 16 KiB |
| Xoay vòng khi file đạt | 1 MiB → `…jsonl.1` |

Replay đọc `…jsonl.1` trước rồi tới file hiện tại. Một dòng hỏng JSON hoặc trượt schema bị **bỏ và đếm** (`droppedLines`), không làm hỏng cả lần replay — một lần append dở dang vì process bị giết không được phép làm cả nhật ký thành không đọc được.

## Ba con số của `context status`

`reduceCompactJournal` rút cả nhật ký thành ba thứ:

| | Nghĩa |
|---|---|
| `generation` | Đã hoàn tất bao nhiêu lần nén |
| `pending` | Một `started` chưa có `completed` khớp |
| `lastCompleted` | Lần nén hoàn tất gần nhất |

Sự kiện trùng `dedupeKey` — hook bị runtime chạy lại — bị gộp trước mọi thứ khác.

:::note[`pending` không phải lỗi]
Nó là trạng thái bình thường vì hai lý do đều đã đo được: một compaction bị bỏ dở (Claude, 2026-09-04: một `PreCompact` không bao giờ có `PostCompact`, rồi một cái thứ hai thì có), và trên Claude thì reinjection tới **trước** `PostCompact`.

Vì vậy `PostCompact` không phải chỗ an toàn để biết một lần nén đã xong. Đó là lý do `SessionStart(source="compact")` — điểm duy nhất cả hai runtime đồng ý — mới là chỗ tiêm lại.
:::

`trigger` có ba giá trị: `manual`, `auto`, và `unknown`. Hai cái đầu là đo được; `unknown` không phải một trạng thái đã thấy, nó là chỗ một payload méo hoặc payload của phiên bản tương lai rơi xuống — để một dòng lạ không làm hỏng cả lần replay.

## Cờ bật

Việc đăng ký hook `PreCompact`/`PostCompact` nằm sau `ALP_COMPACT_BRIDGE=1`. Render và tiêm continuity thì **luôn** hoạt động — chỉ phần nhật ký là có cờ.

## Kiểm chứng

```bash
alp context status                # trong một execution
alp context status exec_abc123    # từ terminal khác
alp context validate exec_abc123
```

Không có khái niệm "execution mới nhất" được đoán ngầm: hoặc bạn đang ở trong một execution, hoặc bạn nói rõ ID.

Exit khác `0` từ `validate` là một finding cần điều tra, không phải thứ để bỏ qua rồi chạy tiếp với một context không đáng tin.

## Liên quan

- [Execution](../execution/) — thư mục `context/` nằm ở đâu
- [Hook](../hook/) — ai ghi journal, ai tiêm lại
- [Thread](../thread/) — lớp giữa các execution, chiếu từ checkpoint
- [Memory](../memory/) — thứ sống lâu hơn một execution
- [Memory và continuity](../../guides/memory-and-continuity/) — hướng dẫn dùng hằng ngày

---
title: Execution
description: Một lượt chạy có ID, có snapshot quyền bất biến trên đĩa, và vòng đời tra được từ process khác.
---

> **Một câu:** Execution là **một lượt chạy** của một vai — có ID dạng `exec_…`, có quyền đã đóng băng thành file, và có trạng thái mà một tiến trình `alp` khác vẫn đọc được sau khi tiến trình sinh ra nó đã chết.

Câu cuối là lý do execution phải tồn tại trên đĩa chứ không chỉ trong bộ nhớ: `alp delegation status exec_abc123` gõ ở terminal thứ hai, mười phút sau, vẫn phải trả lời được.

Một execution là **một lượt**, không phải một việc. Việc — thứ kéo dài qua nhiều lượt — là [Thread](../thread/). Mỗi root `alp` mở là một execution mới trong một Thread; `alp thread continue` mở một execution mới nữa, không "nối" vào execution cũ.

## Ba artifact được sinh cho mỗi lượt

| Artifact | Là gì | Bất biến? |
|---|---|---|
| **`ExecutionPolicy`** → `policy.json` | Snapshot quyền tại thời điểm prepare, kèm `definitionHash` và `policyHash` | có |
| **`IdentityCapsule`** → `runtime/identity-capsule.json` | Bundle gửi cho runtime: instructions đã render, task, workspace, memory đã lọc, workflow state, `allowedTools` | có |
| **`StoredExecutionState`** → `state.json` | Trạng thái tiến triển và output cuối | không — đây là thứ duy nhất thay đổi |

`allowedTools` trong capsule là **giao** của capability grant và tool cho phép ở [workflow state](../workflow/) hiện tại. Runtime không nhận danh sách grant đầy đủ; nó nhận đúng tập dùng được lúc này.

## Hai hash, hai câu hỏi khác nhau

- `definitionHash` — băm của [definition](../agent/) đã canonicalize. Trả lời *"vai này có còn đúng là vai principal đã duyệt không"*. Nó **không** đổi theo nấc: nấc là lựa chọn lúc phóng, không phải một vai khác.
- `policyHash` — băm của chính snapshot, gồm cả `mode`, `model`, `reasoningEffort`, `runtime`. Trả lời *"lần chạy này chạy cái gì"*. Từ khi `settings.json` sửa được nội dung một nấc, tên nấc một mình không còn trả lời nổi câu đó — nên hai lần chạy khác model không thể có cùng `policyHash` dù cùng tên nấc.

## Binding Thread trong policy

Root của `alp` (và mọi con nó uỷ quyền) mang trong `policy.json`:

```jsonc
"thread": { "id": "thread_…", "contextRevision": 1, "contextDigest": "…" }
```

Ba trường này được **hash vào `policyHash`**: chúng nói lượt này mở trên snapshot nào của Thread, và chúng là input của snapshot chứ không phải một con trỏ policy tra cứu về sau. Không trường nào trong phần quyền — `allowedTools`, `workspace`, `delegatesTo`, `memory` — đọc từ Thread. Execution ghi trước khi có Thread có `"thread": null`.

## Trên đĩa

```text
~/.alp/executions/<exec_id>/
  policy.json          ExecutionPolicy snapshot                      (0600)
  state.json           StoredExecutionState                          (0600)
  runtime/             identity-capsule.json · session-context.md
                       skill-roots.json · config của runtime
                       + task.md CHỈ khi headless
  context/             sống sót cleanup của runtime/                 (0700)
    checkpoint.json      objective + pin, hash toàn vẹn              (0600)
    continuity.md        render Markdown, bounded 24 KiB             (0600)
    compact-events.jsonl journal append-only                         (0600)
```

**Một root duy nhất** cho cả phiên `alp` lẫn execution được uỷ. Trước 2026-09-11 execution con ghi vào một root khác, còn `alp context`, hook và doctor chỉ đọc root này — nên artifact của con là artifact không ai tra được.

`context/` là thư mục **anh em** của `runtime/`, không phải con: đó là lý do nó sống sót khi `cleanup` dọn `runtime/`.

Mọi file state ghi theo pattern **temp → atomic rename → chmod**; thư mục `0700`, file `0600`. Store từ chối execution ID đã tồn tại, và từ chối ID chứa separator (`/`, `\`) hoặc `.`/`..` — một ID là một tên thư mục, và một tên thư mục biết đi ra ngoài root là một đường ghi tuỳ ý.

## Trạng thái

ALP theo dõi hai bảng trạng thái ở hai tầng, và chúng không giống nhau:

| Tầng | Giá trị |
|---|---|
| `state.json` (ALP) | `prepared` → `running` → `awaiting-output` → `completed` \| `repairing` → `failed` \| `cancelled` |
| Backend (process) | `queued` \| `running` \| `completed` \| `failed` \| `cancelled` |
| [Node trong cây](../execution-graph/) | `preparing` \| `queued` \| `running` \| `cancelling` → `completed` \| `failed` \| `cancelled` \| `interrupted` |

Ba tầng trả lời ba câu khác nhau — *workflow tới đâu*, *process còn sống không*, *cây nghĩ gì*. Khi chúng lệch nhau, cây là **logical authority** và backend là **process authority**: cây nói ai là cha và còn bao nhiêu chỗ; backend nói pid nào còn thở.

## Process ở đâu

`LocalProcessBackend` là backend duy nhất, thuần TypeScript. Background thì nó giao cho một **supervisor** chạy detached, nên execution sống lâu hơn tiến trình `alp` đã tạo ra nó.

```text
~/.alp/delegation/<key>/
  local.json      state riêng của backend: pid, log, result
  logs/           transcript
  results/        exit status
  specs/          spec cho supervisor — 0600, và bị xoá TRƯỚC khi runtime được spawn
```

`specs/` đáng chú ý: spec mang trọn môi trường của execution, gồm cả [capability](../delegation/#bốn-biến-binding). File `0600` trong thư mục `0700`, và supervisor `unlink` nó *trước* khi spawn runtime — nên trong suốt thời gian agent chạy, nó không tồn tại.

## `cleanup` dọn gì, giữ gì

| Dọn | Giữ |
|---|---|
| File tạm, log, result, record process của backend | Node trong cây và kết quả lịch sử |

Vì vậy `alp delegation tree` sau `cleanup` vẫn kể được phiên đã chạy những gì.

`cleanup` **từ chối** một execution còn `queued`/`running` (`INVALID_REQUEST`): dọn nó là cắt sợi dây duy nhất còn giết được nó. Một backend đã quên execution thì được coi là đã dọn xong — không phải lỗi.

## Kiểm chứng

```bash
alp delegation status exec_abc123
alp context status exec_abc123
alp doctor
```

`doctor` báo `ORPHAN-EXECUTION` khi có execution mà process không còn. Đừng sửa tay `policy.json` để đổi quyền: hook tính lại policy từ registry và so nguyên văn, nên một snapshot sửa tay chỉ đổi một lỗi thành một lỗi khác.

## Liên quan

- [Thread](../thread/) — chuỗi các root mà một việc đi qua
- [Execution graph](../execution-graph/) — cây chứa các execution của một lượt chạy
- [Delegation](../delegation/) — thứ tự tạo ra một execution
- [Checkpoint và continuity](../continuity/) — nội dung thư mục `context/`
- [Runtime và launch spec](../runtime/) — nội dung thư mục `runtime/`

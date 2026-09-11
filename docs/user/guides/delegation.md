---
title: Giao việc
description: Delegate task cho specialist và quản lý lifecycle của execution.
---

Delegation là đường duy nhất để một role giao việc cho role khác trong ALP. Request được authorize và chuẩn bị trước khi runtime được probe hoặc spawn.

:::caution[Delegate phải chạy trong một phiên ALP]
`alp delegate` gõ từ terminal trần bị từ chối:

```text
delegation requires an authenticated parent execution; run it from inside an ALP session
```

Danh tính vai cha đến từ execution đang chạy, không từ biến môi trường — nên một execution luôn có cha, có trần và có người huỷ được nó. Cách làm thay thế là mở phiên bình thường rồi nhờ `main` giao việc:

```bash
cd ~/code/my-app
alp
# rồi nói với main: "giao cho search: tìm auth entrypoint, trả path:line"
```

Lệnh lifecycle (`tree`, `status`, `wait`, `cancel`, `cleanup`, `list`) không chịu ràng buộc đó: chúng tra theo execution ID và chạy được từ terminal trần.
:::

Ví dụ `alp delegate ...` bên dưới là những gì `main` chạy thay bạn — giữ lại vì output và lỗi bạn đọc vẫn là của chúng.

## Giao foreground

```bash
alp delegate search --project ~/code/my-app -- "Tìm auth entrypoint và trả path:line"
```

Foreground đợi execution kết thúc rồi trả kết quả. Brief nên có câu hỏi kiểm chứng được, ranh giới thư mục và dạng output mong muốn.

## Giao background

```bash
alp delegate search --project ~/code/my-app --background -- "Lập bản đồ CLI với path:line"
```

Lệnh trả về `executionId` ngay. Dùng ID đó để theo dõi:

```bash
alp delegation status exec_abc123
alp delegation wait exec_abc123
```

Bạn cũng có thể đặt timeout dương theo millisecond:

```bash
alp delegate librarian --timeout-ms 120000 -- "Đối chiếu hai API contract"
```

## Lifecycle commands

```bash
alp delegation list
alp delegation tree exec_abc123 [--json]
alp delegation status exec_abc123
alp delegation wait exec_abc123
alp delegation cancel exec_abc123
alp delegation cleanup exec_abc123
```

- `tree` vẽ cả phiên từ gốc xuống lá, bắt đầu từ **bất kỳ** execution ID nào trong đó.
- `cancel` dừng execution đang chạy **và mọi execution nó đã giao xuống**; nhánh khác không bị đụng.
- `cleanup` chỉ dọn file tạm, log và record process của backend. Node và kết quả trong cây ở lại, nên `tree` sau `cleanup` vẫn kể được phiên đã chạy những gì. Nó từ chối một execution còn `queued`/`running` — huỷ trước, dọn sau.
- Background execution được supervisor giữ, nên caller process kết thúc không đồng nghĩa execution biến mất.

## Xem cả cây

```bash
alp delegation tree exec_abc123
```

```text
graph exec_main  ·  revision 7  ·  updated 2026-09-11T02:14:05.000Z
deadline 2026-09-11T04:00:00.000Z
delegation 3/8 used  ·  5 remaining
nodes 4  ·  2 active  ·  1 slot(s) held
limits: depth ≤ 2  ·  4 children/execution  ·  2 concurrent children  ·  6 concurrent executions

main  ·  exec_main  ·  running
├─ search  ·  exec_search  ·  failed  ·  req req_2  ·  CHILD_START_FAILED: runtime refused the task
└─ worker  ·  exec_worker  ·  cancelled  ·  req req_3  ·  USER_REQUEST · requested by principal  ←
   └─ search  ·  exec_grandchild  ·  cancelled  ·  PARENT_CANCELLED · requested by exec_worker
```

`←` là execution bạn vừa hỏi. Khối đầu trả lời câu hỏi hay gặp nhất — "vì sao nó không giao thêm việc nữa" — bằng con số: allowance còn lại, số execution đang sống, và trần. `slot(s) held` là chỗ đã giữ mà process chưa kịp sinh ra.

`--json` trả nguyên view cho script.

## Trần và hạn của một phiên

Trần là cố định trong ALP, không sửa bằng config:

| Trần | Giá trị |
|---|---|
| Độ sâu | `2` (phiên `main` là 0) |
| Số việc giao mỗi execution | `4`, tối đa `2` chạy cùng lúc |
| Execution sống cùng lúc, cả phiên | `6` |
| Tổng lượt giao việc cả đời phiên | `8` |
| Hạn của cả phiên | 2 giờ |

Allowance đếm theo *lượt*: một việc đã xong vẫn tiêu một lượt trong `8`. Một request bị từ chối thì không tiêu lượt nào.

:::caution[Hạn của phiên không phải `--timeout-ms`]
`--timeout-ms` là thời gian **một lệnh `wait`** chịu đựng — hết giờ thì caller bỏ cuộc, còn execution nền vẫn chạy.

Hạn của phiên là một **mốc thời gian tuyệt đối**, chốt một lần lúc mở phiên và mọi execution con kế thừa đúng mốc đó. Quá mốc thì cả phiên bị huỷ, và `tree` ghi `WALL_CLOCK_EXCEEDED (deadline)`. Không có cách gia hạn; mở phiên mới là cách duy nhất.
:::

## Policy trước runtime

ALP kiểm caller có được delegate tới target role hay không, workspace có nằm trong scope không, memory context nào được cấp và workflow có hợp lệ không. Deny xảy ra trước runtime probe/spawn, nên một request trái policy không được “thử chạy rồi mới chặn”.

:::caution[Không có identity shortcut]
Không truyền cờ để giả caller role, chọn raw backend hoặc bypass policy. Identity đến từ execution hiện tại; backend là chi tiết lifecycle phía sau ALP.
:::

## Chọn đúng specialist

- `worker`: mọi việc phải sửa file — vai duy nhất ghi được vào workspace. Giao một task đã cắt sẵn: phạm vi, kết quả mong đợi, và cách kiểm.
- `search`: code local, definition, call site, impact.
- `librarian`: tài liệu bên ngoài hoặc repo khác.
- `read-thread`: quyết định/fact đã lưu trong memory.
- `review`: review một concern cụ thể.
- `oracle`: second opinion cho vấn đề khó hoặc nhiều đánh đổi.

## Kiểm chứng

Với background execution, `status` phải trả cùng ID và một trạng thái trong lifecycle. Sau `wait`, execution phải ở `completed`, `failed` hoặc `cancelled`; không tự giả định execution thành công chỉ vì spawn thành công.

Nếu delegation dừng trước launch, xem [Xử lý sự cố](../../reference/troubleshooting/#delegation-dừng-trước-khi-launch).

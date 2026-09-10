---
title: Giao việc
description: Delegate task cho specialist và quản lý lifecycle của execution.
---

Delegation là đường duy nhất để một role giao việc cho role khác trong ALP. Request được authorize và chuẩn bị trước khi runtime được probe hoặc spawn.

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
alp delegation status exec_abc123
alp delegation wait exec_abc123
alp delegation cancel exec_abc123
alp delegation cleanup exec_abc123
```

- `cancel` yêu cầu dừng execution đang chạy và chuyển sang terminal state phù hợp.
- `cleanup` dọn lifecycle record/artifact mà service sở hữu; chỉ dùng khi không còn cần tra execution.
- Background execution được supervisor giữ, nên caller process kết thúc không đồng nghĩa execution biến mất.

## Policy trước runtime

ALP kiểm caller có được delegate tới target role hay không, workspace có nằm trong scope không, memory context nào được cấp và workflow có hợp lệ không. Deny xảy ra trước runtime probe/spawn, nên một request trái policy không được “thử chạy rồi mới chặn”.

:::caution[Không có identity shortcut]
Không truyền cờ để giả caller role, chọn raw backend hoặc bypass policy. Identity đến từ execution hiện tại; backend là chi tiết lifecycle phía sau ALP.
:::

## Chọn đúng specialist

- `search`: code local, definition, call site, impact.
- `librarian`: tài liệu bên ngoài hoặc repo khác.
- `read-thread`: quyết định/fact đã lưu trong memory.
- `review`: review một concern cụ thể.
- `oracle`: second opinion cho vấn đề khó hoặc nhiều đánh đổi.

## Kiểm chứng

Với background execution, `status` phải trả cùng ID và một trạng thái trong lifecycle. Sau `wait`, execution phải ở `completed`, `failed` hoặc `cancelled`; không tự giả định execution thành công chỉ vì spawn thành công.

Nếu delegation dừng trước launch, xem [Xử lý sự cố](../../reference/troubleshooting/#delegation-dừng-trước-khi-launch).

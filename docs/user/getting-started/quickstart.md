---
title: Bắt đầu nhanh
description: Đăng ký project, chọn mode và mở phiên ALP đầu tiên.
---

Sau phần này, project hiện tại được đăng ký và coordinator `main` có thể làm việc trong workspace với quyền write.

## 1. Kiểm tra môi trường

```bash
alp --version
alp doctor
```

Nếu chỉ cài Codex CLI, bạn có thể dùng mode `puck`. Các mode khác có thể định tuyến role sang cả Claude Code và Codex CLI.

## 2. Đăng ký project

```bash
cd ~/code/my-app
alp init
```

Khi thành công, ALP in `READY` cùng đường dẫn canonical của project. `alp init` cũng:

- đăng ký project trong machine-local state;
- tạo không gian `.alp/agents/` và `.alp/skills/` cho project;
- cài SessionStart wiring và link packaged skills mà không thêm chúng vào commit;
- hỏi tên và cách xưng hô ở lần đầu nếu đang chạy trong terminal tương tác.

:::note[Project chưa đăng ký]
Nếu chạy `alp` trong cwd chưa đăng ký, `main` chỉ nhận quyền read-only. Đây là hành vi an toàn mặc định, không phải lỗi runtime.
:::

## 3. Chọn độ khó

Xem lựa chọn đang lưu:

```bash
alp mode show
```

Đặt lựa chọn mặc định cho các phiên sau:

```bash
alp mode set medium
```

Bạn cũng có thể override đúng một phiên:

```bash
alp --mode high
```

`medium` phù hợp phần lớn công việc hằng ngày. Xem [Nấc và runtime](../../concepts/modes-and-runtimes/) trước khi chọn `high`, `ultra` hoặc `puck`.

## 4. Mở phiên

```bash
alp
```

Không truyền mode trên TTY, ALP dùng thứ tự: biến môi trường hoặc lựa chọn đã lưu, sau đó mới hiển thị menu; nếu không có lựa chọn tương tác thì fallback về `medium`.

Trong phiên, hãy giao một kết quả có thể kiểm chứng, ví dụ: “đọc test hiện tại và giải thích command nào chạy suite này”. Coordinator sẽ tự quyết định có cần delegate cho specialist hay không trong đúng policy.

## Kiểm chứng

- `alp init` đã in `READY` đúng project.
- `alp mode show` in mode mong muốn.
- `alp` mở runtime tương ứng thay vì báo thiếu runtime.
- `git status --short` không xuất hiện generated settings hoặc packaged skill links do ALP sở hữu.

Tiếp theo: [hiểu cách ALP chuẩn bị một execution](../../concepts/how-alp-works/).

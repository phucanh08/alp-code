---
title: Nấc và runtime
description: Chọn độ khó bằng mode và hiểu cách ALP định tuyến model sang runtime.
---

Mode là lựa chọn hiệu năng duy nhất khi mở phiên. Bạn trả lời “việc này khó cỡ nào”; ALP chọn model cho từng role, rồi model quyết định Claude Code hay Codex CLI.

Tài liệu này phản ánh checkout `alp-code` tại commit `7833490` sau tag `v0.10.4`. Model mapping có thể đổi ở release sau; `alp --help` trên máy luôn phản ánh bản đang cài.

## Năm mode

| Mode | Dùng khi | `main` hiện tại | `oracle` hiện tại |
|---|---|---|---|
| `low` | Việc vặt, câu trả lời nhanh | Claude Sonnet 5 | GPT-5.6 Sol |
| `medium` | Việc thường ngày trong repo quen; mặc định | GPT-5.6 Sol | Claude Opus 5 |
| `high` | Refactor xuyên module, bug khó tái hiện | Claude Opus 5 | GPT-5.6 Sol |
| `ultra` | Thiết kế, migration hoặc sự cố mà trả lời sai rất đắt | Claude Opus 5 | GPT-6 Astra |
| `puck` | Toàn Codex hoặc máy chỉ cài Codex CLI | GPT-5.6 Sol | GPT-5.6 Sol |

Bốn mode đầu chỉ thay đổi hai role cần scale theo độ khó là `main` và `oracle`; các specialist retrieval/review khác có mapping cố định. `puck` là loadout toàn Codex, không nằm trên trục độ khó.

## Chọn mode

Cho đúng một phiên:

```bash
alp --mode high
```

Lưu mặc định:

```bash
alp mode set medium
alp mode show
```

Bạn cũng có thể đặt `ALP_MODE`. Thứ tự quyết định đầy đủ:

1. `--mode` trên command hiện tại;
2. `ALP_MODE`;
3. `alp mode set` đã lưu;
4. menu khi có TTY;
5. `medium`.

Giá trị sai bị từ chối; ALP không lặng lẽ chạy mode khác.

## Runtime được chọn thế nào?

- Model có tên `claude-*` chạy qua Claude Code.
- Model có tên `gpt-*` chạy qua Codex CLI.
- Một phiên có thể dùng cả hai runtime khi `main` delegate sang role có model ở phía còn lại.

ALP không có public runtime switch. Nếu một runtime thiếu, cài CLI mà model cần hoặc chọn loadout phù hợp như `puck`, rồi chạy lại `alp doctor`.

:::caution[Hai runtime không cưỡng chế cùng một lượng]
Cùng một grant, Claude Code từ chối tool và read root ngoài phạm vi ngay lúc gọi; Codex CLI thì không — shell của nó là built-in và sandbox read-only cho đọc mọi path. Ghi và egress mạng thì Codex chặn thật. Mode bạn chọn quyết định vai nào rơi vào phía nào, nên hãy đọc [runtime nào cưỡng chế phần nào](../agents-and-authority/#runtime-nào-cưỡng-chế-phần-nào) trước khi giao việc nhạy cảm.
:::

## Kiểm chứng

```bash
alp mode show
alp agent test main --tier 2 --mode high
```

Tier 2 chuẩn bị execution thật nhưng dừng trước spawn; output cho biết model, runtime, quyền, khối **Enforced by** và launch spec mà mode sẽ tạo.

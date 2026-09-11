---
title: Nấc và runtime
description: Chọn độ khó bằng mode và hiểu cách ALP định tuyến model sang runtime.
---

Mode là lựa chọn hiệu năng duy nhất khi mở phiên. Bạn trả lời “việc này khó cỡ nào”; ALP chọn model cho từng role, rồi model quyết định Claude Code hay Codex CLI.

Tài liệu này phản ánh stable `v0.13.0`. Model mapping có thể đổi ở release sau; `alp --help` trên máy luôn phản ánh bản đang cài.

## Năm mode

| Mode | Dùng khi | `main` | `worker` | `oracle` |
|---|---|---|---|---|
| `low` | Việc vặt, câu trả lời nhanh | `claude-opus-5` · `high` | `claude-sonnet-5` · `high` | `gpt-5.6-sol` · `high` |
| `medium` | Việc thường ngày trong repo quen; mặc định | `claude-opus-5` · `high` | `gpt-5.6-sol` · `high` | `claude-opus-5` · `high` |
| `high` | Refactor xuyên module, bug khó tái hiện | `claude-opus-5` · `high` | `claude-opus-5` · `high` | `gpt-5.6-sol` · `xhigh` |
| `ultra` | Thiết kế, migration hoặc sự cố mà trả lời sai rất đắt | `claude-opus-5` · `high` | `claude-opus-5` · `high` | `gpt-6-astra` · `high` |
| `puck` | Toàn Codex hoặc máy chỉ cài Codex CLI | `gpt-5.6-sol` · `xhigh` | `gpt-5.6-sol` · `xhigh` | `gpt-5.6-sol` · `xhigh` |

Trong loadout built-in trước khi ghép settings, bốn nấc `low`/`medium`/`high`/`ultra` đều giữ `main` ở `claude-opus-5` · `high`. `main` là cửa vào và coordinator ổn định: nghe yêu cầu, lập kế hoạch, chia việc và điều phối không tự dễ đi chỉ vì phần thực thi đơn giản hơn, nên độ khó nằm ở `worker` và `oracle`. `puck` là ngoại lệ toàn Codex, không nằm trên trục độ khó.

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

## Tùy biến loadout bằng settings

Bảng trên là loadout ALP ship sẵn. ALP đọc ba file settings theo thứ tự từ chung tới riêng:

| File | Của ai | Commit? |
|---|---|---|
| `~/.alp/settings.json` | máy của bạn | không |
| `<project>/.alp/settings.json` | project, đi cùng repo | có |
| `<project>/.alp/settings.local.json` | riêng bạn trên project này | không |

File sau chỉ ghi đè những field nó khai báo. Settings chỉ đổi `model` và `reasoningEffort` của role trong năm mode có sẵn; nó không tạo mode mới, không chọn runtime riêng và không thay đổi tool, workspace, memory hay quyền delegate.

Xem [Tùy biến loadout của mode](../../guides/customize-mode-loadouts/) để biết khuôn file, cách ghép lớp, ví dụ override, khôi phục mặc định và lệnh kiểm chứng.

## Runtime được chọn thế nào?

- Model ID được đăng ký với runtime `claude` chạy qua Claude Code; ID đăng ký với `codex` chạy qua Codex CLI.
- ALP dùng danh sách mapping đóng, không đoán runtime từ tiền tố tên; model chưa được đăng ký bị từ chối.
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

Tier 2 không spawn model. Khối **Cost** xác nhận mode, model, mức suy nghĩ và runtime có hiệu lực sau khi ghép settings. Khối **Launch** chuẩn bị song song hai phương án runtime bằng model và mức suy nghĩ khai trong định nghĩa agent để so sánh; đó không phải launch spec của mode đã chọn hoặc đã tùy biến.

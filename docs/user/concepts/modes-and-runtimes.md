---
title: Nấc và runtime
description: Chọn độ khó bằng mode và hiểu cách ALP định tuyến model sang runtime.
---

Mode là lựa chọn hiệu năng duy nhất khi mở phiên. Bạn trả lời “việc này khó cỡ nào”; ALP chọn model cho từng role, rồi model quyết định Claude Code hay Codex CLI.

Tài liệu này phản ánh stable `v0.12.0`. Model mapping có thể đổi ở release sau; `alp --help` trên máy luôn phản ánh bản đang cài.

## Năm mode

| Mode | Dùng khi | `worker` hiện tại | `oracle` hiện tại |
|---|---|---|---|
| `low` | Việc vặt, câu trả lời nhanh | Claude Sonnet 5 | GPT-5.6 Sol |
| `medium` | Việc thường ngày trong repo quen; mặc định | GPT-5.6 Sol | Claude Opus 5 |
| `high` | Refactor xuyên module, bug khó tái hiện | Claude Opus 5 | GPT-5.6 Sol |
| `ultra` | Thiết kế, migration hoặc sự cố mà trả lời sai rất đắt | Claude Opus 5 | GPT-6 Astra |
| `puck` | Toàn Codex hoặc máy chỉ cài Codex CLI | GPT-5.6 Sol | GPT-5.6 Sol |

Bốn mode đầu chỉ thay đổi hai role mà độ khó chạm tới: `worker` (vai cầm bút) và `oracle` (vai được hỏi khi bí). `main` và các specialist retrieval/review có mapping cố định — `main` đứng yên ở Claude Opus 5 vì việc của nó không dễ đi khi bài toán dễ đi. `puck` là loadout toàn Codex, không nằm trên trục độ khó.

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

## Đổi model của một role: `settings.json`

Bảng trên là loadout ALP ship sẵn. Muốn một role chạy model khác, ghi đè bằng file settings — ba tầng, tầng sau thắng tầng trước:

| File | Của ai | Commit? |
|---|---|---|
| `~/.alp/settings.json` | máy của bạn | không |
| `<project>/.alp/settings.json` | project, đi cùng repo | có |
| `<project>/.alp/settings.local.json` | riêng bạn trên project này | không |

```json
{
  "modes": {
    "*":    { "titling": { "model": "gpt-5.6-luna" } },
    "high": { "worker": { "model": "claude-opus-5", "reasoningEffort": "max" } }
  }
}
```

- `"*"` áp cho mọi mode và thua mode gọi đích danh.
- Khai một trường thì trường còn lại giữ nguyên giá trị built-in.
- Custom agent chưa có trong loadout nào phải khai đủ cả `model` lẫn `reasoningEffort`.
- Đổi `model` là đổi luôn runtime, vì runtime là hệ quả của model.

File này chỉ ghim **model và mức nghĩ**. Nó không đụng được tới tool, workspace, memory hay quyền delegate — những thứ đó vẫn nằm trong định nghĩa agent.

Sai một dòng thì phiên dừng và báo tên file: mode không tồn tại, tên trường viết sai, model không có runtime, effort không hợp lệ. ALP không lặng lẽ chạy loadout khác.

Xem cái gì đang thật sự có hiệu lực:

```bash
alp mode show
```

Khi có settings, `alp mode show` in thêm dòng `SETTINGS` cho mỗi file đã đọc và một dòng `OVERRIDE` cho mỗi role đã dịch khỏi built-in.

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

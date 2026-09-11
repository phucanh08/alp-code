---
title: Tùy biến loadout của mode
description: Ghi đè model và mức suy nghĩ theo mode, role và phạm vi cấu hình.
---

Mỗi mode có một loadout built-in: model và mức suy nghĩ cho từng role. Bạn có thể ghi đè
đúng phần cần đổi mà không phải sửa source hay sao chép cả loadout.

## Mode nào tùy biến được?

Chỉ năm ID có sẵn được hỗ trợ: `low`, `medium`, `high`, `ultra` và `puck`.

Settings **không tạo mode mới**. Một tên tùy ý như `fast`, `smart` hay `team-default` bị từ
chối; hãy chọn một trong năm mode trên rồi đổi loadout của nó.

## Ba lớp settings

ALP đọc ba file theo thứ tự từ chung tới riêng:

| Thứ tự | File | Phạm vi |
|---|---|---|
| 1 | `~/.alp/settings.json` | Mặc định của máy |
| 2 | `<project>/.alp/settings.json` | Cấu hình chung của project, có thể commit |
| 3 | `<project>/.alp/settings.local.json` | Cấu hình riêng của bạn trong project, không nên commit |

File phía sau thắng file phía trước, nhưng chỉ ở field nó khai báo. File không tồn tại được
bỏ qua; file có cú pháp JSON hỏng hoặc giá trị không hợp lệ làm lệnh dừng và báo đúng tên
file.

## Đổi một role trong một mode

Ví dụ, đặt `worker` của `medium` trong `<project>/.alp/settings.json`:

```json
{
  "modes": {
    "medium": {
      "worker": {
        "model": "gpt-5.6-terra",
        "reasoningEffort": "medium"
      }
    }
  }
}
```

Các mode và role không được nhắc tới giữ nguyên loadout hiện có.

## Áp dụng cho mọi mode bằng `"*"`

`"*"` áp dụng một override cho cả năm mode. Ví dụ, ghim `titling` về cùng một model và
mức suy nghĩ:

```json
{
  "modes": {
    "*": {
      "titling": {
        "model": "gpt-5.6-luna",
        "reasoningEffort": "low"
      }
    }
  }
}
```

Trong cùng một file, ALP ghép `"*"` trước rồi mới ghép mode gọi đích danh, nên cấu hình cho
`medium` sẽ thắng `"*"` ở những field trùng nhau.

## Ghép project với project-local

Mỗi override được ghép theo field, không thay cả object của role. Project có thể đặt loadout
chung trong `<project>/.alp/settings.json`:

```json
{
  "modes": {
    "high": {
      "review": {
        "model": "claude-opus-5",
        "reasoningEffort": "high"
      }
    }
  }
}
```

Nếu trên máy của bạn chỉ muốn đổi model, `<project>/.alp/settings.local.json` chỉ cần field
đó:

```json
{
  "modes": {
    "high": {
      "review": {
        "model": "gpt-5.6-terra"
      }
    }
  }
}
```

Kết quả là `high.review` dùng `gpt-5.6-terra · high`: `model` đến từ file local, còn
`reasoningEffort` giữ giá trị của file project.

Tóm lại, thứ tự ghép là máy → project → project-local. Trong từng file, `"*"` → mode gọi
đích danh. Bước sau chỉ đè những field nó đặt.

## Giới hạn của settings

Trong mỗi role chỉ có hai field được phép:

- `model` — phải là model ALP đã gán runtime;
- `reasoningEffort` — một trong `low`, `medium`, `high`, `xhigh`, `max`, `ultra`.

ALP tra model trong bảng mapping để quyết định runtime được phóng; các model Claude hiện có
chạy qua Claude Code, còn các model GPT hiện có chạy qua Codex CLI. Settings không chọn
runtime riêng và không thay đổi tool, workspace, memory, quyền delegate hay bất kỳ authority
nào của role.

Nếu ghi đè một custom agent chưa có sẵn trong loadout, hãy khai cả `model` lẫn
`reasoningEffort`; ALP không có giá trị built-in để điền field còn thiếu.

## Khôi phục mặc định

Để bỏ một override, xóa field tương ứng; nếu đó là field cuối cùng, xóa luôn cả entry của
role vì object rỗng không hợp lệ. Không đặt `null`.

Sau khi xóa, ALP dùng nguồn có độ ưu tiên cao nhất còn lại: bỏ override ở mode gọi đích danh
có thể làm lộ `"*"` trong cùng file, rồi tới các lớp settings trước đó, cuối cùng mới là
built-in. Muốn về đúng built-in, hãy xóa override tương ứng khỏi cả mode gọi đích danh lẫn
`"*"` trong cả ba lớp.

## Kiểm chứng

Sau khi lưu file, xem mode và các override đang có hiệu lực:

```bash
alp mode show
```

Sau đó dry-run một role ở tier 2 để kiểm tra model, mức suy nghĩ, runtime và launch spec mà
mode sẽ tạo:

```bash
alp agent test <role> --tier 2 --mode <mode>
```

Ví dụ:

```bash
alp agent test worker --tier 2 --mode medium
```

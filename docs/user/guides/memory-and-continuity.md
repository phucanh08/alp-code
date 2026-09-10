---
title: Memory và continuity
description: Chọn đúng memory scope và giữ quyết định quan trọng qua compaction.
---

Memory lưu kiến thức dùng lại giữa các phiên; continuity giữ objective và các pin quan trọng của **một execution** qua compaction. Hai cơ chế liên quan nhưng không thay thế nhau.

## Memory scopes

ALP authorize bằng logical ID thay vì để role tự chọn path:

```text
shared:<id>
project:<slug>:<id>
private:<role>:<id>
```

| Scope | Dùng cho | Ai đọc được? |
|---|---|---|
| `shared` | Fact chung, principal preference, reference chung | Role có shared grant |
| `project` | Mục tiêu, quyết định, log và reference của project | Role có project grant |
| `private:<role>` | Draft và self-journal của đúng role | Chỉ role sở hữu khi được grant |

Default Markdown store nằm dưới `~/.alp/memory`. `ALP_MEMORY_ROOT` có thể đổi root cho môi trường cô lập. Policy được kiểm ở service boundary, nên đổi storage adapter không đổi quyền.

:::caution[Private nghĩa là owner-only]
Quan hệ reports-to không cấp quyền đọc private memory của role khác. Fact cần dùng chung phải đi vào shared/project scope phù hợp hoặc được trả trong output.

Mức cưỡng chế khác nhau theo runtime: trên Claude đây là ACL thật, trên Codex là ràng buộc mức prompt vì sandbox read-only cho đọc mọi path. Xem [runtime nào cưỡng chế phần nào](../../concepts/agents-and-authority/#runtime-nào-cưỡng-chế-phần-nào).
:::

## Continuity checkpoint

Native runtime tự compact transcript khi gần hết context. ALP giữ một checkpoint nhỏ bên ngoài gồm objective và bốn loại pin:

- `decision`: lựa chọn đã chốt và lý do;
- `constraint`: ranh giới không được vi phạm;
- `open-item`: câu hỏi hoặc blocker chưa giải quyết;
- `next-action`: bước cụ thể tiếp theo.

## Xem và kiểm checkpoint

Trong delegated execution, ALP lấy ID từ môi trường:

```bash
alp context status
alp context validate
```

Từ terminal khác, truyền ID rõ ràng:

```bash
alp context status exec_abc123
alp context validate exec_abc123
```

Không có khái niệm “execution mới nhất” được đoán ngầm.

## Pin và unpin

```bash
alp context pin decision -- "chọn curated docs vì không cần build coupling"
alp context pin constraint -- "không thay đổi deploy"
alp context pin open-item -- "chờ xác nhận domain"
alp context pin next-action -- "chạy production preview"
alp context unpin 123e4567-e89b-12d3-a456-426614174000
```

Mỗi pin là một câu ngắn; control character được collapse và kích thước bị giới hạn.

:::danger[Không pin dữ liệu nhạy cảm]
Không pin secret hoặc nội dung file. Pin được lưu trên đĩa và reinject thẳng vào context window.
:::

## Kiểm chứng

`alp context validate` chỉ xanh khi checkpoint khớp policy hash và compact journal replay ổn định. Exit khác `0` là finding cần điều tra, không được bỏ qua để tiếp tục với context không đáng tin.

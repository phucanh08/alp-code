# RELATIONS — {{ROLE}} làm việc với ai

> Nguồn sự thật về quan hệ: `loadout.yaml` (`reports_to`, `delegates_to`).
> File này giải thích **khi nào** và **giao thế nào**, không phải **được giao cho ai**.
> Danh sách vai đầy đủ: [`../REGISTRY.md`](../REGISTRY.md).

## Báo cáo cho

<`reports_to` là delegation parent mặc định. Phiên trực tiếp vẫn trao đổi với principal;
execution delegated trả lifecycle/kết quả về parent.>

## Giao việc cho

<Một mục cho mỗi vai trong `delegates_to`. Nếu rỗng thì ghi rõ:
"Không delegate cho ai. Việc vượt phạm vi → trả về `reports_to`.">

### `<role>` — <Tên> <emoji>

| Giao khi | Không giao khi |
|---|---|
| <tình huống> | <tình huống> |

**Vai đó ghi được:** <từ `loadout.yaml` của vai đó>
**Vai đó KHÔNG ghi được:** <ranh giới>

**Cách giao:** qua ALP Delegation API. Prompt theo khuôn 6 mục ở `../_shared/DELEGATION.md`.

**Kiểm chứng bắt buộc:** đọc lại output bằng mắt mình trước khi báo cáo lên.

## Cách ly — điều KHÔNG được quên

Vai này **không phải root**. Không đọc được `memory/private/<vai-khác>/**` và
không đọc được `identity/<vai-khác>/**`. Muốn biết vai khác nghĩ gì → **hỏi vai đó**.
`private` mà người khác đọc được thì không còn là `private`.

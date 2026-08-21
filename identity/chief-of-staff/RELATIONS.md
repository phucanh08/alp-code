# RELATIONS — chief-of-staff giao việc cho ai

> Nguồn sự thật về quan hệ: `loadout.yaml` (`reports_to`, `delegates_to`).
> File này giải thích **khi nào** và **giao thế nào**, không phải **được giao cho ai**.
> Danh sách vai đầy đủ: [`../REGISTRY.md`](../REGISTRY.md).

## Báo cáo cho

**principal** (Lê Phúc Anh). Xem [`../_shared/PRINCIPAL.md`](../_shared/PRINCIPAL.md).

## Giao việc cho

### `researcher` — Long 🔎

| Giao khi | Không giao khi |
|---|---|
| Cần tra công nghệ / thư viện / best practice từ web | Câu trả lời nằm trong `memory/` hoặc repo — tự tra |
| Cần đối chiếu nhiều nguồn sơ cấp | Việc <5 phút |
| Cần dựng tài liệu tham chiếu cho một project | Cần **quyết định** — đó là việc của chief-of-staff |

**Long ghi được:** `memory/shared/reference/**`, `memory/projects/*/refs/**`.
**Long KHÔNG ghi được:** `PROJECT.md`, `decisions/`. Long đưa dữ liệu, chief-of-staff chốt.

**Cách giao:** qua herdr, pane riêng. Prompt theo khuôn 6 mục ở `HOUSE-RULES.md` §3.
Nêu rõ: câu hỏi cần trả lời, nguồn đã thử, đích ghi file, hạn.

**Kiểm chứng bắt buộc:** mở file Long ghi, đọc bằng mắt mình, kiểm ít nhất 1 link.
Long có thể trích sai hoặc suy diễn vượt dữ liệu. Kết quả sai là lỗi của chief-of-staff.

## Cách ly — điều KHÔNG được quên

Chief-of-staff **không phải root**. Không đọc được `memory/private/researcher/**` và
không đọc được `identity/researcher/**`. Muốn biết Long nghĩ gì → **hỏi Long**.
`private` mà cấp trên đọc được thì không còn là `private`.

# CLAUDE.md — điểm vào vai `titling`

Bạn là **titling**. Tên và emoji lấy từ `loadout.yaml`.

Identity đầy đủ được nạp tự động qua hook `SessionStart`
(`hooks/session-start.cjs` ở gốc repo `alp-code`).

**Nếu context không có identity** ⇒ hook hỏng. Khi đó:

1. Đọc theo thứ tự: `loadout.yaml` → `IDENTITY.md` → `../_shared/VOICE.md` → `SOUL.md`
   → `../_shared/HOUSE-RULES.md` → `PLAYBOOK.md` → `../_shared/PRINCIPAL.md`
   → `../../memory/INDEX.md` → `../../memory/projects/INDEX.md`
2. Báo principal ngay: "hook SessionStart không chạy".

Không lặp lại nội dung các file trên ở đây — một nguồn sự thật, không hai.

## Kênh giao tiếp — principal hoặc delegation parent

Nhận task trực tiếp từ principal hoặc qua ALP Delegation API. Phiên trực tiếp trao đổi và trả
kết quả cho principal; execution delegated trả lifecycle/kết quả về `reports_to`. Kênh giao
tiếp không mở thêm ACL, memory, workspace hay `delegates_to`.

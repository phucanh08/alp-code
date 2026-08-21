# REGISTRY — danh bạ các vai

> L0 của tầng identity. Nguồn sự thật về **ai tồn tại**.
> Chi tiết từng vai: `identity/<role>/`. ACL từng vai: `identity/<role>/loadout.yaml`.
> **Chỉ principal sửa file này.** Agent không có quyền ghi. `scripts/new-role.sh` tự thêm dòng.

| Vai | Tên | Emoji | Model | Báo cáo cho | Trạng thái |
|---|---|---|---|---|---|
| chief-of-staff | Phở | 🍜 | claude-opus-5 | principal | ACTIVE |
| researcher | Long | 🔎 | claude-opus-5 | chief-of-staff | ACTIVE |

## Quy ước

- **Key là vai, không phải tên.** Thư mục `identity/chief-of-staff/`, không phải `identity/pho/`.
  Đổi tên = sửa một dòng `name:` trong `loadout.yaml`, không đổi path nào.
- Một vai = một thư mục = một `loadout.yaml` = một phiên Claude Code với CWD riêng.
- Thêm vai **chỉ** qua `scripts/new-role.sh`. Tạo tay = thiếu deny ở các vai cũ = rò rỉ.
- Trạng thái: `ACTIVE` · `PAUSED` · `RETIRED`. Vai RETIRED giữ thư mục để tra cứu,
  nhưng vẫn phải có mặt trong deny-list của mọi vai khác.

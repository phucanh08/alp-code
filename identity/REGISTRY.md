# REGISTRY — danh bạ các vai

> L0 của tầng identity. Nguồn sự thật về **ai tồn tại**.
> Chi tiết từng vai: `identity/<role>/`. ACL từng vai: `identity/<role>/loadout.yaml`.
> **Chỉ principal sửa file này.** Agent không có quyền ghi. `scripts/new-role.sh` tự thêm dòng.

| Vai | Tên | Emoji | Model | Báo cáo cho | Trạng thái |
|---|---|---|---|---|---|
| main | Phở | 🍜 | claude-opus-5 | principal | ACTIVE |
| search | Search | 🔍 | gpt-5.6-terra | main | ACTIVE |
| librarian | Librarian | 📚 | gpt-5.6-sol | main | ACTIVE |
| read-thread | Read Thread | 🧵 | gpt-5.6-luna | main | ACTIVE |
| review | Review | 🔎 | gpt-5.5 | main | ACTIVE |
| oracle | Oracle | 🔮 | gpt-5.6-sol / claude-opus-5 | main | ACTIVE |

## Quy ước

- **Key là vai, không phải tên.** Thư mục `identity/main/`, không phải `identity/pho/`.
  Đổi tên = sửa một dòng `name:` trong `loadout.yaml`, không đổi path nào.
- Một vai = một thư mục = một `loadout.yaml` = một phiên runtime riêng.
- Thêm vai **chỉ** qua `scripts/new-role.sh`. Tạo tay = thiếu deny ở các vai cũ = rò rỉ.
- Trạng thái: `ACTIVE` · `PAUSED` · `RETIRED`. Vai RETIRED giữ thư mục để tra cứu,
  nhưng vẫn phải có mặt trong deny-list của mọi vai khác.

# PLAYBOOK — local code retrieval

1. Chuẩn hoá câu hỏi thành symbol, hành vi hoặc luồng cần tìm.
2. Xác định workspace đã đăng ký trong `loadout.yaml`.
3. Dùng `rg`/Glob/Grep tìm entry point, definition và call-site.
4. Mở đúng đoạn code; đối chiếu test/config khi liên quan.
5. Trả lời ngắn: kết luận, bằng chứng `path:line`, phần chưa chắc.

Không dùng web, không sửa source. Cần nguồn ngoài → `librarian`; cần memory → `read-thread`.

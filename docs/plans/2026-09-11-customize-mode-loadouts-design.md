# Tùy biến loadout của mode — thiết kế tài liệu

## Mục tiêu

Làm rõ trong tài liệu người dùng stable `v0.13.0` rằng bốn mode độ khó giữ `main` ở
`claude-opus-5 · high` và thay đổi chủ yếu `worker`/`oracle`; đồng thời cung cấp một hướng
dẫn dễ tìm để tùy biến loadout của năm mode có sẵn bằng `settings.json` và
`settings.local.json`.

## Phạm vi

- Tạo guide user-facing riêng: `guides/customize-mode-loadouts.md`.
- Mở rộng trang khái niệm `modes-and-runtimes.md` bằng bảng model + effort đầy đủ cho ba
  role quyết định trải nghiệm phiên (`main`, `worker`, `oracle`) và trỏ sang guide thực hành.
- Thêm guide vào sidebar, rồi liên kết từ Quickstart, Project setup và CLI reference.
- Không thêm mode ID mới và không đổi routing/runtime/code.
- Không trộn “custom loadout” với “custom agent”.

## Nội dung guide

Guide đi từ phạm vi nhỏ tới lớn:

1. Nêu rõ chỉ tùy biến năm mode `low`, `medium`, `high`, `ultra`, `puck`; không tạo tên mode mới.
2. Giải thích ba lớp cấu hình và precedence: máy → project → project-local.
3. Cho ví dụ đổi một role trong một mode, dùng `"*"` cho mọi mode, và để
   `settings.local.json` ghi đè `settings.json` mà không sao chép cả file.
4. Giải thích merge theo field: có thể chỉ đổi `model` hoặc `reasoningEffort`; mode gọi đích
   danh thắng `"*"`; lớp sau thắng lớp trước.
5. Nêu ranh giới: settings chỉ đổi model/effort, model quyết định runtime, không đổi authority.
6. Hướng dẫn khôi phục built-in bằng cách xóa override tương ứng.
7. Kiểm chứng bằng `alp mode show` và `alp agent test <role> --tier 2 --mode <mode>`.

## Tính đúng và khả năng bảo trì

- Bảng và ví dụ phải khớp `MODE_PROFILES`, `MODE_IDS`, `REASONING_EFFORTS` và thứ tự file
  trong source `v0.13.0`.
- Chỉ một trang giữ walkthrough đầy đủ; các trang khác dùng mô tả ngắn và link để tránh drift.
- Chạy docs drift check, kiểm tra sidebar JSON, tìm link/anchor cũ và chạy typecheck/test tài
  liệu hiện có trước khi hoàn tất.

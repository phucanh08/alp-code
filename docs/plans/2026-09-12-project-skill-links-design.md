# Project skill links

## Mục tiêu

Cho Claude Code và Codex dùng trực tiếp toàn bộ skill built-in trong `skills/` khi phát triển
chính repo `alp-code`. `skills/` là nguồn nội dung duy nhất; hai runtime chỉ nhận symlink.

## Thiết kế

Thêm một script đồng bộ idempotent, đọc các thư mục skill trực tiếp dưới `skills/` và tạo
symlink tương đối cùng tên trong:

- `.claude/skills/`
- `.codex/skills/`

Script giữ nguyên entry không do nó sở hữu, đặc biệt skill project-only `release`. Nếu một
entry cùng tên là bản copy cũ nhưng trỏ tới cùng skill source theo cấu trúc repo đã biết, lần
chuyển đổi ban đầu sẽ thay nó bằng symlink; về sau script không ghi đè nội dung ngoại lai.

Script cũng gỡ symlink do nó sở hữu khi skill nguồn không còn tồn tại. Symlink tương đối giúp
checkout tiếp tục dùng được khi repo được chuyển sang path khác.

Expose script qua `npm run sync:skills` và gọi nó trong lifecycle cài dependency để checkout
mới tự sẵn sàng. Chạy script ngay trong checkout hiện tại để Claude và Codex dùng skill mà
không cần đợi lần cài tiếp theo.

## An toàn và lỗi

- Không thay hoặc xóa file/thư mục ngoại lai.
- Không đi theo symlink nguồn; chỉ link các thư mục skill thật có `SKILL.md`.
- Một lỗi xung đột được báo rõ cùng path và làm command thất bại.
- Skill `release` tiếp tục sống riêng trong `.claude/skills` và link riêng hiện có của Codex.

## Kiểm thử

Test script trong thư mục tạm với các ca: tạo link cho cả hai runtime, chạy lặp idempotent,
giữ entry ngoại lai, giữ `release`, dùng target tương đối, và dọn symlink đã mồ côi. Sau đó
chạy test mục tiêu, typecheck/build, và suite liên quan trước khi kết luận.

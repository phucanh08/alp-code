# Quy trình đóng kế hoạch

Chạy khi một kế hoạch đã xong, hoặc khi principal muốn dọn `plans/`.

## 1. Đọc trạng thái thật

```bash
ls plans/
```

Với mỗi thư mục kế hoạch: đọc frontmatter `status:` của `plan.md`, và 20 dòng đầu của từng
`phase-*.md`.

**Đọc, đừng tin frontmatter.** `status: completed` mà còn phase chưa có tiêu chí hoàn thành
nào được đánh dấu thì kế hoạch chưa xong — nó chỉ bị bỏ dở. Nói thẳng điều đó với principal.

## 2. Ghi bài học

Trước khi đóng, rút ra cái gì học được. Hai chỗ, đừng nhầm:

| Loại | Ghi vào |
|---|---|
| bài học về **cách bạn làm việc** — quyết định nào sai, vì sao | `identity/<vai>/journal/YYYY-MM.md` |
| fact về **project / principal / thế giới** | `memory/shared/` hoặc `memory/projects/` |

Đây là HOUSE-RULES §2 và CHARTER §2.4. Ghi fact chung vào journal riêng = nhân bản dữ liệu
rồi để nó lệch — cấm.

Bài học phải cụ thể. "Cần lập kế hoạch kỹ hơn" thì vô dụng. "Spike ACL ở P1.0 đổi kiến trúc
P2 — lần sau spike trước khi chia phase" thì dùng được.

## 3. Hỏi principal trước khi đóng

Hỏi thẳng trong phiên. Ba câu:

1. Đóng kế hoạch nào — cụ thể, hay tất cả kế hoạch đã `completed`?
2. Chuyển sang `plans/archive/` hay xoá hẳn?
3. Có commit luôn không?

**Không tự quyết.** Xoá kế hoạch là hành động khó đảo ngược (HOUSE-RULES §1.2) — và
`plans/` có commit vào git, nên xoá nhầm thì lấy lại được, nhưng đừng dựa vào đó.

## 4. Đóng

```bash
mkdir -p plans/archive
git mv plans/<thư-mục-kế-hoạch> plans/archive/
```

Dùng `git mv`, không dùng `mv` — giữ được lịch sử file.

Principal chọn xoá hẳn thì `rm -rf plans/<thư-mục>` — **hỏi lại một lần nữa** trước khi chạy.

Đổi `status:` trong `plan.md` thành `completed` hoặc `cancelled` **trước khi** chuyển đi.

## 5. Dọn quan hệ chặn

Kế hoạch bị đóng có thể đang nằm trong `blockedBy` của kế hoạch khác. Quét `plans/` còn lại,
gỡ tham chiếu tới thư mục vừa đóng.

Bỏ bước này thì lần quét sau sẽ thấy một kế hoạch bị chặn bởi thứ không còn tồn tại — và nó
sẽ bị chặn mãi mãi.

## 6. Báo cáo

```
Đã đóng: N kế hoạch · Đã xoá: N
| Kế hoạch | Trạng thái | Tạo ngày | Ghi chú |
|---|---|---|---|

Journal: identity/<vai>/journal/YYYY-MM.md — <mục nào thêm mới>
Quan hệ chặn đã gỡ: <kế hoạch nào>
Commit: <hash hoặc "chưa — chờ principal">

Câu hỏi còn mở:
- …
```

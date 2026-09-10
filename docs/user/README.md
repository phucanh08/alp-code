# Tài liệu người dùng

Thư mục này là **source of truth** cho site tại <https://alp.anhlp.com/docs/>. Repo
`alp-docs` không giữ bản sao nào; workflow bên đó kéo thư mục này từ `main` rồi build.

Sửa ở đây, không sửa bên `alp-docs`.

## Khác gì phần còn lại của `docs/`

| Đường dẫn | Đối tượng đọc |
|---|---|
| `docs/user/` | Người dùng ALP. Được xuất bản. |
| `docs/*.md`, `docs/plans/` | Người phát triển ALP. Nội bộ, không xuất bản. |

## Thêm hoặc đổi tên một trang

1. Thêm file `.md` với frontmatter `title` và `description`.
2. Thêm một mục vào `sidebar.json` — `path` là đường dẫn tương đối trong thư mục này,
   bỏ đuôi `.md`, chuỗi rỗng là `index.md`.

Bỏ bước 2 thì trang vẫn build nhưng không xuất hiện trong navigation. Ngược lại, để
`sidebar.json` trỏ vào một file không tồn tại sẽ làm gãy build của `alp-docs`; bước
fetch bên đó kiểm tra và fail sớm với thông báo chỉ rõ file nào thiếu.

## Link giữa các trang

Starlight phục vụ mỗi trang tại URL có trailing slash, nên link tương đối resolve theo
URL của trang chứ không theo vị trí file:

- cùng nhóm: `../<tên-trang>/`
- khác nhóm: `../../<nhóm>/<tên-trang>/`

Viết `./<tên-trang>/` sẽ trỏ vào chính thư mục của trang đang đọc và gãy.

## Banner preview

Nhiều trang mô tả tính năng chưa có trong stable binary và đánh dấu bằng aside
`:::caution[Preview, chưa có trong stable vX.Y.Z]`. Khi một release đưa tính năng đó
vào stable, banner phải bị **xoá**, không phải đổi số version.

---
name: gkg
description: Điều hướng code theo ngữ nghĩa bằng GitLab Knowledge Graph — tìm định nghĩa, tìm mọi chỗ gọi, phân tích ảnh hưởng trước khi refactor. Kích hoạt khi ripgrep trả quá nhiều kết quả trùng tên hoặc khi cần chắc đã tìm hết call-site.
---

# gkg — tìm theo ngữ nghĩa, không theo chuỗi

Công cụ **bổ sung** cho `rg`/`Grep`, không thay thế.

Khi nào nó hơn `rg`: tên symbol trùng với từ thông thường, cùng tên ở nhiều module, hoặc
câu hỏi là "sửa chỗ này thì vỡ những đâu" — `rg` trả chuỗi khớp, `gkg` trả quan hệ thật
trong AST.

Khi nào `rg` đủ và nhanh hơn: tên đủ hiếm, tìm trong một thư mục, tìm chuỗi trong config
hay tài liệu. **Mặc định vẫn là `rg`** — `gkg` phải index trước, và index tốn thời gian.

## Kiểm tra trước khi dùng

```bash
gkg --version
```

Chưa cài thì **báo lại, đừng tự cài**. Cài phần mềm là hành động khó đảo ngược
(HOUSE-RULES §1.2). Cứ trả lời bằng `rg` và nói rõ trong báo cáo là chưa có `gkg`.

Cài (chỉ khi đã được duyệt):

```bash
curl -fsSL https://gitlab.com/gitlab-org/rust/knowledge-graph/-/raw/main/install.sh | bash
```

## Quy trình

```bash
gkg index <đường dẫn workspace> --stats   # index — chỉ workspace trong loadout
gkg server start                          # bật server để query
# query qua HTTP API: http://localhost:27495
gkg server stop                           # PHẢI dừng trước khi index lại
```

**Chỉ index workspace có trong `workspaces.read` của `loadout.yaml`.** Index một repo ngoài
danh sách là đọc thứ mình không được đọc, kể cả khi filesystem không chặn.

Dữ liệu index nằm ở `~/.gkg/` — ngoài repo, nên nó sống qua nhiều phiên. Index lại khi code
đã đổi nhiều, đừng index mỗi phiên.

## Ba việc chính

| Việc | Cách |
|---|---|
| Tìm định nghĩa | index → `server start` → query symbol |
| Tìm mọi chỗ gọi | query `get_references` cho symbol đó |
| Phân tích ảnh hưởng | `get_references` cho từng symbol sắp đổi, đọc hết call-site trước khi kết luận |

Phân tích ảnh hưởng là chỗ skill này đáng giá nhất: ai đó sắp refactor và cần biết vỡ
những đâu. Trả lời "tôi grep thấy 3 chỗ" khi thật ra có 11 chỗ gọi gián tiếp là kiểu sai
đắt nhất mà một lượt truy xuất có thể gây ra.

## Hỗ trợ ngôn ngữ — đọc kỹ trước khi tin kết quả

| Ngôn ngữ | Tham chiếu chéo file |
|---|---|
| Ruby, Java, Kotlin | đầy đủ |
| Python, TypeScript, JavaScript | **chưa xong** |

Với TS/JS/Python, `gkg` **có thể bỏ sót** call-site chéo file. Dùng thì phải đối chiếu thêm
bằng `rg`, và trong báo cáo phải ghi rõ là kết quả chưa chắc đầy đủ. Đây là beta công khai,
không phải công cụ đã chín.

## Ràng buộc

- Phải `server stop` trước khi index lại.
- Cần repo đã `git init`.
- Chưa nối tham chiếu **giữa các repo**.
- Loadout không cấp MCP thì dùng HTTP API qua `Bash`, không dùng MCP tool.

## Tham chiếu

| File | Nội dung |
|---|---|
| `references/cli-commands.md` | `gkg index`, `gkg server`, `gkg remove`, `gkg clean` |
| `references/http-api.md` | REST endpoint để query |
| `references/language-support.md` | chi tiết từng ngôn ngữ |

## Báo cáo

Kết luận ngắn, bằng chứng `path:line`, và **nói rõ phần chưa chắc**. Thêm một dòng: tìm bằng `gkg` hay bằng `rg`, vì độ tin cậy hai đường khác nhau.

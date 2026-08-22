# Đọc thẳng repo — khi không có llms.txt

**Đường cuối cùng.** Chậm (5–10 phút), tốn context nhất. Chỉ dùng khi
`topic-search.md` và `library-search.md` đều không ra.

## Khi nào

- Thư viện không có trên context7.com.
- Site chính thức không có `llms.txt`.
- Tài liệu tồn tại nhưng thiếu, phải đọc code mới rõ.

## Quy trình

### 1. Tìm repo

`WebSearch`: `"{thư viện} github repository"`

**Xác minh trước khi clone:** đúng repo chính thức chưa (không phải fork), còn hoạt động
không (commit gần đây), có `docs/` không. Clone nhầm một fork bỏ hoang rồi kết luận theo nó
là sai nguồn.

### 2. Clone

```bash
git clone <repo-url> /tmp/docs-analysis
```

Cần đúng một phiên bản thì `git checkout <tag>`. **Luôn ghi lại tag/commit đã đọc** —
`research` yêu cầu ghi phiên bản kèm ngày cho mọi nguồn.

Clone về máy là tải mã nguồn lạ. Repo lớn hoặc không rõ nguồn gốc → **báo lại trước**.

### 3. Đóng gói

```bash
repomix --version || echo "chưa cài"
cd /tmp/docs-analysis
repomix --token-count-tree           # XEM TRƯỚC token nằm ở đâu
repomix --include "README.md,docs/**,examples/**" -o repomix-output.xml
```

Chưa cài `repomix` thì báo lại, đừng tự `npm install -g` (HOUSE-RULES §1.2).

**Chạy `--token-count-tree` trước và lọc bằng `--include`.** Gói cả repo rồi mới phát hiện
nó 200k token là hỏng cả phiên. Thứ bạn cần gần như luôn nằm ở `README.md`, `docs/`,
`examples/` — không phải toàn bộ `src/`.

### 4. Đọc và rút

Đọc file đã gói, rút theo thứ tự:

| Nguồn trong repo | Cho biết |
|---|---|
| `README.md` | cài đặt, tổng quan, ví dụ tối thiểu |
| `docs/` | hướng dẫn dùng, API reference |
| `examples/` | mẫu code thật |
| `CHANGELOG.md` | breaking change, phiên bản |
| `src/` | chỉ khi tài liệu không trả lời được |

`CHANGELOG.md` hay bị bỏ qua mà nó là nguồn tốt nhất cho câu hỏi "bản này có gì đổi".

### 5. Dọn

```bash
rm -rf /tmp/docs-analysis
```

Bỏ bước này thì lần sau clone đè lên bản cũ và bạn đọc nhầm phiên bản.

## Ghi rõ khi báo cáo

Kết quả từ đường này **không phải tài liệu chính thức**. Bắt buộc ghi:

```
Nguồn: đọc repo <org/repo> tại <tag hoặc commit>, ngày <…>
Lưu ý: rút từ code và README, không phải tài liệu chính thức
Sức khoẻ repo: <số sao, commit gần nhất>
```

Dòng "sức khoẻ repo" quan trọng cho việc đánh giá của `research`: một thư viện không có
commit nào 18 tháng là thông tin, kể cả khi code của nó tốt.

## Không có repo nào

Không tìm được repo thì nói thẳng: không có nguồn sơ cấp. Những gì gom được từ
blog, tutorial, Stack Overflow là **nguồn thứ cấp** — chất lượng không đều, phải đối chiếu
ít nhất hai nguồn độc lập, và phải ghi rõ là thứ cấp trong báo cáo.

Bản gốc của workflow này gợi ý "chia cho nhiều Researcher agent" — bỏ qua nếu loadout
không cho giao việc.

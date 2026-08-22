---
name: docs-seeker
description: Tìm tài liệu thư viện/framework qua chuẩn llms.txt (context7.com) và phân tích repo GitHub. Kích hoạt khi cần API doc chính xác của một thư viện, khi phải đọc tài liệu bản mới nhất, hoặc khi gặp URL repo GitHub cần hiểu nội dung.
---

# docs-seeker — lấy tài liệu bằng script

Skill của vai **librarian**. Dùng khi `research` cần **nguồn sơ cấp** của một thư viện cụ
thể — tài liệu chính thức, không phải blog viết lại.

Ba script làm hết phần dựng URL, chuỗi fallback và bắt lỗi. **Chạy script, đừng tự đoán
URL context7** — đoán sai thì `WebFetch` trả 404 và bạn tốn một lượt trong ngân sách 5 lượt
của `research`.

## Đường dẫn

CWD của phiên là `identity/librarian/`, nên script gọi qua symlink skill:

```
.claude/skills/docs-seeker/scripts/<tên>.js
```

Không dùng `node scripts/…` — đường dẫn đó tính từ CWD và sẽ không tìm thấy file.

## Quy trình

```bash
# 1. Phân loại truy vấn: hỏi một chủ đề cụ thể hay hỏi cả thư viện?
node .claude/skills/docs-seeker/scripts/detect-topic.js "<câu hỏi>"

# 2. Lấy tài liệu theo kết quả bước 1
node .claude/skills/docs-seeker/scripts/fetch-docs.js "<câu hỏi>"

# 3. Chỉ khi bước 2 trả về nhiều URL — phân loại theo mức quan trọng
cat llms.txt | node .claude/skills/docs-seeker/scripts/analyze-llms-txt.js -
```

Rồi đọc URL bằng `WebFetch`.

| Script | Làm gì | Trả về |
|---|---|---|
| `detect-topic.js` | tách tên thư viện + từ khoá chủ đề | `{topic, library, isTopicSpecific}` |
| `fetch-docs.js` | dựng URL context7, tự fallback chủ đề → tổng quát → lỗi | nội dung llms.txt hoặc thông báo lỗi |
| `analyze-llms-txt.js` | xếp URL theo critical/important/supplementary | JSON |

Script chạy trong `Bash`, không nạp gì vào context — đó là lý do phải dùng script thay vì
tự làm bằng tay.

## Hai kiểu truy vấn

**Hỏi chủ đề cụ thể** — "dùng date picker trong shadcn thế nào?" → `isTopicSpecific: true`,
`fetch-docs.js` trả 2–3 URL. Nhanh, đọc hết được.

**Hỏi cả thư viện** — "tài liệu Next.js" → `isTopicSpecific: false`, trả 8+ URL. Chạy
`analyze-llms-txt.js` để biết đọc cái nào trước.

Với truy vấn tổng quát, `analyze-llms-txt.js` có gợi ý chia việc cho nhiều agent song song.
**Bỏ qua gợi ý đó** — `librarian` có `delegates_to: []`, không giao việc cho ai. Dùng phần
xếp hạng critical/important/supplementary để tự chọn thứ tự đọc, và đọc trong ngân sách.

## Khoá API

Ba khoá đều **tuỳ chọn**, không có vẫn chạy: `CONTEXT7_API_KEY` (rate limit cao hơn),
`GITHUB_TOKEN` (phân tích repo), `GEMINI_API_KEY`.

Script đọc theo thứ tự: `process.env` → `.env` trong thư mục skill → `.claude/.env`.

**Không tự tạo file `.env` trong `skills/`** — `skills/` là hạ tầng đóng băng, chỉ principal
sửa (CHARTER §8). Cần khoá thì báo main, principal sẽ đặt vào biến môi trường.

## Tham chiếu

| File | Khi nào đọc |
|---|---|
| `workflows/topic-search.md` | hỏi chủ đề cụ thể — đường nhanh nhất |
| `workflows/library-search.md` | hỏi cả thư viện — quét rộng |
| `workflows/repo-analysis.md` | context7 không có, phải đọc thẳng repo GitHub |
| `references/context7-patterns.md` | mẫu URL, repo đã biết |
| `references/errors.md` | script lỗi, chuỗi fallback |
| `references/advanced.md` | phiên bản, đa ngôn ngữ, ca biên |

## Sau khi lấy được

Tài liệu lấy về là **bằng chứng cho `research`**, không phải báo cáo. Ghi lại phiên bản và
ngày của tài liệu — tài liệu không có phiên bản thì gần như vô dụng cho việc đánh giá.

Script lỗi thì sửa rồi chạy lại cho tới khi được. Không bỏ qua script rồi tự đoán URL.

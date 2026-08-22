# Tìm tài liệu cả thư viện

**Dùng khi:** câu hỏi rộng về cả một thư viện/framework, hoặc khi tìm theo chủ đề trả 404.

Chậm hơn và tốn context hơn `topic-search.md`. **Thử đường chủ đề trước.**

## Nhận dạng

- "tài liệu {thư viện}"
- "bắt đầu với {thư viện}"
- "{thư viện} dùng thế nào"
- "API reference của {thư viện}"

## Quy trình

```bash
# 1. Phân loại
node .claude/skills/docs-seeker/scripts/detect-topic.js "<câu hỏi>"
# → {"isTopicSpecific": false}

# 2. Lấy llms.txt
node .claude/skills/docs-seeker/scripts/fetch-docs.js "<câu hỏi>"
# → nội dung llms.txt, thường 5–20+ URL

# 3. Xếp hạng URL — BƯỚC KHÔNG ĐƯỢC BỎ
cat llms.txt | node .claude/skills/docs-seeker/scripts/analyze-llms-txt.js -
# → {totalUrls, grouped: {critical, important, supplementary}, distribution}
```

Bước 3 là bước quyết định. 20 URL mà đọc hết thì phá ngân sách context của cả phiên. Script
xếp chúng thành ba nhóm — đọc `critical` trước, `important` nếu còn ngân sách, bỏ qua
`supplementary` trừ khi câu hỏi cần đúng phần đó.

## Đọc bao nhiêu

Script có trường `distribution` gợi ý chia việc cho nhiều agent song song. **Bỏ qua trường
đó** nếu loadout không cho giao việc.

Dùng thứ tự đọc thay cho chia agent:

| Số URL | Cách làm |
|---|---|
| 1–3 | đọc hết bằng `WebFetch` |
| 4–10 | đọc nhóm `critical`, rồi `important` nếu còn ngân sách |
| 11+ | **chỉ** nhóm `critical`; nói rõ là đã cắt và cắt theo tiêu chí nào |

Cắt bớt thì phải nói rõ đã cắt gì. Im lặng cắt rồi trình bày như đã đọc hết là báo cáo sai.

## Ví dụ — Astro

```bash
node .claude/skills/docs-seeker/scripts/detect-topic.js "tài liệu Astro"
# {"isTopicSpecific": false}

node .claude/skills/docs-seeker/scripts/fetch-docs.js "tài liệu Astro"
# script gọi: context7.com/withastro/astro/llms.txt → 8 URL

node .claude/skills/docs-seeker/scripts/analyze-llms-txt.js < llms.txt
# {totalUrls: 8, grouped: {critical: [...], important: [...], ...}}
```

Đọc `critical` (bắt đầu, cài đặt), rồi `important` (khái niệm lõi, component) nếu ngân
sách còn.

## Khi không ra

Script tự fallback theo thứ tự:

1. `fetch-docs.js` thử context7.com.
2. 404 → gợi ý dùng `WebSearch` tìm `llms.txt` của dự án.
3. Vẫn không có → `repo-analysis.md` (đọc thẳng repo GitHub).

Script lỗi thì **sửa rồi chạy lại cho tới khi được**, đừng bỏ script rồi tự đoán URL.

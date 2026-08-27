# Tìm tài liệu theo chủ đề cụ thể

**Dùng khi:** cần tài liệu về một tính năng / component / khái niệm cụ thể.

Nhanh nhất (10–15s), tốn ít token nhất, kết quả trúng đích nhất. **Đây là đường mặc định** —
chỉ chuyển sang tìm cả thư viện khi đường này không ra.

## Nhận dạng

- "dùng {tính năng} trong {thư viện} thế nào?"
- "tài liệu {component} của {thư viện}"
- "triển khai {tính năng} bằng {thư viện}"

## Quy trình

Đường dẫn tính từ CWD của phiên (`active workspace`), qua symlink skill.

```bash
# 1. Phân loại truy vấn
node .claude/skills/docs-seeker/scripts/detect-topic.js "<câu hỏi>"
# → {"topic": "X", "library": "Y", "isTopicSpecific": true}

# 2. Lấy tài liệu — script tự dựng URL và tự fallback
node .claude/skills/docs-seeker/scripts/fetch-docs.js "<câu hỏi>"
# script gọi: context7.com/{library}/llms.txt?topic={topic}
# → nội dung llms.txt, thường 1–5 URL
```

Rồi đọc URL bằng `WebFetch`.

**1–5 URL thì đọc thẳng.** Bản gốc của workflow này có bước "chia cho 2–3 Explorer agent
song song" — bỏ qua nếu loadout không cho giao việc. Đọc tuần tự, trong ngân sách 5 lượt
của `research`.

## Ví dụ

**Date picker của shadcn**

```bash
node .claude/skills/docs-seeker/scripts/detect-topic.js "dùng date picker trong shadcn thế nào?"
# {"topic": "date", "library": "shadcn/ui", "isTopicSpecific": true}

node .claude/skills/docs-seeker/scripts/fetch-docs.js "dùng date picker trong shadcn thế nào?"
# script gọi: context7.com/shadcn-ui/ui/llms.txt?topic=date
# → 2–3 URL về date
```

**Cache của Next.js**

```bash
node .claude/skills/docs-seeker/scripts/detect-topic.js "Next.js caching strategies"
# {"topic": "cache", "library": "next.js", "isTopicSpecific": true}
# script gọi: context7.com/vercel/next.js/llms.txt?topic=cache
```

## Vì sao đường này đáng ưu tiên

Trả về **chỉ tài liệu liên quan**, không phải toàn bộ thư viện. Nhanh hơn nhiều lần và
không phải lọc — quan trọng vì lý do một lượt tra cứu tồn tại là giữ context của bên giao
việc sạch.

## Khi không ra

URL theo chủ đề trả 404 → chuyển sang `library-search.md` (tìm cả thư viện).

context7 không có thư viện đó → `repo-analysis.md` (đọc thẳng repo GitHub).

Cả ba đều không ra → nói thẳng là không tìm được tài liệu sơ cấp, và những gì tìm
được là nguồn thứ cấp. Đừng lấp bằng blog rồi trình bày như tài liệu chính thức.

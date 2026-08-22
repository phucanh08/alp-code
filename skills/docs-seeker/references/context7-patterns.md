# Mẫu URL context7.com

Tài liệu này để **hiểu script đang làm gì** và để gỡ khi script hỏng. Bình thường cứ chạy
script — đoán URL bằng tay thì sai là tốn một lượt trong ngân sách 5 lượt của `research`.

## Ưu tiên 1 — URL theo chủ đề

```
https://context7.com/{path}/llms.txt?topic={từ khoá}
```

Trả về **chỉ tài liệu liên quan tới chủ đề**. Nhanh hơn nhiều lần, ít token hơn nhiều.

| Câu hỏi | URL |
|---|---|
| date picker của shadcn/ui | `context7.com/shadcn-ui/ui/llms.txt?topic=date` |
| caching của Next.js | `context7.com/vercel/next.js/llms.txt?topic=cache` |
| OAuth của Better Auth | `context7.com/better-auth/better-auth/llms.txt?topic=oauth` |
| nén của FFmpeg | `context7.com/websites/ffmpeg_doxygen_8_0/llms.txt?topic=compress` |

## Ưu tiên 2 — URL cả thư viện

```
https://context7.com/{org}/{repo}/llms.txt          # repo GitHub
https://context7.com/websites/{đường-dẫn}/llms.txt  # website
```

Dùng khi câu hỏi rộng, hoặc URL theo chủ đề trả 404.

## Ánh xạ tên đã biết

Tên thông dụng không trùng đường dẫn repo:

| Người ta gọi | Đường dẫn thật |
|---|---|
| `next.js`, `nextjs` | `vercel/next.js` |
| `astro` | `withastro/astro` |
| `remix` | `remix-run/remix` |
| `shadcn`, `shadcn/ui` | `shadcn-ui/ui` |
| `better-auth` | `better-auth/better-auth` |

## Chuẩn hoá từ khoá chủ đề

- Viết thường.
- Bỏ ký tự đặc biệt.
- Chủ đề nhiều từ → lấy từ đầu.
- Tối đa 20 ký tự.

| Câu hỏi có | Từ khoá |
|---|---|
| "date picker" | `date` |
| "OAuth" | `oauth` |
| "Server-Side" | `server` |
| "caching strategies" | `caching` |

## Dự phòng — site chính thức

**Chỉ dùng khi context7.com không truy cập được:**

```
Astro:      https://docs.astro.build/llms.txt
Next.js:    https://nextjs.org/llms.txt
Remix:      https://remix.run/llms.txt
SvelteKit:  https://kit.svelte.dev/llms.txt
```

Dùng đường dự phòng thì **ghi rõ trong báo cáo** — nguồn khác nhau có thể ở phiên bản khác
nhau, và `research` yêu cầu ghi phiên bản kèm ngày cho mọi nguồn.

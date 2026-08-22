# Lỗi và chuỗi dự phòng

## Loại lỗi

| Lỗi | Nghĩa thường là |
|---|---|
| **404** | URL theo chủ đề không có · thư viện không có trên context7 · không có `llms.txt` |
| **Timeout** | mạng · repo lớn khi clone · API chậm |
| **Phản hồi hỏng** | `llms.txt` sai định dạng · nội dung rỗng · URL không hợp lệ |

**404 không có nghĩa là thư viện không tồn tại.** Nó chỉ nghĩa là context7 không có bản
index cho đường dẫn đó. Kiểm lại tên repo trong `context7-patterns.md` trước khi bỏ cuộc —
tên thông dụng thường khác đường dẫn repo (`next.js` → `vercel/next.js`).

## Chuỗi dự phòng

### Hỏi chủ đề cụ thể

```
1. URL theo chủ đề     context7.com/{lib}/llms.txt?topic={từ khoá}
   ↓ 404
2. URL cả thư viện     context7.com/{lib}/llms.txt
   ↓ 404
3. WebSearch           "{lib} llms.txt site:{domain chính thức}"
   ↓ không có
4. Đọc thẳng repo      workflows/repo-analysis.md
```

### Hỏi cả thư viện

```
1. context7.com/{lib}/llms.txt
   ↓ 404
2. WebSearch "{lib} llms.txt"
   ↓ không có
3. Đọc thẳng repo
   ↓ không có repo
4. Nguồn thứ cấp — và PHẢI ghi rõ là thứ cấp
```

Bước 4 trong bản gốc là "chia cho nhiều Researcher agent" — không áp dụng khi loadout
không cho giao việc: tự gom nguồn thứ cấp, đối chiếu hai nguồn độc lập, và nói rõ trong
báo cáo rằng không có nguồn sơ cấp.

## Timeout

| Thao tác | Giới hạn |
|---|---|
| `WebFetch` | 60s |
| clone repo | 5 phút |
| `repomix` | 10 phút |

**Hỏng thì bỏ, đừng thử lại cách vừa hỏng.** Chuyển sang bước dự phòng kế tiếp. Thử lại
cùng một URL 404 ba lần chỉ tốn ngân sách — `research` chỉ có 5 lượt.

## Kết quả rỗng

`llms.txt` trả về 0 URL:

1. **Ghi vào báo cáo** — rỗng là thông tin, không phải "không có gì để nói".
2. Thử đọc thẳng repo.
3. Kiểm site chính thức bằng tay.

Đừng để kết quả rỗng biến thành im lặng. Bên giao việc không phân biệt được "đã tìm và không có" với
"quên tìm" nếu bạn không nói.

## Script hỏng

Script trong `scripts/` lỗi thì **sửa rồi chạy lại cho tới khi được** — đó là luật của repo.
Đừng bỏ script rồi tự dựng URL bằng tay: script có sẵn chuỗi fallback, làm tay là mất nó.

Sửa không được thì báo lại, kèm lỗi nguyên văn.

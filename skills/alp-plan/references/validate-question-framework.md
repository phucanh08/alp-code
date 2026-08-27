# Khung câu hỏi kiểm chứng

## Nhóm câu hỏi

Quét kế hoạch tìm những từ này — chúng đánh dấu chỗ kế hoạch đang **quyết thay principal**:

| Nhóm | Từ khoá cần soi |
|---|---|
| **Kiến trúc** | "cách tiếp cận", "mẫu", "thiết kế", "cấu trúc", "database", "API" |
| **Giả định** | "giả sử", "kỳ vọng", "sẽ", "phải", "mặc định" |
| **Đánh đổi** | "đánh đổi", "so với", "phương án", "hoặc" |
| **Rủi ro** | "rủi ro", "có thể hỏng", "phụ thuộc", "chặn", "lo ngại" |
| **Phạm vi** | "phase", "bản tối thiểu", "sau này", "ngoài phạm vi", "có thì tốt" |

Từ **"mặc định"** và **"giả sử"** đáng soi nhất: chúng thường đánh dấu một quyết định đã
được đưa ra mà không ai để ý là đã có quyết định.

## Luật soạn câu hỏi

- Mỗi câu **2–4 phương án cụ thể**, không hỏi mở.
- Đánh dấu phương án bạn đề nghị, kèm một câu vì sao.
- Câu hỏi phải làm **lộ ra một quyết định ngầm**, không phải hỏi cho có.
- **Chỉ hỏi điểm quyết định thật.** Tự trả lời được từ code, từ `compiled policy invariants`, hay từ quy
  ước sẵn có thì đừng hỏi — đó là đẩy việc ngược về principal.

## Ví dụ

**Kiến trúc**

> Kết quả kiểm chứng lưu ở đâu?
> 1. Thêm mục vào `plan.md` *(đề nghị — plan là nguồn sự thật duy nhất, compiled policy invariants)*
> 2. Tạo file `validation-answers.md` riêng
> 3. Không lưu

**Giả định**

> Kế hoạch đang giả định không cần giới hạn tần suất. Đúng không?
> 1. Đúng, bản đầu chưa cần
> 2. Không, thêm mức cơ bản ngay *(đề nghị — thêm sau tốn hơn nhiều)*
> 3. Hoãn sang phase 2

## Mẫu nhật ký kiểm chứng

```markdown
## Nhật ký kiểm chứng

### Lượt {N} — {YYYY-MM-DD}
**Vì sao kiểm chứng:** {cái gì dẫn tới lượt này}
**Số câu hỏi:** {n}

#### Hỏi và đáp

1. **[{Nhóm}]** {nguyên văn câu hỏi}
   - Phương án: {A} | {B} | {C}
   - **Principal chọn:** {đáp án}
   - **Nguyên văn nếu principal trả lời khác:** {chép đúng chữ}
   - **Vì sao quan trọng:** {quyết định này ảnh hưởng gì}

#### Quyết định đã chốt
- {quyết định}: {lựa chọn} — {vì sao}

#### Việc phải làm
- [ ] {thay đổi cụ thể}

#### Ảnh hưởng tới phase
- Phase {N}: {phải sửa gì, vì sao}
```

## Luật ghi

- **Nguyên văn câu hỏi**, không tóm tắt.
- **Đủ mọi phương án đã trình** — để sau này biết principal đã chọn giữa những gì.
- **Chép đúng chữ** nếu principal trả lời ngoài các phương án. Diễn giải lại là bóp méo.
- **Ghi vì sao** quyết định đó ảnh hưởng tới cách triển khai.
- **Đánh số lượt** tăng dần.

## Lan quyết định xuống phase

| Loại thay đổi | Sửa vào mục nào của phase |
|---|---|
| yêu cầu | Việc phải làm |
| kiến trúc | Kiến trúc / Việc phải làm |
| phạm vi | Mục tiêu, và **Ngoài phạm vi** của `plan.md` |
| rủi ro | Rủi ro |
| chưa rõ thuộc đâu | thêm mục mới, đừng nhét bừa |

Bước lan xuống phase là bước hay bị bỏ nhất và đắt nhất: người thực thi đọc **phase**, chứ
không đọc `plan.md`. Ghi quyết định vào `plan.md` rồi quên sửa phase nghĩa là quyết định đó
không tồn tại.

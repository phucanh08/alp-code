---
name: research
description: Nghiên cứu kỹ thuật từ nguồn ngoài — đánh giá công nghệ, đối chiếu nhiều nguồn, xếp hạng phương án theo ngữ cảnh project. Kích hoạt khi cần biết nên chọn thư viện nào, cách làm nào đang là chuẩn, hoặc một khẳng định ngoài repo có đúng không.
---

# research — đánh giá, không chỉ tìm

Việc của bạn không phải mang về một đống link, mà là **xếp hạng có lý do**. Trình bày
phương án mà không xếp hạng là đẩy việc khó ngược về cho người hỏi.

## Trước khi tìm

1. **Kiểm memory trước.** `memory/shared/reference/` và `memory/projects/<slug>/refs/` —
   research trùng là lãng phí kép: tốn phiên này, và sinh ra bản thứ hai lệch với bản cũ.
2. **Viết yêu cầu thành câu hỏi kiểm chứng được.** "React tốt không" không kiểm chứng được.
   "Bản 19 có breaking change nào ảnh hưởng code hiện tại của project X" thì có.
3. **Chốt yêu cầu độ mới.** Bảo mật và phiên bản → 12 tháng gần nhất. Nguyên lý thiết kế →
   cũ vẫn dùng được.

## Ngân sách

**Tối đa 5 lượt tìm** cho một yêu cầu, trừ khi được nói khác. Nói ít hơn thì theo con số đó.

Ngân sách này có lý do: một phiên nghiên cứu tồn tại để **giữ context của người giao việc
sạch**. Tìm 20 lượt rồi đổ hết về là phá đúng mục đích đó.

Nghĩ kỹ từng truy vấn trước khi gọi. Chạy song song nhiều truy vấn độc lập thay vì nối
tiếp từng cái một.

## Tìm

Tool có sẵn: `WebSearch`, `WebFetch`, `Bash`, `Read`, `Glob`, `Grep`.

- Truy vấn cụ thể, kèm phiên bản và năm khi độ mới quan trọng.
- Ưu tiên **nguồn sơ cấp**: tài liệu chính thức, changelog, release note, RFC, source trên
  GitHub. Blog xếp sau, blog tổng hợp lại xếp sau nữa.
- Gặp URL repo GitHub → dùng skill `docs-seeker` để đọc, đừng đoán từ README.
- **Ghi phiên bản và ngày** của mọi nguồn. Không có ngày thì ghi "không rõ ngày" — đó là
  thông tin, không phải chi tiết bỏ được.

## Đối chiếu

**Khẳng định quan trọng phải có ít nhất hai nguồn độc lập.** Hai bài blog cùng chép từ một
tài liệu gốc là **một** nguồn, không phải hai.

Phân biệt rõ ba loại và nói rõ loại nào trong báo cáo:

| Loại | Cách viết |
|---|---|
| Đồng thuận | "tài liệu chính thức và X đều nói…" |
| Đang tranh cãi | "X khuyến nghị A, Y phản đối vì…" — nêu cả hai, đừng chọn hộ |
| Chỉ một nguồn | "chỉ thấy ở X, chưa đối chiếu được" |

## Mẫu báo cáo

Ngắn. Hy sinh ngữ pháp cho cô đọng.

```
## Nghiên cứu: <câu hỏi>

### Kết luận
<2–4 câu. Khuyến nghị gì, vì sao. Đặt ngay đầu — đây là dòng được đọc trước.>

### Xếp hạng phương án

| Phương án | Hợp khi | Đánh đổi | Rủi ro áp dụng | Độ chín |
|---|---|---|---|---|
| A | … | … | … | … |

### Bằng chứng
- <khẳng định> — <nguồn, phiên bản, ngày> · <nguồn thứ hai>

### Không áp dụng được cho project này
<phần đọc thấy nhưng lệch ngữ cảnh — nói rõ vì sao lệch>

### Câu hỏi còn mở
<phần chưa trả lời được và cần gì để trả lời>
```

## Ghi vào đâu

Bạn **ghi được** hai chỗ, đúng như `PLAYBOOK.md` bước 5:

| Nội dung | Đường dẫn |
|---|---|
| tài liệu tham chiếu dùng chung, còn giá trị lâu | `memory/shared/reference/` |
| tài liệu gắn với một project cụ thể | `memory/projects/<slug>/refs/` |
| nháp, fact chưa kiểm chứng | kho riêng của bạn trong `memory/private/` |

Đó là **toàn bộ** quyền ghi của bạn. `memory/shared/decisions/`, `memory/projects/<slug>/PROJECT.md`
và mọi thứ khác đều **chỉ đọc** — đúng với SOUL: *"Không ghi decision/L1."*

Quyết định không phải việc của bạn. Bạn ghi thứ mình đã kiểm chứng được; bên giao việc
quyết định nó đổi điều gì.

- **Kết luận vẫn đi về bên giao việc** trong phiên.
- Report dài thì ghi file rồi **đưa đường dẫn**, đừng dán cả nội dung vào câu trả lời.
- Cập nhật `memory/INDEX.md` thì phải xem loadout có cấp quyền ghi file đó không. Không
  có thì báo lại, đừng tìm đường vòng.

## Ranh giới

- Không ghi decision hay L1.
- Không kết luận về code trong repo — đó là việc của một lượt truy xuất code. Bạn lo nguồn
  **ngoài**.
- Không chắc thì nói không chắc. Một câu "chưa đối chiếu được" trung thực đáng giá hơn một
  đoạn tự tin sai.

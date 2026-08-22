# Khi bế tắc — chọn kỹ thuật

Mỗi dạng bế tắc cần một kỹ thuật khác. Chẩn đoán sai dạng thì kỹ thuật vô dụng.

## Cây quyết định

```
BẾ TẮC
│
├─ Độ phức tạp phình? Cùng một thứ làm 5 kiểu? Special case mọc thêm mãi?
│  └─→ Thác đơn giản hoá
│
├─ Không tìm được cách hợp? Cách thông thường không đủ?
│  └─→ Vùng va chạm
│
├─ Cùng vấn đề ở nhiều chỗ? Phát minh lại bánh xe? Thấy quen quen?
│  └─→ Nhận mẫu meta
│
├─ Giải pháp thấy gượng? "Buộc phải làm thế này"? Kẹt vì một giả định?
│  └─→ Bài tập đảo ngược
│
├─ Chạy thật có chịu nổi không? Edge case chưa rõ? Không rõ giới hạn?
│  └─→ Trò chơi quy mô
│
└─ Code hỏng? Hành vi sai? Test fail?
   └─→ KHÔNG phải bế tắc tư duy. Dùng skill `alp-debug`
```

Nhánh cuối quan trọng: bug không phải bế tắc. Bug là thiếu bằng chứng. Đừng đem kỹ thuật
gỡ bế tắc ra dùng khi thứ bạn cần chỉ là đọc thêm log.

## Bảng chẩn đoán

| Kiểu bế tắc | Triệu chứng cụ thể | Đọc |
|---|---|---|
| **Phức tạp phình** | cùng một thứ 5 kiểu, special case mọc thêm, if/else chồng chất | `simplification-cascades.md` |
| **Cần đột phá** | cách thông thường không đủ, không tìm được hướng hợp | `collision-zone-thinking.md` |
| **Mẫu lặp lại** | cùng vấn đề ở nhiều nơi, cảm giác đã gặp rồi | `meta-pattern-recognition.md` |
| **Kẹt vì giả định** | "buộc phải thế này", không dám chất vấn tiền đề | `inversion-exercise.md` |
| **Không rõ quy mô** | chạy thật thế nào chưa biết, edge case chưa rõ | `scale-game.md` |
| **Code hỏng** | hành vi sai, test fail | skill `alp-debug` |

## Cách làm

1. **Chẩn đoán dạng bế tắc** — khớp triệu chứng ở bảng trên.
2. **Đọc đúng file kỹ thuật đó.**
3. **Áp dụng theo quy trình, không rút gọn.** Rút gọn là quay về kiểu nghĩ cũ — đúng thứ
   đang làm bạn bế tắc.
4. **Ghi lại đã thử gì, kết quả sao.**
5. **Vẫn tắc** → đổi kỹ thuật khác, hoặc kết hợp.

**Một kỹ thuật một lúc.** Trộn hai kỹ thuật ngay từ đầu thì không biết cái nào có tác dụng.

## Kết hợp

- **Đơn giản hoá + Nhận mẫu meta** — tìm mẫu trước, rồi đơn giản hoá mọi thể hiện.
- **Va chạm + Đảo ngược** — ép ẩn dụ, rồi lật giả định của chính ẩn dụ đó.
- **Quy mô + Đơn giản hoá** — cực trị cho thấy nên bỏ cái gì.
- **Nhận mẫu meta + Quy mô** — nguyên lý chung đem thử ở cực trị.

## Khi không kỹ thuật nào ăn thua

1. **Đóng khung lại vấn đề** — có đang giải đúng bài toán không?
2. **Giải thích cho người khác** — viết ra thành báo cáo thường tự lộ chỗ hổng.
3. **Thu nhỏ phạm vi** — giải bản nhỏ hơn trước.
4. **Chất vấn ràng buộc** — ràng buộc đó có thật, hay chỉ là giả định?

Vẫn không ra thì **nói thẳng là chưa ra**, kèm những gì đã loại trừ. Một câu
"chưa xác định được, đã loại trừ A, B, C" đáng giá hơn một khuyến nghị đoán bừa —
Một lượt gỡ bế tắc được mở ra vì độ tin cậy, không vì tốc độ.

## Nhớ

- Khớp triệu chứng với kỹ thuật, đừng chọn theo cái mình quen.
- Ghi lại đã thử gì — để người đọc không đi lại đường cũ.
- Bế tắc là tạm thời, không phải vĩnh viễn.

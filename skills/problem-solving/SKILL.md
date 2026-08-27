---
name: problem-solving
description: Sáu kỹ thuật gỡ bế tắc có hệ thống — dùng khi độ phức tạp phình ra, khi giải pháp thông thường không đủ, khi cùng một vấn đề lặp ở nhiều nơi, khi bị ép vào "chỉ có một cách", hoặc khi không rõ có chịu nổi quy mô thật.
---

# problem-solving — gỡ bế tắc có hệ thống

Dùng khi *đã* thử và *đã* bế tắc — nên việc của skill này không phải nghĩ chăm hơn, mà là
**đổi kiểu nghĩ**.

Mỗi kỹ thuật nhắm một dạng bế tắc khác nhau. Chẩn đoán sai dạng thì kỹ thuật vô dụng, nên
bước 1 là bước quan trọng nhất.

## Chẩn đoán trước

| Triệu chứng | Kỹ thuật | Đọc |
|---|---|---|
| cùng một thứ triển khai 5 kiểu, special case cứ mọc thêm | **Thác đơn giản hoá** | `references/simplification-cascades.md` |
| cách thông thường không đủ, cần đột phá | **Vùng va chạm** | `references/collision-zone-thinking.md` |
| cùng một vấn đề ở nhiều chỗ khác nhau, phát minh lại bánh xe | **Nhận mẫu meta** | `references/meta-pattern-recognition.md` |
| giải pháp thấy gượng, "buộc phải làm thế này" | **Bài tập đảo ngược** | `references/inversion-exercise.md` |
| chạy thật có chịu nổi không, edge case chưa rõ | **Trò chơi quy mô** | `references/scale-game.md` |
| không rõ dùng cái nào | **Khi bế tắc** | `references/when-stuck.md` |

## Sáu kỹ thuật

### 1. Thác đơn giản hoá
Tìm **một** nhận định xoá được nhiều thành phần cùng lúc: "nếu điều này đúng thì không cần
X, Y, Z nữa."

Cốt lõi: mọi thứ đang có đều là trường hợp riêng của một mẫu chung chưa được đặt tên.
Cờ đỏ: "chỉ cần thêm một case nữa thôi" — lặp mãi không hết.

### 2. Vùng va chạm
Ép hai khái niệm không liên quan vào nhau để lộ tính chất mới: "nếu coi X như Y thì sao?"

Cốt lõi: ý tưởng đột phá đến từ trộn ẩn dụ có chủ đích, không từ nghĩ chăm hơn trong cùng
một khung.
Cờ đỏ: "tôi thử hết cách trong mảng này rồi."

### 3. Nhận mẫu meta
Tìm mẫu xuất hiện ở 3+ lĩnh vực khác nhau để rút ra nguyên lý dùng chung được.

Cốt lõi: mẫu về **cách các mẫu hình thành** cho ra trừu tượng tái dùng được.
Cờ đỏ: "vấn đề này là đặc thù, không giống ai" — hầu như luôn sai.

### 4. Bài tập đảo ngược
Lật giả định lõi để lộ ràng buộc ngầm: "nếu ngược lại thì sao?"

Cốt lõi: đảo ngược *hợp lệ* cho thấy "luật" thật ra chỉ đúng trong một ngữ cảnh.
Cờ đỏ: "chỉ có một cách làm thôi."

### 5. Trò chơi quy mô
Thử ở cực trị: lớn gấp 1000, nhỏ đi 1000, tức thì, kéo dài một năm.

Cốt lõi: thứ chạy tốt ở quy mô này hỏng ở quy mô khác — và cực trị lộ ra đâu là bản chất,
đâu là ngẫu nhiên.
Cờ đỏ: "chắc scale được thôi" mà chưa thử.

### 6. Khi bế tắc
Cây quyết định để chọn năm cái trên. Dùng khi chẩn đoán không ra dạng bế tắc.

## Cách áp dụng

1. **Chẩn đoán dạng bế tắc** từ mô tả của việc được giao — bảng trên.
2. **Đọc file reference** của kỹ thuật đó. SKILL.md này chỉ là bảng điều phối; quy trình
   thật nằm trong reference.
3. **Áp dụng theo đúng quy trình**, không rút gọn. Rút gọn là quay lại kiểu nghĩ cũ.
4. **Ghi lại cái gì hiệu quả, cái gì không.** Bài học về chính cách bạn làm việc →
   `memory/private/<vai>/journal/YYYY-MM.md`. Fact về project → báo lại; bên giao việc quyết
   định ghi vào `memory/` chung hay không.

## Kết hợp

- **Đơn giản hoá + Nhận mẫu meta** — tìm mẫu trước, rồi đơn giản hoá mọi thể hiện của nó.
- **Va chạm + Đảo ngược** — ép ẩn dụ, rồi lật giả định của chính ẩn dụ đó.
- **Quy mô + Đơn giản hoá** — cực trị cho thấy nên bỏ cái gì.
- **Nhận mẫu meta + Quy mô** — nguyên lý chung đem thử ở cực trị.

## Ranh giới

Đây là việc **đọc và suy luận**, không phải việc sửa. Kết quả là một khuyến nghị, không
phải một thay đổi trong code — kể cả khi loadout có cấp `Edit`.

Cần dữ liệu bạn không tự lấy được → **nói rõ cần gì** rồi báo lại. Đừng đoán bù vào chỗ
thiếu dữ liệu.

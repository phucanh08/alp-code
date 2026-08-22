# Bước 0 — thách thức phạm vi

Chạy **trước** khi thu thập bối cảnh hay thiết kế. Ép làm rõ ý định trước khi đổ thời gian
vào một kế hoạch sai cỡ.

Đây là bước rẻ nhất và hay bị bỏ nhất. Một câu hỏi ở đây tiết kiệm cả một pha thu thập.

## Bỏ qua khi

- Việc nhỏ rõ ràng: sửa một file, sửa chính tả, đổi config không có nhánh logic.
- Principal nói "cứ lập nhanh thôi" hoặc có tín hiệu gấp.
- Mô tả dưới 20 từ và không mơ hồ.

## Ba câu hỏi

### 1. Cái gì đã có sẵn?

Quét repo tìm code đã giải một phần bài toán. Tiện ích, module, mẫu nào dùng lại được.

alp-code có nguyên tắc thành văn cho chuyện này — `README.md`: `scripts/lib/` là "MỘT nguồn
cho mỗi loại config". Kế hoạch dựng thêm một nguồn thứ hai cho cùng loại dữ liệu là kế
hoạch sai, không phải kế hoạch lớn.

Không chắc → giao đi một lượt truy xuất code trước khi trả lời.

### 2. Tập thay đổi tối thiểu là gì?

Phần nào hoãn được mà không chặn mục tiêu lõi? Phũ với chính mình ở đây: cái "tiện thì làm
luôn" đội lốt yêu cầu là dạng phình phạm vi khó thấy nhất.

Đây chính là YAGNI, áp dụng cho kế hoạch trước khi áp dụng cho code.

### 3. Kiểm tra độ phức tạp

| Ngưỡng | Phải làm gì |
|---|---|
| đụng **> 8 file** | thách thức: cùng mục tiêu đó làm với ít file hơn được không? |
| thêm **> 2 module/lớp mới** | mùi. Biện minh từng cái, hoặc bỏ |
| **> 3 phase** | xem có gộp phase được không |

Vượt ngưỡng không có nghĩa là sai. Nó có nghĩa là **phải giải thích được**, và lời giải
thích đi vào `plan.md`.

## Chốt phạm vi với principal

Hỏi thẳng trong phiên, không cần tool nào.

Trình bày kết quả ba câu trên rồi hỏi chọn một trong ba hướng:

| Hướng | Nghĩa |
|---|---|
| **MỞ RỘNG** | làm bản đầy đủ — nghiên cứu sâu, khám phá phương án lân cận, chấp nhận nhiều phase |
| **GIỮ NGUYÊN** | phạm vi đang đúng — dồn sức vào failure mode, edge case, tiêu chí kiểm chứng |
| **THU HẸP** | cắt còn cốt lõi — hoãn mọi thứ không chặn, ít phase, kiến trúc đơn giản |

## Luật quan trọng nhất

**Principal chọn rồi thì TÔN TRỌNG.**

Không được:

- Âm thầm thu hẹp khi principal chọn GIỮ NGUYÊN hoặc MỞ RỘNG.
- Âm thầm mở rộng khi principal chọn THU HẸP.
- Cãi lại về phạm vi ở các mục sau của kế hoạch.

Nêu lo ngại về phạm vi **một lần**, ở bước 0. Sau đó cam kết với phạm vi đã chọn và tối ưu
bên trong nó. Đây cũng là HOUSE-RULES §1.7: cắt giảm phạm vi là quyền của principal.

## Đầu ra

Trước khi sang bước tiếp, xuất tóm tắt ngắn:

```
Thách thức phạm vi:
- Đã có sẵn: <cái gì dùng lại được>
- Tối thiểu: <cái gì thiết yếu, cái gì hoãn được>
- Độ phức tạp: <ước lượng số file, module mới>
- Hướng đã chốt: MỞ RỘNG | GIỮ NGUYÊN | THU HẸP
```

Phần "hoãn được" đi thẳng vào mục **Ngoài phạm vi** của `plan.md` — đừng để nó chỉ tồn tại
trong context của phiên này.

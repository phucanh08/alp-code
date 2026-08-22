# Cổng kiểm chứng trước khi nói "xong"

Nói xong mà chưa kiểm chứng là **nói dối**, không phải làm nhanh.

Nguyên tắc: bằng chứng trước, khẳng định sau. Luôn luôn.

**Lách câu chữ của luật này là vi phạm luật này.**

## Luật sắt

```
KHÔNG TUYÊN BỐ HOÀN THÀNH KHI CHƯA CÓ BẰNG CHỨNG MỚI
```

Chưa chạy lệnh kiểm chứng **trong phiên này** thì không được nói nó pass.

## Hàm cổng

```
TRƯỚC khi nói bất cứ trạng thái nào, hoặc tỏ ra hài lòng:

1. XÁC ĐỊNH: lệnh nào chứng minh được khẳng định này?
2. CHẠY:     chạy ĐỦ lệnh đó, mới, không cắt
3. ĐỌC:      đọc hết output, xem exit code, đếm số fail
4. ĐỐI CHIẾU: output có xác nhận khẳng định không?
   - KHÔNG → nói trạng thái thật, kèm bằng chứng
   - CÓ    → nói khẳng định, KÈM bằng chứng
5. RỒI MỚI: phát biểu

Bỏ bước nào = nói dối, không phải kiểm chứng
```

## Bảng đối chiếu

| Khẳng định | Bằng chứng bắt buộc | KHÔNG đủ |
|---|---|---|
| test pass | output test: 0 fail | lần chạy trước, "chắc pass" |
| linter sạch | output linter: 0 lỗi | kiểm một phần rồi suy ra |
| build được | lệnh build: exit 0 | linter xanh, log nhìn ổn |
| đã fix bug | test triệu chứng gốc: pass | đã sửa code, cho là xong |
| test hồi quy chạy đúng | đã làm chu trình đỏ-xanh | test pass một lần |
| yêu cầu đã đủ | đối chiếu từng gạch đầu dòng | test xanh |
| vai khác đã làm xong | `git diff` cho thấy thay đổi | vai đó báo "xong" |

Dòng cuối quan trọng riêng với alp-code: **báo cáo của một vai khác không phải bằng chứng.**
Vai đó chạy trong phiên riêng, bạn không thấy nó đã chạy gì. Kiểm độc lập.

## Cờ đỏ — dừng lại

- Dùng "chắc là", "nhiều khả năng", "có vẻ".
- Tỏ ra hài lòng trước khi kiểm chứng ("ngon rồi!", "xong!").
- Sắp commit/push/PR mà chưa kiểm chứng.
- Tin báo cáo thành công của vai khác.
- Dựa vào kiểm chứng một phần.
- Nghĩ "lần này thôi".
- Mệt và muốn xong cho rồi.
- **Bất kỳ cách diễn đạt nào ngụ ý thành công mà chưa chạy kiểm chứng.**

## Chặn lý do biện minh

| Lý do | Thực tế |
|---|---|
| "chắc chạy được rồi" | thì CHẠY đi |
| "tôi tự tin mà" | tự tin ≠ bằng chứng |
| "lần này thôi" | không có ngoại lệ |
| "linter xanh rồi" | linter ≠ compiler |
| "vai kia bảo xong rồi" | kiểm độc lập |
| "mệt quá" | mệt ≠ lý do |
| "kiểm một phần là đủ" | một phần chứng minh không gì cả |
| "tôi nói khác đi nên luật không áp dụng" | tinh thần, không phải câu chữ |

## Mẫu

**Test**

```
✅ [chạy lệnh test] [thấy: 34/34 pass] → "toàn bộ test pass"
❌ "chắc pass rồi" / "nhìn thì đúng"
```

**Test hồi quy — chu trình đỏ-xanh**

```
✅ viết test → chạy (pass) → gỡ bản sửa → chạy (PHẢI FAIL) → khôi phục → chạy (pass)
❌ "tôi đã viết test hồi quy" (chưa qua đỏ-xanh)
```

Test hồi quy chưa từng đỏ thì không chứng minh được gì — nó có thể pass ngay cả khi bug
còn nguyên.

**Build**

```
✅ [chạy build] [thấy: exit 0] → "build được"
❌ "linter xanh" (linter không kiểm biên dịch)
```

**Yêu cầu**

```
✅ đọc lại yêu cầu → lập checklist → đối chiếu từng mục → báo chỗ thiếu hoặc báo đủ
❌ "test xanh, coi như xong"
```

## Áp dụng khi nào

**LUÔN LUÔN, trước:** mọi biến thể của câu nói xong · mọi biểu hiện hài lòng · mọi phát
biểu tích cực về trạng thái công việc · commit, PR · chuyển sang việc kế tiếp.

Luật áp dụng cho: câu nguyên văn, câu diễn đạt lại, câu đồng nghĩa, và **mọi cách nói ngụ ý
đã xong hoặc đã đúng**.

## Chốt

Chạy lệnh. Đọc output. **Rồi mới** nói kết quả.

Không thương lượng. Và với `review` thì đây là lý do tồn tại của vai — main gọi bạn chính
là để có người không cho qua.

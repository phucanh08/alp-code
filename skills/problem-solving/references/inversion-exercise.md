# Bài tập đảo ngược

Lật giả định lõi để lộ ràng buộc ngầm: **"nếu ngược lại thì sao?"**

## Nguyên lý

**Đảo ngược làm lộ giả định chưa ai nói ra.** Đôi khi cái ngược lại mới là câu trả lời —
nhưng kể cả khi không, việc lật cũng cho thấy vì sao cái đang có là đúng.

## Khi nào dùng

| Triệu chứng | Việc phải làm |
|---|---|
| "chỉ có một cách thôi" | lật giả định đó |
| giải pháp thấy gượng | lật ràng buộc |
| không nói được vì sao nó bắt buộc | chất vấn chữ "phải" |
| "xưa nay vẫn làm thế" | thử làm ngược |

## Đảo ngược mẫu

| Giả định thường | Lật lại | Lộ ra |
|---|---|---|
| cache để giảm độ trễ | thêm độ trễ để cache được | mẫu debounce |
| kéo dữ liệu khi cần | đẩy dữ liệu trước khi cần | prefetch, nạp sớm |
| xử lý lỗi khi lỗi xảy ra | làm cho lỗi không thể xảy ra | hệ kiểu, contract |
| thêm tính năng người dùng muốn | bỏ tính năng người dùng không cần | đơn giản > bổ sung |
| tối ưu cho ca phổ biến | tối ưu cho ca tệ nhất | mẫu chịu lỗi |

## Quy trình

1. **Liệt kê giả định lõi** — cái gì đang được coi là "phải" đúng?
2. **Lật từng cái** — "nếu ngược lại thì sao?"
3. **Truy hệ quả** — làm khác đi thế nào?
4. **Tìm đảo ngược hợp lệ** — cái nào thật sự chạy được ở đâu đó?
5. **Ghi nhận định.**

## Ví dụ

**Vấn đề:** người dùng kêu app chậm.

**Cách thường:** làm mọi thứ nhanh hơn — cache, tối ưu truy vấn, CDN, giảm bundle.

**Lật lại:** cố tình làm chậm ở vài chỗ.

- **Debounce ô tìm kiếm** — thêm độ trễ → kết quả tốt hơn (đợi gõ xong).
- **Giới hạn tần suất** — thêm ma sát → chặn lạm dụng, người khác được phục vụ tốt hơn.
- **Lazy load** — hoãn tải → thời gian tải đầu ngắn lại.
- **Render dần** — hiện chậm hơn nhưng hiện sớm → *cảm giác* nhanh hơn.

**Nhận định:** chậm có chiến lược cải thiện trải nghiệm. Cái người dùng cảm nhận không phải
tổng thời gian, mà là thời gian phải chờ trước khi thấy gì đó.

## Đảo ngược hợp lệ và không hợp lệ

**Hợp lệ:**
- Thường: "lưu dữ liệu vào database."
- Lật: "tính lại khi cần thay vì lưu."
- Hợp lệ khi: tính rẻ hơn lưu, dữ liệu đổi liên tục.

**Không hợp lệ:**
- Thường: "kiểm dữ liệu người dùng nhập."
- Lật: "tin mọi dữ liệu nhập vào."
- Không hợp lệ vì: đó là lỗ bảo mật, không phụ thuộc ngữ cảnh nào cả.

**Cách thử:** đảo ngược này có chạy được trong **bất kỳ** ngữ cảnh nào không? Có → nó hợp
lệ ở đâu đó, đáng khám phá. Không → bỏ, đừng cố.

## Cặp hay lật

Sớm ↔ lười · đẩy ↔ kéo · lưu ↔ tính · tối ưu ↔ đơn giản hoá · thêm ↔ bớt.

## Với alp-code

Repo này có sẵn vài giả định đáng lật khi bế tắc:

- "ACL phải do harness enforce" ↔ "nếu hook không chạy thì sao?" — chính câu hỏi này sinh
  ra thiết kế fail đóng hiện tại.
- "mỗi vai một phiên riêng" ↔ "nếu gộp thì sao?" — lật để thấy vì sao tách là đúng.

Lật một nguyên tắc trong `compiled policy invariants` là bài tập tư duy hợp lệ. **Đề xuất đổi nó thì phải
qua principal** — chỉ principal sửa CHARTER (compiled policy invariants).

## Nhớ

- Không phải đảo ngược nào cũng chạy. Thử biên.
- Đảo ngược hợp lệ cho thấy "luật" thật ra chỉ đúng trong một ngữ cảnh.
- Ghi lại cả lần lật thất bại — nó chứng minh vì sao cách hiện tại đúng, và đó là thứ đáng
  ghi vào plan.

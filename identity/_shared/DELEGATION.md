# DELEGATION — giao việc cho agent khác

> **Không nằm trong boot set.** Nạp khi sắp giao việc, không nạp dự phòng.
> Luật "khi nào tự làm, khi nào giao" ở [`HOUSE-RULES.md`](HOUSE-RULES.md) §3.
> Giao cho ai: `identity/<role>/RELATIONS.md`.

## Khuôn prompt — sáu mục, không thiếu mục nào

```
1. Mục tiêu   — một câu, kết quả mong muốn
2. Bối cảnh   — đường dẫn file liên quan, quyết định đã chốt, cái đã thử
3. Phạm vi    — file/thư mục được động vào; cái gì KHÔNG được động
4. Môi trường — CWD, OS darwin, shell zsh, timezone Asia/Saigon
5. Đầu ra     — định dạng mong muốn, ghi vào đâu
6. Ranh giới  — không commit, không deploy, không sửa ngoài phạm vi
```

Thiếu mục 3 hoặc 6 là nguyên nhân phổ biến nhất khiến agent làm vượt phạm vi.

## Sau khi agent trả kết quả

**Đọc lại bằng mắt mình trước khi báo cáo lên.** Agent có thể sai, phóng đại, hoặc
tuyên bố hoàn thành việc chưa làm. Kết quả sai là lỗi của người giao, không phải người nhận.

Kiểm tối thiểu: mở file agent nói đã ghi · chạy lệnh agent nói đã chạy · kiểm một link.

## Chạy song song an toàn

- Mỗi agent sở hữu một tập file riêng, **không giao nhau**. Hai agent ghi cùng file = hỏng.
- Tối đa 3–4 agent đồng thời, cân theo tài nguyên máy.
- Việc phụ thuộc nhau thì chạy tuần tự, không song song.
- Mỗi agent chỉ có ~200K context — giao task hẹp, kèm đúng bối cảnh cần, không dump cả repo.

## Ngân sách & cách ly

Mỗi agent khởi động từ con số không và phải suy luận lại bối cảnh bạn đã có sẵn.
Task "nhiều mặt", "kỹ lưỡng", "nhiều phần" **không** đồng nghĩa với phải giao đi.

Agent được giao chạy trong phiên riêng, với `loadout.yaml` riêng — nó **không** thấy
`memory/private/` của bạn và không ghi được ngoài `memory.write` của nó. Muốn nó ghi
được chỗ mới → xin principal sửa loadout của **nó**, không phải của bạn.

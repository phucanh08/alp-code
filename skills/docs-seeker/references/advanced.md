# Ca khó

## Tài liệu nhiều ngôn ngữ

1. Xác định ngôn ngữ cần từ yêu cầu được giao.
2. Tìm `llms.txt` theo ngôn ngữ: `llms-es.txt`, `llms-ja.txt`, `llms-vi.txt`.
3. Không có thì dùng bản tiếng Anh.
4. **Ghi rõ đã dùng bản ngôn ngữ nào** — bản dịch thường chậm hơn bản gốc vài phiên bản.

## Tài liệu theo phiên bản

**Bản mới nhất** — dùng URL gốc, không cần chỉ định gì.

**Phiên bản cụ thể:**

```
WebSearch: "{thư viện} v{phiên bản} llms.txt"
```

Thử các đường: `/v2/llms.txt` · `/docs/v2/llms.txt` · `/{version}/llms.txt`

Với repo: `git checkout v{phiên bản}` hoặc `tags/{phiên bản}`.

**Luôn ghi phiên bản đã đọc.** Đây là chỗ sai âm thầm hay gặp nhất của cả skill: đọc tài
liệu v3 rồi trả lời cho project đang dùng v2. Tài liệu không có phiên bản gần như vô dụng
cho việc đánh giá của `research`.

## Framework có nhiều plugin

Framework lõi + 50 plugin thì đừng tài liệu hoá hết.

1. Đọc **lõi trước**.
2. Hỏi lại xem cần plugin nào.
3. Tìm riêng đúng plugin đó.
4. Liệt kê tên các plugin có sẵn trong báo cáo, để bên đọc biết còn gì.

Đọc hết 50 plugin là phá ngân sách context của cả phiên để trả lời một câu hỏi về hai
plugin.

## Tài liệu đang viết dở

**Dấu hiệu:** bản phát hành mới mà tài liệu chưa theo kịp · nhiều trang "coming soon" ·
issue trên GitHub đang xin tài liệu.

Cách làm:

1. **Nói ngay ở đầu báo cáo** rằng tài liệu chưa đầy đủ.
2. Kết hợp phần tài liệu có sẵn với đọc repo.
3. Xem thư mục `tests/` và `examples/` — chúng thường chính xác hơn tài liệu vì chúng chạy.
4. **Đánh dấu rõ phần nào là "suy ra từ code"**, không trộn lẫn với phần có tài liệu.
5. Dẫn link issue liên quan để bên đọc theo dõi.

## Nguồn mâu thuẫn nhau

1. Xác định đâu là **nguồn sơ cấp chính thức**.
2. Kiểm xem có phải khác phiên bản không — phần lớn mâu thuẫn là do đó.
3. **Trình bày cả hai**, kèm ngữ cảnh của từng bên.
4. Khuyến nghị bản chính thức mới nhất.
5. Giải thích vì sao có mâu thuẫn.

Thứ tự ưu tiên nguồn:

```
1. Tài liệu chính thức, bản mới nhất
2. Tài liệu chính thức, bản theo phiên bản
3. README trên GitHub
4. Tutorial cộng đồng
5. Stack Overflow
```

**Không chọn hộ bên giao việc khi mâu thuẫn là thật** (hai bên cùng đúng trong hai ngữ cảnh khác
nhau). Nêu cả hai, chỉ ra ngữ cảnh nào hợp với project. Đây là luật "đang tranh cãi" của
`research`.

## Giới hạn tần suất API

- Đặt `CONTEXT7_API_KEY` vào biến môi trường — báo principal, **không tự tạo file `.env`
  trong `skills/`** (thư mục đóng băng, CHARTER §8).
- Bị giới hạn thì giãn dần thời gian giữa các lần gọi, đừng gọi dồn.
- Nhớ kết quả đã lấy **trong phiên**, đừng gọi lại cùng một URL.
- Vẫn bị chặn → dừng, báo lại. Ngân sách 5 lượt của `research` không đủ để ngồi chờ
  rate limit hồi.

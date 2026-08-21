# RELATIONS — main

Main báo cáo cho principal và điều phối các vai chuyên môn.

| Vai | Model | Giao khi | Đầu ra |
|---|---|---|---|
| `search` 🔍 | GPT-5.6 Terra low | cần tìm symbol, call-site, flow trong code local | path/symbol/line |
| `librarian` 📚 | GPT-5.6 Sol | cần web, tài liệu ngoài hoặc cross-repo research | report có nguồn trong reference/refs |
| `read-thread` 🧵 | GPT-5.6 Luna | cần tìm fact, decision, log hoặc thread trong memory | path + móc câu ngắn |
| `review` 🔎 | GPT-5.5 medium | cần review code; tạo một phiên riêng cho từng concern | findings có severity + bằng chứng |
| `oracle` 🔮 | Opus 5 / GPT-5.6 Sol | cần second opinion sâu về reasoning, debug, architecture, planning | khuyến nghị + trade-offs |
| `compaction` 🗜️ | GPT-5.6 Sol medium | thread dài cần context handoff để tiếp tục | summary có cấu trúc + exact anchors |
| `titling` 🏷️ | GPT-5.6 Luna low | thread cần một display title nhanh | đúng một title ngắn |

## Quy tắc định tuyến

- Nguồn câu trả lời là **workspace code local** → Search.
- Nguồn câu trả lời ở **bên ngoài/cross-repo** → Librarian.
- Nguồn câu trả lời nằm trong **memory** → Read Thread.
- Cần kiểm security/correctness/performance/architecture → mỗi concern một phiên Review.
- Bế tắc hoặc quyết định rủi ro cao → cân nhắc Oracle; không gọi mặc định.
- Thread gần áp lực context hoặc cần handoff → Compaction; không dùng để giải tiếp task.
- Cần title hiển thị cho thread → Titling; không yêu cầu giải thích hoặc nhiều phương án.
- Main chạy Claude → Oracle dùng Opus 5; Main chạy Codex → Oracle dùng GPT-5.6 Sol.
- Một việc có nhiều nguồn: giao song song, sau đó main hợp nhất và chốt.

Các vai chuyên môn không chốt decision. Main kiểm bằng chứng trước khi hành động.
Mọi private silo cách ly hai chiều; muốn biết thì hỏi vai sở hữu.

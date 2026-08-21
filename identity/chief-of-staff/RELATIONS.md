# RELATIONS — chief-of-staff

Chief-of-staff báo cáo cho principal và điều phối nhóm **Knowledge Retrieval**.

| Vai | Model | Giao khi | Đầu ra |
|---|---|---|---|
| `search` 🔍 | GPT-5.6 Terra | cần tìm symbol, call-site, flow trong code local | path/symbol/line |
| `librarian` 📚 | GPT-5.6 Sol | cần web, tài liệu ngoài hoặc cross-repo research | report có nguồn trong reference/refs |
| `read-thread` 🧵 | GPT-5.6 Luna | cần tìm fact, decision, log hoặc thread trong memory | path + móc câu ngắn |

## Quy tắc định tuyến

- Nguồn câu trả lời là **workspace code local** → Search.
- Nguồn câu trả lời ở **bên ngoài/cross-repo** → Librarian.
- Nguồn câu trả lời nằm trong **memory** → Read Thread.
- Một việc có nhiều nguồn: giao song song, sau đó chief-of-staff hợp nhất và chốt.

Ba vai retrieval không chốt decision. Chief-of-staff kiểm bằng chứng trước khi hành động.
Mọi private silo cách ly hai chiều; muốn biết thì hỏi vai sở hữu.

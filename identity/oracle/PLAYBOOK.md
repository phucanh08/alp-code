# PLAYBOOK — quy trình vận hành của oracle

## Khi nên gọi

- Debugging bế tắc sau khi Main đã có hypothesis và bằng chứng.
- Architecture có nhiều trade-off hoặc migration khó đảo ngược.
- Plan dài hạn, incident phức tạp, concurrency/distributed state, hoặc review logic sâu.
- Cần phản biện độc lập trước quyết định rủi ro cao.

Không gọi mặc định cho task thường, implementation thẳng, retrieval, hay review checklist.

`ĐỌC BRIEF → TÁI LẬP MÔ HÌNH → THÁCH THỨC ASSUMPTION → SO SÁNH → KHUYẾN NGHỊ`

Brief gồm câu hỏi quyết định, constraints, evidence, hypothesis/option và điều Main chưa chắc.
Oracle có thể đọc code/test/log và chạy kiểm tra read-only. Đầu ra gồm kết luận, assumptions,
trade-offs, phương án ưu tiên và bước kiểm chứng rẻ nhất tiếp theo. Không sửa code/commit/deploy.

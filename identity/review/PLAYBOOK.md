# PLAYBOOK — quy trình vận hành của review

## Hợp đồng phiên

Main giao đúng **một concern** cho mỗi phiên Review. Với review tổng hợp, Main tạo các phiên
độc lập chạy song song, ví dụ: security, correctness, performance và architecture. Không để
một phiên tự chia thành nhiều subagent hoặc tự review mọi mặt.

## Quy trình

`XÁC ĐỊNH SCOPE → ĐỌC DIFF/CODE → TRUY VẾT HÀNH VI → KIỂM CHỨNG → BÁO CÁO`

- Security: trust boundary, authn/authz, injection, secret, deserialization, data exposure.
- Correctness: invariant, edge case, error path, concurrency và compatibility.
- Performance: chỉ báo bottleneck có cost model hoặc đường đo hợp lý.
- Architecture: boundary, dependency direction, coupling, ownership và migration risk.
- Chạy test/linter/benchmark read-only khi phù hợp; không sửa file.

Sắp finding theo severity. Mỗi finding gồm:
`[SEVERITY] tiêu đề — file:line` · bằng chứng · impact · điều kiện kích hoạt · hướng sửa.
Kết thúc bằng phần chưa kiểm chứng; nếu rỗng, nói rõ không có finding trong concern được giao.

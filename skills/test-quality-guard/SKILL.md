---
name: test-quality-guard
description: >
  Dùng khi agent viết mới, sửa, review hoặc đánh giá test. Mục tiêu là ngăn
  test giả chất lượng, oracle suy ra từ implementation, assertion yếu,
  over-mocking, coverage gaming và các hành vi "làm xanh bằng mọi giá".
  Ưu tiên bằng chứng RED → GREEN; với regression hoặc logic quan trọng,
  dùng RED → GREEN → MUTATE → RED → RESTORE → GREEN.
---

# Test Quality Guard

## Mục tiêu

Test phải chứng minh **behavior đúng**, không chỉ chứng minh code hiện tại chạy được.

Nguyên tắc trung tâm:

```text
Test tốt phải có khả năng thất bại khi behavior mà nó bảo vệ bị phá vỡ.
```

---

# 1. Luật bắt buộc

## 1.1 Oracle không được lấy từ implementation

Ưu tiên nguồn expected behavior:

```text
Requirement
↓
Acceptance criteria
↓
Public contract
↓
Issue / bug report
↓
Documented behavior
↓
Domain invariant
```

Không dùng:

```text
implementation
↓
"code đang trả X"
↓
"test cũng assert X"
```

Nếu nguồn expected behavior không rõ, không được tự biến implementation hiện tại thành specification.

---

## 1.2 Regression test phải chứng minh được bug

Khi sửa bug:

```text
BUG
↓
REPRODUCE
↓
TEST FAIL
↓
FIX
↓
TEST PASS
```

Nếu test mới chưa từng fail trên behavior lỗi thì chưa được coi là regression proof.

---

## 1.3 Không được "game green"

Không được làm xanh suite bằng cách:

- làm yếu assertion;
- đổi expected để khớp actual sai;
- xóa test liên quan;
- skip/disable test liên quan;
- cập nhật snapshot vô điều kiện;
- mock đi phần behavior đang cần kiểm chứng;
- suppress exception chỉ để pass.

---

## 1.4 Assertion phải kiểm tra behavior có ý nghĩa

Ưu tiên assertion trên:

- output công khai;
- state transition;
- error semantics;
- persisted state;
- emitted event;
- API contract;
- security invariant;
- concurrency invariant.

Các assertion sau là tín hiệu đáng ngờ nếu đứng một mình:

```text
assertNotNull(...)
assertTrue(result != null)
assertTrue(size > 0)
assertTrue(status != 500)
assertDoesNotThrow(...)
```

---

## 1.5 Mock boundary, không mock behavior chính

Mock phù hợp cho:

- network;
- external API;
- filesystem;
- clock;
- randomness;
- infrastructure đắt đỏ;
- non-deterministic service.

Không mock đi chính decision logic cần được test.

---

# 2. Workflow mặc định

## Feature mới

```text
SPEC
↓
BEHAVIOR
↓
TEST
↓
RED
↓
IMPLEMENT
↓
GREEN
```

Không bắt buộc TDD tuyệt đối trong mọi task, nhưng oracle phải độc lập với implementation.

## Bug fix

```text
BUG
↓
REPRODUCE
↓
RED
↓
FIX
↓
GREEN
```

## Logic quan trọng / regression quan trọng

```text
RED
↓
GREEN
↓
MUTATE / REVERT
↓
RED
↓
RESTORE
↓
GREEN
```

Chi tiết xem:

```text
references/test-proof-protocol.md
```

---

# 3. Completion Gate

Agent không được tuyên bố:

```text
done
fixed
verified
all good
tests prove the fix
```

nếu tồn tại một trong các finding BLOCKING:

```text
test-survives-sabotage
unproven-regression-test
assertion-weakened-to-green
test-removed-to-green
test-disabled-to-green
implementation-derived-oracle
```

Chi tiết taxonomy:

```text
references/anti-patterns.md
```

---

# 4. Review nhanh

Trước khi chấp nhận test, trả lời được:

```text
1. Behavior nào đang được bảo vệ?
2. Oracle lấy từ đâu?
3. Nếu implementation sai, test có fail không?
4. Nếu đảo condition quan trọng, test có fail không?
5. Test có chỉ assert setup/mock của chính nó không?
6. Assertion có đủ mạnh không?
7. Có boundary/error case quan trọng nào bị thiếu không?
8. Có over-mocking không?
9. Test có coupling với implementation detail không?
10. Có hành động nào nhằm làm xanh suite thay vì sửa nguyên nhân không?
```

---

# 5. Progressive Disclosure

Không đọc toàn bộ tài liệu cho mọi task.

## Mức A — Test đơn giản

Chỉ dùng file này.

Kiểm tra:

```text
oracle
assertion
RED/GREEN
```

## Mức B — Bug fix / regression

Đọc thêm:

```text
references/test-proof-protocol.md
```

## Mức C — Test có smell hoặc khó đánh giá

Đọc thêm:

```text
references/anti-patterns.md
```

## Mức D — Review nghiêm ngặt / critical logic

Đọc cả:

```text
references/anti-patterns.md
references/test-proof-protocol.md
references/review-checklist.md
```

---

# 6. Quy tắc mặc định khi nghi ngờ

Hỏi:

```text
Nếu tôi cố tình phá behavior này, test nào sẽ fail?
```

Nếu không chỉ ra được test cụ thể:

```text
behavior chưa được chứng minh bởi test.
```

---

# 7. Mục tiêu tối ưu

Không tối ưu cho:

```text
green build
high coverage
many tests
```

Tối ưu cho:

```text
fault detection
behavior protection
independent oracle
regression prevention
credible evidence
```

Câu hỏi cuối cùng luôn là:

```text
Không phải:
"Test có pass không?"

Mà là:
"Test có bắt được implementation sai không?"
```

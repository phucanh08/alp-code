# Test Proof Protocol

Tài liệu này dùng khi:
- sửa bug;
- thêm regression test;
- behavior quan trọng;
- test mới pass ngay từ đầu;
- cần chứng minh test thực sự bắt được lỗi;
- cần completion gate mạnh hơn "suite xanh".

---

# 1. Proof Level

## Level 0 — Chưa có bằng chứng

```text
test chưa chạy
```

## Level 1 — Green only

```text
test PASS
```

Bằng chứng yếu.

## Level 2 — RED → GREEN

```text
implementation lỗi
↓
test FAIL
↓
fix
↓
test PASS
```

Đây là mức tối thiểu nên có cho regression test.

## Level 3 — Mutation proof

```text
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

Dùng cho bug quan trọng hoặc logic dễ false-positive.

## Level 4 — Mutation suite

Nhiều mutation có ý nghĩa đều bị tiêu diệt.

Phù hợp với:

```text
critical domain logic
security
financial calculations
permission
state machines
safety-sensitive behavior
```

---

# 2. Protocol cho bug fix

## Bước 1 — Xác định behavioral claim

Ví dụ:

```text
"Người dưới 18 tuổi không được đăng ký."
```

## Bước 2 — Reproduce

Tạo input làm lộ bug.

Ví dụ:

```text
age = 17
```

## Bước 3 — RED

Chạy test trên implementation lỗi.

Yêu cầu:

```text
test FAIL
```

Nếu test pass:

```text
regression proof chưa hợp lệ
```

## Bước 4 — Fix

Sửa implementation.

## Bước 5 — GREEN

Chạy lại test.

Yêu cầu:

```text
test PASS
```

## Bước 6 — Sabotage hoặc Revert

Cố tình phá chính behavior vừa sửa.

Ví dụ:

```text
age >= 18
```

đổi thành:

```text
return true
```

hoặc revert đúng phần fix.

## Bước 7 — RED lần 2

Test phải fail.

Nếu vẫn pass:

```text
Finding: test-survives-sabotage
Severity: BLOCKING
```

## Bước 8 — Restore

Khôi phục implementation đúng.

## Bước 9 — GREEN cuối

Chạy:

- targeted test;
- relevant suite;
- broader suite nếu chi phí hợp lý.

---

# 3. Mutation có ý nghĩa

Không mutation ngẫu nhiên chỉ để phá code.

Mutation phải liên quan trực tiếp tới behavioral claim.

Ví dụ tốt:

```text
>= → >
ALLOW → DENY
&& → ||
remove validation
remove authorization guard
remove retry limit
remove state transition
```

Ví dụ kém:

```text
đổi tên biến
thêm whitespace
sửa code không ảnh hưởng behavior
```

---

# 4. Khi nào không nên mutate

Không bắt buộc mutation khi:

- thay đổi thuần documentation;
- refactor không đổi behavior;
- formatting;
- generated code không sở hữu;
- mutation gây side effect nguy hiểm;
- mutation không thể rollback an toàn.

Trong trường hợp đó, ghi rõ proof level thực tế.

---

# 5. Completion Evidence

Khi báo cáo kết quả, ưu tiên format:

```text
Behavior:
<behavior được bảo vệ>

Oracle source:
<requirement / contract / bug report>

Proof:
RED → GREEN
hoặc
RED → GREEN → MUTATE → RED → RESTORE → GREEN

Tests:
<test names>

Result:
PASS
```

Không chỉ báo:

```text
all tests passed
```

---

# 6. Quy tắc quyết định

Nếu câu trả lời cho câu hỏi sau là "không":

```text
Nếu tôi phá behavior mục tiêu, test có fail không?
```

thì chưa đủ bằng chứng để claim verified.

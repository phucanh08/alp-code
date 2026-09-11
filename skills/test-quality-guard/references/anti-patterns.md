# Test Anti-Patterns

Tài liệu này chỉ đọc khi:
- test khó đánh giá;
- suite xanh nhưng độ tin cậy thấp;
- agent vừa sửa test;
- có nhiều mock/snapshot;
- regression test đáng ngờ;
- cần review chất lượng sâu.

---

# BLOCKING

## 1. test-survives-sabotage

Dấu hiệu:

```text
phá behavior mục tiêu
→ test vẫn PASS
```

Ý nghĩa:

Test không thực sự bảo vệ behavior cần kiểm chứng.

Hành động:

- xác định đúng behavioral claim;
- thêm assertion có khả năng phân biệt đúng/sai;
- chạy lại sabotage/mutation.

---

## 2. unproven-regression-test

Dấu hiệu:

- bug đã được fix;
- test mới được thêm sau đó;
- chưa từng chứng minh test fail khi bug còn tồn tại.

Hành động:

```text
revert hoặc sabotage fix
→ chạy test
→ test phải RED
```

---

## 3. assertion-weakened-to-green

Ví dụ:

```kotlin
assertEquals(LoginResult.InvalidCredentials, result)
```

bị đổi thành:

```kotlin
assertNotNull(result)
```

chỉ vì test fail.

Nếu không có thay đổi requirement:

```text
BLOCK
```

---

## 4. test-removed-to-green

Dấu hiệu:

```text
test fail
↓
xóa test
↓
suite xanh
```

Mặc định BLOCK.

---

## 5. test-disabled-to-green

Ví dụ:

```text
@Ignore
@Disabled
skip()
xfail
TODO
```

được dùng chỉ để né failure.

---

## 6. implementation-derived-oracle

Ví dụ:

```kotlin
val expected = service.calculate(input)
val actual = service.calculate(input)

assertEquals(expected, actual)
```

Hoặc expected được copy từ chính thuật toán implementation.

---

# HIGH

## 7. tautological-test

Test tự chứng minh setup của nó.

Ví dụ:

```kotlin
whenever(repository.load()).thenReturn("ABC")
assertEquals("ABC", repository.load())
```

---

## 8. mocking-the-mock

Pattern:

```text
mock input
↓
mock output
↓
assert mocked output
```

Không exercise behavior thật của SUT.

---

## 9. over-mocking

Dấu hiệu:

- decision logic chính bị mock;
- validator bị mock;
- mapper quan trọng bị mock;
- authorization decision bị mock;
- SUT chỉ còn wiring.

Câu hỏi kiểm tra:

```text
Nếu implementation chính bị thay bằng return constant,
test có fail không?
```

Nếu không, finding HIGH.

---

## 10. happy-path-bias

Chỉ test success path trong khi behavior có rủi ro ở:

- empty;
- invalid;
- expired;
- timeout;
- retry;
- duplicate;
- boundary;
- exception;
- concurrency;
- authorization.

---

## 11. coverage-gaming

Ví dụ:

```kotlin
@Test
fun execute_all_lines() {
    service.run()
}
```

Không có meaningful assertion.

Coverage cao không phải quality proof.

---

## 12. snapshot-rubber-stamping

Pattern:

```text
snapshot fail
↓
update snapshot
↓
green
```

mà không kiểm tra thay đổi có đúng requirement hay không.

---

# MEDIUM

## 13. implementation-coupled-test

Couple vào:

- private method;
- internal helper;
- exact call order;
- incidental invocation count;
- temporary object;
- internal algorithm.

Nếu public behavior không đổi, refactor hợp lệ không nên phá test hàng loạt.

---

## 14. duplicate-test-illusion

Nhiều test khác tên nhưng:

```text
same input
same path
same assertion
```

Không tính là nhiều behavior được bảo vệ.

---

## 15. magic-value-oracle

Ví dụ:

```kotlin
assertEquals(34782, result)
```

nhưng không giải thích được `34782` đến từ requirement/contract nào.

---

## 16. excessive-fixture

Setup quá lớn so với behavior cần kiểm chứng:

```text
50 objects
10 mocks
8 dependencies
```

nhưng chỉ test một condition nhỏ.

---

# Heuristic theo loại logic

## Boundary

Khi có:

```text
<
<=
>
>=
range
length
limit
timeout
retry
threshold
```

xem xét:

```text
boundary - 1
boundary
boundary + 1
```

---

## Boolean mutation

Khi có:

```text
&&
||
!
true
false
```

xem xét:

```text
&& ↔ ||
true ↔ false
remove !
```

---

## Conditional mutation

Khi có:

```text
>
>=
<
<=
==
!=
```

xem xét đảo operator có ý nghĩa.

---

## Return mutation

Khi function trả:

```text
boolean
enum
status
result
```

xem xét:

```text
SUCCESS → ERROR
ALLOW → DENY
true → false
value → null
```

---

## Error path

Nếu code có:

```text
try/catch
Result
Either
retry
fallback
timeout
exception mapping
```

phải xem có negative/error test phù hợp hay không.

---

## Concurrency

Nếu code có:

```text
coroutine
thread
async
Flow
callback
queue
worker
parallel execution
```

xem xét:

```text
race
duplicate execution
cancellation
timeout
ordering
partial failure
```

---

## Security-sensitive behavior

Đối với:

```text
authentication
authorization
permission
token
role
access control
validation
signature
```

xem xét cả:

```text
allowed
denied
missing
invalid
expired
tampered
```

Authorization test phải có khả năng chứng minh deny path.

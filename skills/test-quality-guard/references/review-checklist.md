# Test Review Checklist

Dùng file này khi review test suite hoặc critical change.

---

## Behavior

- [ ] Test bảo vệ behavior cụ thể nào?
- [ ] Behavior có được mô tả độc lập với implementation không?
- [ ] Oracle đến từ requirement/contract/bug report/invariant không?

## Fault detection

- [ ] Implementation sai thì test có fail không?
- [ ] Boundary bị đổi thì test có fail không?
- [ ] Return value quan trọng bị đảo thì test có fail không?
- [ ] Guard/validation bị remove thì test có fail không?

## Assertions

- [ ] Assertion có kiểm tra business/public behavior không?
- [ ] Có assertion yếu đứng một mình không?
- [ ] Có tautology không?
- [ ] Có magic expected value không rõ nguồn không?

## Mocking

- [ ] Mock chỉ nằm ở boundary hợp lý?
- [ ] Behavior chính có bị mock đi không?
- [ ] Test có đang "mock input → mock output → assert mock output" không?

## Regression integrity

- [ ] Regression test từng RED trước fix chưa?
- [ ] Test có survive sabotage/revert không?
- [ ] Có assertion nào bị làm yếu để pass không?
- [ ] Có test nào bị xóa/skip/disable để pass không?

## Coverage quality

- [ ] Có negative case quan trọng không?
- [ ] Có boundary case không?
- [ ] Có error path không?
- [ ] Có duplicate test illusion không?
- [ ] Coverage tăng có đi kèm fault detection thật không?

## Isolation

- [ ] Test deterministic?
- [ ] Không phụ thuộc test order?
- [ ] Không phụ thuộc random uncontrolled?
- [ ] Không phụ thuộc wall clock thật nếu tránh được?
- [ ] Không dùng sleep tùy tiện?

## Concurrency / async

Nếu liên quan:

- [ ] cancellation?
- [ ] timeout?
- [ ] duplicate execution?
- [ ] race?
- [ ] ordering?
- [ ] partial failure?

## Security

Nếu liên quan:

- [ ] allow path?
- [ ] deny path?
- [ ] invalid?
- [ ] missing?
- [ ] expired?
- [ ] tampered?

---

# Verdict

## PASS

Không có BLOCKING finding và behavioral evidence đủ mạnh.

## PASS WITH WARNING

Không có BLOCKING finding nhưng còn smell mức MEDIUM/HIGH chưa ảnh hưởng trực tiếp correctness.

## BLOCK

Có ít nhất một trong:

```text
test-survives-sabotage
unproven-regression-test
assertion-weakened-to-green
test-removed-to-green
test-disabled-to-green
implementation-derived-oracle
```

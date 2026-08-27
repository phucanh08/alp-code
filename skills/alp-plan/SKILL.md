---
name: alp-plan
description: Lập kế hoạch triển khai — thách thức phạm vi, thu thập bối cảnh, thiết kế giải pháp, chia phase, viết plan vào plans/. Kích hoạt khi principal giao một việc đủ lớn để cần chia bước, khi phải chốt kiến trúc trước lúc viết code, hoặc khi cần rà kế hoạch cũ trước khi mở kế hoạch mới.
---

# alp-plan — chốt kiến trúc trước khi gõ code

Kế hoạch là hợp đồng bạn ký với principal — và là thứ người thực thi đọc để biết mình
được giao gì.

**Không viết code trong lúc lập kế hoạch.** Ra plan, principal duyệt, rồi mới làm.

## Trước khi mở kế hoạch mới

1. **Quét `plans/` tìm kế hoạch chưa xong.** Đọc frontmatter `status:` của từng `plan.md`.
   Kế hoạch dở dang trùng phạm vi mà không ai biết là cách chắc chắn nhất để làm hai lần
   cùng một việc theo hai hướng khác nhau.

2. **Phát hiện quan hệ chặn.** So phạm vi: file đụng nhau, phụ thuộc chung, cùng vùng tính năng.

   | Quan hệ | Ghi vào frontmatter |
   |---|---|
   | kế hoạch mới cần kết quả của kế hoạch cũ | mới: `blockedBy: [<dir cũ>]` |
   | kế hoạch mới đổi thứ kế hoạch cũ đang dựa vào | cũ: `blockedBy: [<dir mới>]` · mới: `blocks: [<dir cũ>]` |
   | phụ thuộc hai chiều | cả hai cùng ghi |

   **Cập nhật cả hai file.** Ghi một chiều thì lần quét sau chỉ thấy một nửa quan hệ.

3. **Không rõ thì hỏi.** Một câu hỏi ngắn rẻ hơn nhiều so với lập sai cả kế hoạch.

## Bốn bước

### 0. Thách thức phạm vi

`references/scope-challenge.md`. **Bỏ qua nếu:** việc nhỏ rõ ràng (sửa một file, mô tả dưới
20 từ).

Câu hỏi đắt nhất hỏi ở đây: *không làm gì thì sao?* Và: *phần nào của yêu cầu này là thật
sự cần, phần nào là mình tự thêm?* YAGNI áp dụng cho kế hoạch trước khi áp dụng cho code.

### 1. Thu thập bối cảnh

Bạn **không tự đi đọc hết**. Giao đúng vai — đó là lý do chúng tồn tại, và là cách giữ
context của bạn sạch:

| Cần gì | Giao cho vai chuyên |
|---|---|
| code hiện tại nằm đâu, ai gọi ai, đổi thì vỡ đâu | truy xuất code trong repo |
| thư viện/cách làm bên ngoài | nghiên cứu nguồn ngoài |
| đã từng quyết định gì về việc này | truy xuất trí nhớ |

Ai đảm nhận vai nào: `src/agents/registry.ts` và `delegates_to` trong loadout của bạn.
Lệnh: `alp delegate <vai> "<task>"`.

Giao được nhiều vai **song song** thì dùng `--background` và theo dõi qua
`alp delegation status|wait`. Runtime backend nằm sau API, không gọi trực tiếp.

**Bỏ qua bước này nếu** principal đã đưa sẵn report, hoặc việc quá nhỏ.

Chi tiết: `references/research-phase.md`, `references/codebase-understanding.md`.

### 2. Thiết kế giải pháp

`references/solution-design.md`.

Rủi ro cao, khó đảo ngược, hoặc nhiều phương án cạnh tranh → **mở một lượt phản biện độc
lập** (`alp-predict`) trước khi chốt. Phán quyết DỪNG nghĩa là thiết kế lại, không phải
ghi chú thêm một dòng rủi ro rồi đi tiếp.

### 3. Viết kế hoạch

`references/plan-organization.md` và `references/output-standards.md`.

## Định dạng — theo đúng repo

```
plans/{YYMMDD}-{HHMM}-{slug}/
  plan.md              tổng quan, nguyên tắc, ngoài phạm vi
  phase-0-<tên>.md     từng phase một file
  phase-1-<tên>.md
```

Báo cáo: `plans/reports/{loại}-{YYMMDD}-{HHMM}-{slug}.md`.

Frontmatter bắt buộc của `plan.md`:

```yaml
---
status: draft | in-progress | completed | cancelled
created: YYYY-MM-DD
slug: <kebab>
source: plans/reports/<report sinh ra kế hoạch này>.md
blockedBy: []
blocks: []
---
```

`plan.md` phải có mục **Ngoài phạm vi**. Không có mục đó thì phạm vi sẽ tự phình trong lúc
làm, và không ai chỉ ra được lúc nào nó phình.

Mỗi file phase mở đầu bằng **Mục tiêu** một câu và **Phụ thuộc** (phase nào phải xong trước).

## Chất lượng

- Đủ chi tiết để một vai khác đọc và làm được mà không hỏi lại.
- Nêu rõ **cách kiểm chứng** từng phase đã xong — không có tiêu chí thì phase không bao giờ
  đóng được.
- Nêu failure mode và cách giảm thiểu. Phase nào chưa nêu được thì chưa duyệt được.
- Trong kế hoạch, ghi rõ phase nào **bắt buộc phải hỏi principal** trước khi chạy (thao tác
  khó đảo ngược — HOUSE-RULES §1.2).
- Tôn trọng YAGNI, KISS, DRY. Thẳng, phũ, ngắn.

## Sau khi viết xong

1. **Rà đối kháng** — `references/red-team-workflow.md`.
2. **Phỏng vấn kiểm chứng** — `references/validate-workflow.md`.
3. **Báo principal**: đường dẫn plan + tóm tắt + **câu hỏi còn mở ở cuối**.
4. **Không tự bắt tay làm.** Principal duyệt rồi mới chạy.

Kế hoạch xong hẳn → `references/archive-workflow.md`: đổi `status: completed`, ghi bài học
vào `memory/private/<vai>/journal/YYYY-MM.md`.

## Ranh giới

- Không tạo plan hay report ngoài `plans/` của repo này.
- Không có `Task` tool — mọi việc giao đi đều qua ALP Delegation API, là **execution riêng**,
  không phải subagent. Execution chỉ thấy context ALP đã build: brief phải đủ.
- Không có `AskUserQuestion`. Hỏi principal bằng cách hỏi thẳng trong phiên.

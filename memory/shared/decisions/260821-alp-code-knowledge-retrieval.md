---
id: alp-code-knowledge-retrieval
type: decision
layer: L3
visibility: team
owner: chief-of-staff
created: 2026-08-21
updated: 2026-08-21
tags: [alp-code, codex, knowledge-retrieval, routing]
source: principal
---

# Đổi tên thành alp-code và tách Knowledge Retrieval thành ba vai

Project đổi tên từ `agent-memory` thành `alp-code`. Vai tổng quát `researcher` được thay
bằng ba Codex agent có ranh giới nguồn rõ ràng:

| Vai | Model | Nguồn chịu trách nhiệm |
|---|---|---|
| Search | `gpt-5.6-terra` | code local |
| Librarian | `gpt-5.6-sol` | external/cross-repo |
| Read Thread | `gpt-5.6-luna` | memory nội bộ |

Các vai retrieval chạy bằng `scripts/run-role.*` trong sandbox read-only. Chúng trả bằng
chứng cho chief-of-staff; chief-of-staff kiểm chứng, ghi artifact và chốt decision.

**Vì sao quan trọng:** routing theo nguồn giảm context, chi phí và việc một agent làm lẫn retrieval với quyết định.
**Áp dụng thế nào:** xác định nguồn câu trả lời trước, rồi giao đúng một trong ba vai.

Liên quan: [[agent-memory-architecture]]

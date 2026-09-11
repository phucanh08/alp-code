---
title: ALP hoạt động thế nào
description: Mental model về identity, policy, execution và runtime trong ALP.
---

ALP sở hữu quyết định **ai được làm gì**; Claude Code hoặc Codex CLI sở hữu việc thực thi model. Tách hai phần này giúp role giữ cùng identity và policy dù được định tuyến sang runtime khác.

## Hai loại phiên

- **Phiên main:** bạn chạy `alp` trong project. `main` là coordinator nói chuyện trực tiếp với bạn và có thể delegate việc chuyên môn.
- **Delegated execution:** `main` hoặc một caller được cấp quyền gọi một role khác qua ALP Delegation API. Specialist nhận task đã chuẩn bị và trả report về caller.

Cả hai đều là **execution** — một lượt chạy có policy riêng. Phiên main còn thuộc về một **[Thread](../../deep-dive/thread/)**: một việc kéo dài qua nhiều lượt. `alp` mở Thread mới; `alp thread continue <id>` mở lượt kế tiếp của việc đó, có thể trên runtime khác. Thread ghi việc tới đâu; nó không cấp quyền.

```text
alp --title "Fix auth bug"      Thread T
  └─ execution #1 (claude)        context rev 0 → rev 1
alp thread continue T
  └─ execution #2 (codex)         mở trên rev 1 → rev 2
```

Không có đường public để chọn runtime trực tiếp. [Mode](../modes-and-runtimes/) chọn model cho từng role; model đó quyết định runtime.

## Luồng một execution

```text
Command hoặc delegation request
  → resolve project + AgentDefinition
  → PolicyEngine authorize role, tool, workspace và memory
  → (root `alp`) tạo hoặc mở Thread; giữ chỗ cho lượt này
  → tạo identity capsule + policy snapshot (kèm binding Thread) + workflow state
  → runtime adapter tạo launch spec
  → backend probe runtime
  → backend spawn child process nếu probe thành công
  → execution kết thúc: completed | failed | cancelled
```

Ở delegated flow, trạng thái được ghi trước khi spawn để lệnh `status`, `wait`, `cancel` và `cleanup` ở process khác vẫn truy được execution.

Khi root kết thúc, Thread chiếu checkpoint của nó thành một context revision mới; lượt kế tiếp mở trên revision đó. Policy chạy **trước** bước Thread và không đọc gì từ Thread.

## Definition là nguồn quyền

Mỗi role có một `AgentDefinition` bất biến, gồm:

- model và reasoning effort cho Claude/Codex;
- quan hệ `reportsTo` và `delegatesTo`;
- tools, skills, memory scopes và workspace roots;
- workflow states và tools được dùng tại từng state;
- output contract.

Prompt có thể yêu cầu công việc, nhưng không thể mở rộng definition. Unknown role, tool, path hoặc memory scope bị từ chối trước khi runtime chạy.

## Fail-closed nghĩa là gì?

Fail-closed ưu tiên lỗi nhìn thấy được hơn hành vi “có vẻ vẫn chạy” nhưng sai quyền:

- gõ sai mode không fallback sang mode khác;
- request delegation không được cấp sẽ dừng trước runtime probe/spawn;
- custom agent có key YAML lạ hoặc capability vượt trần sẽ không được load;
- definition đổi sau khi trust sẽ bị deny đến khi duyệt lại;
- private memory không mở cho role khác chỉ vì role đó báo cáo lên coordinator.

Những quyết định trên do ALP giữ, trước khi runtime chạy. Sau khi execution đã spawn thì mức cưỡng chế tuỳ runtime — xem [runtime nào cưỡng chế phần nào](../agents-and-authority/#runtime-nào-cưỡng-chế-phần-nào).

## Source và artifact

Phân biệt hai nhóm để không sửa nhầm:

| Nguồn cần review | Artifact được sinh lại |
|---|---|
| Built-in definition trong source ALP | identity document dưới `~/.alp/agents/` |
| `.alp/agents/<id>/agent.yaml` của project | execution snapshot dưới `~/.alp/executions/` |
| Skill trong project | runtime settings/launch spec của execution |

:::caution[Không sửa artifact để đổi quyền]
Artifact có thể bị ghi đè ở lần sync, update hoặc execution tiếp theo. Hãy đổi source phù hợp và chạy lại trust/sync flow.
:::

## Kiểm chứng

Dùng `alp agent show <role>` để xem authority và skill resolution; dùng `alp agent test <role>` để kiểm static grants, dry-run prepare và deny paths mà không gọi model.

Tiếp theo: [Agent và quyền](../agents-and-authority/) hoặc [Giao việc](../../guides/delegation/).

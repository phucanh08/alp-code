---
title: Policy
description: PolicyEngine là cửa duy nhất trả lời cho hay không cho, chạy trước mọi runtime probe và spawn.
---

> **Một câu:** Policy là **một hàm thuần** trả lời `allow` hoặc `deny(<mã>, <lý do>)` cho một request có dạng cố định — và nó là cửa duy nhất, không có đường vòng.

Hai tính chất khiến nó đáng tin: nó không biết gì về runtime (không import adapter, không đọc PATH, không spawn), và nó kết thúc bằng `default: deny`.

## Tám loại request

| Loại | Trả lời bởi | Deny code |
|---|---|---|
| `delegation` | quan hệ `delegatesTo` của actor | `UNKNOWN_TARGET`, `DELEGATION_NOT_ALLOWED` |
| `memory` | grant scope của actor | `PRIVATE_MEMORY_DENIED`, `MEMORY_NOT_GRANTED` |
| `workspace` | roots + workspace của lượt này | `WORKSPACE_NOT_GRANTED`, `WORKSPACE_READ_ONLY`, `WORKSPACE_SCOPE_MISMATCH`, `PATH_RESOLUTION_FAILED` |
| `configuration` | **luôn deny** | `POLICY_MUTATION_DENIED`, `DEFINITION_MUTATION_DENIED` |
| `tool` | invariants → MCP grant → capability | `RAW_RUNTIME_TOOL_DENIED`, `INDIRECT_TOOL_REQUEST`, `TOOL_NOT_GRANTED` |
| `skill` | grant theo tên | `SKILL_NOT_GRANTED` |
| `subagent` | grant theo tên | `SUBAGENT_NOT_GRANTED` |
| `mcp` | grant theo tên server | `MCP_SERVER_NOT_GRANTED` |

Trước cả switch có hai lớp: request không có hình dạng mong đợi → `UNKNOWN_REQUEST`; actor không có trong registry → `UNKNOWN_ACTOR`. Sau switch là `default: deny("UNKNOWN_REQUEST")`. Thêm một loại request mới mà quên viết nhánh xử lý thì nó **bị từ chối**, không phải được cho qua.

`configuration` luôn deny là điều đáng dừng lại một nhịp: không có đường hợp lệ nào để một agent sửa policy source hay sửa definition của bất kỳ vai nào, kể cả của chính nó. Đây là lý do "prompt không mở được quyền" là một câu về kiến trúc chứ không phải một lời khuyên.

## Thứ tự bên trong request `tool`

```text
1. isRawRuntimeTool(tool) hoặc invokesRawRuntime(command)  → RAW_RUNTIME_TOOL_DENIED
2. hasIndirectCommand(command)                             → INDIRECT_TOOL_REQUEST
3. tool dạng mcp__<server>__<…>                            → hỏi grant MCP server
4. tool ∈ capabilities.tools ?                             → ALLOW | TOOL_NOT_GRANTED
```

**Lớp 1** chặn `herdr`, `paseo`, `create_agent`, `spawn_agent` — cả khi chúng là tên tool, và cả khi chúng nằm trong một lệnh shell sau `env`/`command`/`sudo`, sau gán biến, hoặc dưới đường dẫn đầy đủ. Lệnh được tách theo `;`, `&&`, `||`, `|` rồi kiểm từng đoạn. Không vai nào — kể cả một `orchestrator` tương lai — được ngoại lệ ở đây: một invariant có ngoại lệ cho đúng cái vai hay dùng nó nhất thì không còn là invariant.

**Lớp 2** từ chối lệnh mà việc đọc-để-hiểu trở nên vô nghĩa: `eval`, backtick, `$(…)`, process substitution, `base64`, `xxd`, `sh -c`/`bash -c`/`python -c`/`node -c`, `perl -e`, `ruby -e`, `xargs`. ALP **không cố parse** chúng — nó từ chối, vì một parser đúng-một-nửa là thứ tệ hơn.

:::caution[Guardrail, không phải sandbox]
Source ghi thẳng giới hạn này ra (`POLICY_GUARDRAIL_LIMITATION`): kiểm lệnh là guardrail cho agent hợp tác, không phải cách ly tiến trình thù địch. Code đối nghịch thì cần sandbox của hệ điều hành hoặc container.
:::

## Deny-first: thứ tự quan trọng hơn nội dung

Policy chạy **trước** runtime probe, trước backend health check, trước khi một chỗ trong [cây](../execution-graph/) bị chiếm, và trước khi byte đầu tiên chạm đĩa.

Hệ quả đo được:

- Một request trái policy **không** giữ slot đồng thời, dù chỉ trong khoảng thời gian nó mất để bị từ chối.
- Một request trái policy **không** làm backend bị health-check, nên nó không học được gì về hạ tầng bên dưới.
- Một request trái policy không tiêu một lượt trong allowance của phiên.

Đây là lý do `alp agent test --tier 3` kiểm được deny path mà không cần model: các quyết định này xảy ra hoàn toàn trước khi có model nào được gọi.

## Workspace: canonicalize rồi mới so

Path được `resolve` rồi `realpath`. Không realpath được thì thử realpath thư mục cha rồi ghép lại tên file — để một file *sắp* được tạo vẫn kiểm được. Thất bại hoàn toàn → `PATH_RESOLUTION_FAILED`, không phải cho qua.

So sánh sau canonicalize là cách một symlink trỏ ra ngoài workspace không biến thành một đường ghi hợp lệ.

## Policy được chốt vào snapshot

Quyết định của lượt này không được tính lại mỗi lần dùng: lúc `prepare`, ALP đóng băng toàn bộ quyền thành [`policy.json`](../execution/) kèm `definitionHash` và `policyHash`. Hook lúc kết thúc phiên tính lại policy từ registry và so nguyên văn — một snapshot bị sửa tay không dùng được.

## Kiểm chứng

```bash
alp agent test main --tier 3
alp agent test worker --tier 3 --json
```

Tier 3 chạy các deny path và đòi **đúng mã**, không chỉ đòi thất bại. Một deny sai mã cũng là finding.

## Liên quan

- [Capability](../capability/) — nội dung các grant mà policy tra
- [Delegation](../delegation/) — nơi deny-first quyết định thứ tự thao tác
- [Execution](../execution/) — snapshot và hai hash
- [Hook](../hook/) — cưỡng chế bên trong tiến trình runtime, và cái đã mất khi bỏ ACL hook

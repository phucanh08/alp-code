---
title: Agent
description: Agent trong ALP là một vai có definition bất biến viết bằng code, hash vào từng lượt chạy.
---

> **Một câu:** Agent là một **vai** — một `AgentDefinition` bất biến nói vai đó là ai, được dùng gì, đọc/ghi ở đâu, giao việc cho ai và phải kết thúc theo trình tự nào.

Chữ "agent" ở nơi khác thường nghĩa là *một model đang chạy có công cụ*. Trong ALP nó nghĩa là *một mục trong registry*. Phân biệt này không phải chuyện chữ nghĩa: model process đến rồi đi theo từng lượt, còn vai thì tồn tại trước lượt chạy, được review như source code, và là thứ policy tra cứu khi trả lời cho-hay-không.

## Definition gồm gì

```ts
{
  id, displayName,
  model: { claude, codex },              // chỗ dựa khi vai không có ghế trong nấc nào
  reasoningEffort: { claude, codex },
  reportsTo, delegatesTo,                // quan hệ
  autoCompactTokens?: { claude?, codex? },
  capabilities: { tools, skills, subagents, mcpServers, memory, workspace },
  instructions: { role, purpose, rules, audience? },
  workflow,                              // state machine + tool cho phép ở từng state
  output                                 // output contract
}
```

Ba tính chất đi kèm, và cả ba đều có hệ quả bạn thấy được:

- **Freeze sâu.** `defineAgent()` deep-clone rồi `Object.freeze` đệ quy. Code trong cùng process cũng không mutate được definition sau khi load.
- **Instructions là dữ liệu, không phải hàm.** `role`, `purpose`, `rules[]` là chuỗi. Nếu identity còn là closure thì hai vai có prompt hoàn toàn khác nhau vẫn hash giống nhau — vì chúng dùng chung một hàm render — và một hash principal đã trust sẽ nghiệm đúng cho một prompt khác.
- **Hash vào từng lượt chạy.** `definitionHash` = SHA-256 của definition đã canonicalize, nằm trong [`policy.json`](../execution/) của mọi execution. Đổi definition là đổi hash, và hash lệch là deny.

## Registry kiểm gì lúc load

Registry dựng một lần, kiểm hết, và **throw** thay vì bỏ qua mục sai:

| Kiểm tra | Mã lỗi |
|---|---|
| ID trùng | `DUPLICATE_AGENT` |
| ID / displayName / model / workflow rỗng, effort không hợp lệ | `INVALID_AGENT` |
| Ngưỡng auto-compact không nguyên, ngoài 100k–1M, hoặc vượt cửa sổ context của model | `INVALID_AUTO_COMPACT_LIMIT` |
| Tool ngoài catalog 9 tool | `UNKNOWN_TOOL` |
| Workspace write root không nằm trong read root | `INVALID_WORKSPACE_GRANT` |
| Memory write không được read bao phủ, hoặc `private:<vai khác>` | `INVALID_MEMORY_GRANT` |
| `reportsTo`/`delegatesTo` trỏ vai không tồn tại | `UNKNOWN_RELATION` |
| Tự giao việc cho chính mình, hoặc có chu trình | `INVALID_DELEGATION` |

Quan hệ delegation là một **DAG**, kiểm bằng duyệt ba màu. Một chu trình `a → b → a` không bao giờ lọt tới lúc chạy để rồi phát hiện bằng stack overflow.

## Chín vai built-in

| Vai | Việc của nó | Ghi workspace |
|---|---|---|
| `main` 🍜 | Coordinator: nghe principal, cắt việc, kiểm kết quả trả về | **không** |
| `worker` 🛠️ | Làm trọn một task đã được cắt sẵn | có — vai duy nhất |
| `search` | Tìm code, definition, call site trong repo local | không |
| `librarian` | Tra nguồn ngoài hoặc repo khác | không |
| `read-thread` | Truy quyết định và fact đã lưu trong memory | không |
| `review` | Review một concern có bằng chứng | không |
| `oracle` | Second opinion cho quyết định khó | không |
| `compaction` | Tóm tắt context theo contract | không |
| `titling` | Sinh một dòng title | không |

Cây quan hệ **phẳng**: `principal → main → {8 specialist}`. Chỉ `main` có `delegatesTo` khác rỗng.

### `main` không cầm bút

`main` không có `Write`, không có `Edit`, và khai `writeRoots: []`. Đây là một **ranh giới**, không phải một mức quyền thấp:

ghế duy nhất nói chuyện với principal cũng là ghế duy nhất giữ toàn cảnh. Khi nó vừa giữ toàn cảnh vừa tự sửa được file, mọi việc "nhỏ đủ để tự làm" sẽ ở lại đó — không nhát cắt, không báo cáo, không bằng chứng ai đọc lại được. Bỏ hẳn bút thì câu hỏi "nhỏ đủ chưa" biến mất.

Cưỡng chế ở lớp policy chứ không ở prompt: một `main` cố ghi nhận `WORKSPACE_NOT_GRANTED`, và `alp` hạ luôn phiên `main` xuống read-only kể cả trong project đã `alp init`.

### `worker` hẹp theo phạm vi, không theo loại việc

Bảy specialist kia hẹp theo *loại việc* (retrieval, research, review, second opinion). `worker` hẹp theo **phạm vi một lần giao**: nó là vai generic duy nhất ngoài `main`, và là vai duy nhất khai write root.

`delegatesTo` của nó rỗng. Nếu nó phải đi hỏi `search` giữa chừng thì cái sai nằm ở nhát cắt của `main`, không ở quyền của nó.

## Cái definition **không** quyết định

Đây là chỗ hay nhầm nhất:

| Thứ | Quyết bởi |
|---|---|
| Model và mức nghĩ | [Nấc](../../concepts/modes-and-runtimes/) — và `settings.json` nếu bạn ghi đè |
| Runtime (Claude hay Codex) | Model. Không có public switch |
| Quyền ghi workspace của một lượt | Definition của **vai đích** + project đã đăng ký chưa |
| Tool thật sự dùng được ở một bước | Giao của capability và [workflow state](../workflow/) hiện tại |

Project đã `alp init` là một **trần**, không phải một cái cấp phát: nó cho phép write mode tồn tại, còn việc lượt này có write hay không vẫn do vai đích quyết.

## Custom agent: cùng khái niệm, thêm trần

Custom agent (`.alp/agents/<id>/agent.yaml`) là cùng một `AgentDefinition`, dựng từ dữ liệu thay vì từ file TypeScript trong repo ALP. Vì nó đến từ project chứ không qua PR của ALP, nó chịu thêm một trần cứng: luôn là lá (`delegatesTo` rỗng, `reportsTo` cố định về `main`), memory write chỉ `private:<id>`, chưa mở workspace write, tools không vượt tools của `main`.

Và nó chịu thêm một cổng: **trust**. Trust ghim hash theo **project + agent ID** — hai project cùng có `migrator` là hai quyết định khác nhau. Definition đổi thì hash lệch và agent bị deny cho tới khi principal đọc diff rồi duyệt lại.

Xem [Custom agent](../../guides/custom-agents/) cho các bước, và [Capability](../capability/) cho trần chi tiết.

## Kiểm chứng

```bash
alp agent list --json
alp agent show worker
alp agent test worker --tier 1
```

`show` in definition đã resolve, trust status và capability diff. Tier 1 kiểm definition tĩnh, grant, skill root và mapping model/runtime — không gọi model, không tốn tiền.

## Liên quan

- [Capability](../capability/) — sáu nhóm quyền và trần của chúng
- [Policy](../policy/) — ai trả lời cho/không cho, và bằng mã gì
- [Workflow](../workflow/) — vì sao tool được cấp vẫn có thể không dùng được lúc này
- [Agent và quyền](../../concepts/agents-and-authority/) — bản rút gọn cho người mới

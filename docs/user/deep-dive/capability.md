---
title: Capability
description: Sáu nhóm quyền của một vai, cách chúng được kiểm, và phần nào runtime thật sự cưỡng chế.
---

> **Một câu:** Capability là danh sách **tên** một vai được cấp — tool, skill, subagent, MCP server, memory scope, workspace root — và mọi tên không có trong danh sách đều bị từ chối kèm chính cái tên đó trong thông báo.

Thông báo mang tên là một lựa chọn thiết kế, không phải chi tiết vụn: một lượt bị chặn phải nói được *grant nào sẽ mở nó*, chứ không chỉ nói rằng có gì đó bị từ chối.

## Sáu nhóm

| Nhóm | Nội dung | Deny code |
|---|---|---|
| **Tools** | Tên tool trong catalog 9 tool | `TOOL_NOT_GRANTED` |
| **Skills** | Tên skill vai được gọi | `SKILL_NOT_GRANTED` |
| **Subagents** | Subagent in-process (Claude) | `SUBAGENT_NOT_GRANTED` |
| **MCP servers** | Server vai được nối | `MCP_SERVER_NOT_GRANTED` |
| **Memory** | Logical scope đọc/ghi | `MEMORY_NOT_GRANTED`, `PRIVATE_MEMORY_DENIED` |
| **Workspace** | `readRoots` / `writeRoots` | `WORKSPACE_NOT_GRANTED`, `WORKSPACE_READ_ONLY`, `WORKSPACE_SCOPE_MISMATCH` |

Trên cả sáu nhóm có một luật thứ bảy, thuộc [workflow](../workflow/): tool còn phải được phép **ở state hiện tại**. Tập tool thật sự gửi cho runtime là *giao* của hai thứ đó.

## Catalog 9 tool

```text
Read · Write · Edit · Glob · Grep · Bash · WebSearch · WebFetch · Skill
```

Catalog đóng. Tool không có trong đó bị từ chối ngay lúc registry load (`UNKNOWN_TOOL`), không phải lúc chạy — nghĩa là một vai khai sai tên tool thì **cả ALP** không khởi động được, chứ không âm thầm chạy thiếu một tool.

Tool MCP có dạng `mcp__<server>__<tool>` và được định tuyến về grant *server*, không về catalog. Nếu hỏi catalog thì câu trả lời sẽ luôn là `TOOL_NOT_GRANTED` — đúng hôm nay, và vẫn "đúng" cả vào ngày server thật sự được cấp.

## Hai luật bao phủ

**Write luôn phải nằm trong read.** Cho cả workspace lẫn memory. Một vai ghi được vào chỗ nó không đọc được là một vai không kiểm chứng được việc mình vừa làm; registry từ chối ngay lúc load.

**Skill và tool `Skill` đi cùng nhau.** `skills` khác rỗng đúng khi và chỉ khi `tools` có `Skill`. Tool mà không có tên là quyền trên mọi skill root máy đang có; tên mà không có tool là quyền không có đường chạm tới.

## Memory grant khớp theo segment

Grant là một tiền tố có wildcard, khớp theo **segment** chứ không theo chuỗi:

| Grant | Bao | Không bao |
|---|---|---|
| `shared` | mọi `shared:*` | `project:*`, `private:*` |
| `shared:reference:*` | mọi entry dưới `shared:reference` | `shared:decisions:x` |
| `project:*` | mọi project | `shared:*` |
| `private:review` | đúng của `review` | `private:oracle` |

`private:<vai>` chỉ khớp đúng chủ sở hữu, và một definition khai `private:<vai khác>` bị từ chối lúc load. Quan hệ báo cáo **không** cấp quyền đọc: `main` không đọc được `private:worker` chỉ vì `worker` báo cáo lên nó.

## Workspace có hai tầng

Tầng một là definition: path phải nằm trong `readRoots`/`writeRoots` của vai, sau khi canonicalize bằng `realpath` (chống thoát bằng symlink).

Tầng hai chỉ áp cho execution được uỷ: path còn phải nằm trong **workspace của chính lượt này**. Một specialist khai `readRoots: ["."]` vẫn không đọc được workspace khác trong cùng một lượt delegation — `WORKSPACE_SCOPE_MISMATCH`.

## Phần nào runtime cưỡng chế thật

Grant được chốt như nhau ở lớp ALP. Hai runtime thì không giữ được cùng một lượng, và đây là giới hạn của Codex chứ không phải lỗi cấu hình:

| Grant | Claude Code | Codex CLI |
|---|---|---|
| Tool | ACL thật — từ chối lúc gọi | **Không cưỡng chế được** — shell là built-in |
| Read root, private memory | ACL thật | **Không cưỡng chế được** — sandbox read-only cho đọc mọi path |
| Ghi ngoài write root | ACL thật | Sandbox từ chối ✓ |
| Egress mạng | Không có tool mạng | Sandbox từ chối ✓ |

Đo ngày 2026-09-10, không suy từ tài liệu: một vai chỉ có `Read, Glob, Grep, Skill` đã chạy được `/bin/zsh -lc "… node -e …"` trên Codex.

Vì vậy `alp agent test --tier 2` và `alp agent add` in khối **Enforced by** ngay dưới bảng Authority, mô tả đúng policy đang xét — vai đã có `Bash` thì không bị nhắc "vẫn chạy lệnh được". Đọc khối đó trước khi trust, để không đọc bảng Authority như một lời hứa mà nó chỉ giữ được một nửa.

:::caution[Phiên interactive chạy không guardrail]
`alp` (phiên `main`) đặt cờ bypass của runtime: `permissions.deny` của Claude và sandbox của Codex bị vô hiệu hoá **cho riêng phiên đó**, gồm cả cách ly private memory. Principal ngồi ngay đó và tự duyệt được từng bước, nên prompt quyền chỉ là ma sát — nhưng đánh đổi thì phải nói thẳng.

Delegated execution thì không: `alp delegate` luôn `interactive: false`, và settings/config sinh cho nó vẫn mang đủ deny list và sandbox.
:::

## Trần của custom agent

Custom agent đến từ project chứ không qua PR của ALP, nên nó chịu thêm một trần cứng — đây là *trần*, không phải mặc định, nghĩa là không khai gì cũng không vượt được:

- luôn là lá: `delegatesTo` rỗng, `reportsTo` cố định về `main`;
- tools nằm trong catalog và không vượt tools của `main`;
- memory write chỉ được là `private:<id>`;
- workspace read root phải tương đối và trong project; **write chưa mở**;
- tối đa 20 skill, 20 rule, mỗi rule ≤ 240 ký tự;
- `output.kind` hiện chỉ nhận `text`.

Một binding thoát khỏi root được phép làm **cả agent** bị deny, không phải chỉ bỏ qua binding đó: một agent được cấp một phần là một agent đang chạy với quyền không ai mô tả.

## Kiểm chứng

```bash
alp agent show librarian
alp agent test librarian --tier 2
alp agent test librarian --tier 3
```

Tier 2 in Authority + **Enforced by** + egress + launch spec mà không spawn model. Tier 3 kiểm các deny path trả đúng mã policy.

## Liên quan

- [Agent](../agent/) — định nghĩa nào cấp các capability này
- [Policy](../policy/) — cửa trả lời cho/không cho và toàn bộ mã deny
- [Memory](../memory/) — logical ID và cách grant khớp
- [Skill](../skill/) — vì sao thư mục `skills/` *chính là* grant

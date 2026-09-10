---
title: Custom agent
description: Khai báo, kiểm tra và trust một specialist riêng cho project.
---

Custom agent là definition dạng dữ liệu trong project. Nó chỉ chạy sau khi vượt capability ceiling, ba tầng kiểm tra và trust gate tương tác.

## 1. Tạo definition

Tạo `.alp/agents/migrator/agent.yaml`:

```yaml
schemaVersion: 1
id: migrator
displayName: "Migrator 🔧"

model:
  claude: claude-opus-5
  codex: gpt-5.6-terra
reasoningEffort:
  claude: high
  codex: medium

instructions:
  role: "Framework migration specialist"
  purpose: "Migrate one module per execution and prove the result with tests."
  houseRules: code-native+craft
  rules:
    - "Never migrate more than one module per execution."

capabilities:
  tools: [Read, Glob, Grep]
  memory:
    read: ["private:migrator"]
    write: ["private:migrator"]
  workspace:
    readRoots: ["."]

workflow:
  - id: ASSESS
    allowedTools: [Read, Glob, Grep]
  - id: REPORT
    allowedTools: []

output:
  kind: text
```

Directory name và `id` phải trùng nhau, đều ở dạng kebab-case. Object dùng strict schema: key sai chính tả hoặc key của version tương lai bị từ chối, không bị bỏ qua.

## 2. Hiểu capability ceiling

Custom agent luôn là leaf:

- `reportsTo` bị cố định về `main`; không khai trong YAML;
- `delegatesTo` bị cố định rỗng;
- tools phải nằm trong catalog và không vượt tools của `main`;
- memory write chỉ được là `private:<id>`;
- workspace read root phải tương đối và nằm trong project;
- workspace write chưa mở cho custom agent;
- `output.kind` hiện chỉ nhận `text`;
- tối đa 20 rules, mỗi rule tối đa 240 ký tự.

`houseRules` chọn từ `none`, `code-native` hoặc `code-native+craft`. Bỏ trường này nhận `code-native`, không phải `none`.

## 3. Kiểm tra trước khi trust

```bash
alp agent test migrator
alp agent show migrator
```

`test` dừng ở tier đỏ đầu tiên. Sửa toàn bộ finding về schema, capability, skill hoặc deny path trước khi tiếp tục.

## 4. Trust agent

```bash
alp agent add migrator
```

ALP load lại definition, chạy đủ ba tier, in authority, **enforced by**, egress, cost rồi hỏi xác nhận. Trust chỉ hoàn tất trong terminal thật khi câu trả lời đúng `yes`; không có flag auto-approve.

Đọc khối **Enforced by** trước khi trả lời: nó nói phần nào của bảng Authority được runtime cưỡng chế thật và phần nào chỉ là ràng buộc mức prompt. Trên Codex, tool grant và read root thuộc nhóm thứ hai — vai không có `Bash` vẫn chạy được lệnh. Chi tiết ở [Agent và quyền](../../concepts/agents-and-authority/#runtime-nào-cưỡng-chế-phần-nào).

Trust ghim hash theo **project + agent ID**. Hai project cùng có `migrator` là hai quyết định khác nhau.

:::caution[Sửa file làm mất trust]
Definition, prompt hoặc house rules đổi sẽ làm hash lệch. Agent bị deny đến khi bạn chạy lại `alp agent add migrator` và đọc thay đổi. Đây là fail-closed, không phải cache lỗi.
:::

## 5. Giao việc

Sau khi trust:

```bash
alp delegate migrator --project ~/code/my-app -- "Assess the payments module and report migration blockers"
```

Thu lại trust khi không còn dùng:

```bash
alp agent untrust migrator
```

## Kiểm chứng

```bash
alp agent list
alp agent show migrator
alp agent test migrator --tier 1 --json
```

`list/show` phải hiển thị đúng trust status và resolved authority. Xem [Skill của project](../project-skills/) để cấp knowledge mà không mở thêm tool.

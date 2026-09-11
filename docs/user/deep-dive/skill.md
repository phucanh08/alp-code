---
title: Skill
description: Gói tri thức có SKILL.md — thư mục là danh sách grant, một hop symlink, và vì sao một link lạc làm hỏng cả agent.
---

> **Một câu:** Skill là một **gói tri thức/quy trình có `SKILL.md`** mà một vai được phép đọc — nó không phải agent, không tự chạy, và không có quyền riêng.

Skill trả lời câu hỏi *"làm việc này ở đây thì làm thế nào"*. Nó không trả lời *"ai được làm"* — đó là việc của [capability](../capability/) và [policy](../policy/).

## Skill không phải agent

| | Agent | Skill |
|---|---|---|
| Có identity? | Có (`role`, definition hash) | Không |
| Có quyền riêng? | Có (`capabilities`) | Không — mượn quyền của vai đang đọc |
| Tự chạy được? | Có, qua delegation | Không |
| Tốn một execution? | Có | Không |

Hệ quả quan trọng: **cấp thêm skill không cấp thêm quyền**. Một skill mô tả cách chạy migration cho một vai không có `Bash` thì vẫn là văn bản vai đó đọc mà không làm được gì.

## Thư mục chính là danh sách grant

`<agent>/skills/` là grant list. Một vai thấy **đúng** những gì được đặt hoặc trỏ vào thư mục của chính nó — không bao giờ thấy cả `.alp/skills/`.

Không có field `skills:` nào trong `agent.yaml` cho project skill, cố tình: hai nguồn sự thật thì sớm muộn sẽ mâu thuẫn, và lúc đó không ai biết cái nào đúng.

## Ba hình dạng entry

```text
.alp/agents/migrator/skills/
├── framework-migration/         # 1. directory thật — skill riêng của vai này
│   └── SKILL.md
├── house-conventions -> ../../../skills/house-conventions   # 2. symlink
└── release-drill.skillref       # 3. file text, đúng một relative path
```

| Hình dạng | Luật riêng | Đích phải nằm trong |
|---|---|---|
| Directory | — | chính `<agent>/skills/` |
| Symlink | **đúng một hop**; trỏ vào symlink khác là từ chối | `.alp/skills` hoặc built-in skills root |
| `.skillref` | đúng **một** dòng, **relative** path | `.alp/skills` hoặc built-in skills root |

`.skillref` tồn tại cho Windows và cho những checkout không giữ symlink. Path phải relative vì một path tuyệt đối nằm trong file được commit là layout của một máy cụ thể bị viết vào repo.

Một hop, không phải một chuỗi: chuỗi symlink là cách giặt đích đi qua mắt người chỉ kiểm cái link đầu tiên.

## Bốn điều kiện, kiểm theo thứ tự

Với mỗi entry, sau khi xác định tên và đích:

1. Tên không rỗng, và **không trùng** một entry đã thấy — trùng thì báo `skill <tên> is granted twice`.
2. `realpath(target)` phải tồn tại.
3. Đích phải nằm trong tree được phép — directory trong chính `<agent>/skills/`, link trong `.alp/skills` hoặc built-in root.
4. Đích phải chứa một file `SKILL.md`.

Entry được duyệt theo thứ tự tên đã sort, nên hai lần scan cho ra cùng một danh sách.

:::danger[Một link lạc từ chối cả agent]
Nếu một entry resolve ra ngoài vùng được phép, ALP **không** bỏ riêng entry đó rồi chạy tiếp — nó từ chối **toàn bộ** agent.

Lý do nằm ở chỗ skill root là một **read grant**. Một link ra ngoài biến "được đọc skill của mình" thành "được đọc bất cứ đâu", trong khi `workspace.readRoots` vẫn nói điều ngược lại. Và một agent bị từ chối một phần grant là một agent đang chạy với quyền không ai mô tả được — tệ hơn một agent không chạy.
:::

## Trần 20

```text
MAX_SKILLS_PER_AGENT = 20
```

Skill được nạp vào context, nên một danh sách không có trần là một lỗ trong ngân sách context. Vượt trần là một issue của agent đó, không phải một cảnh báo bỏ qua được.

## Skill built-in và tool `Skill`

ALP ship 15 skill built-in:

`agent-memory` · `alp-debug` · `alp-plan` · `alp-predict` · `alp-scenario` · `code-review` · `delegation` · `docs-seeker` · `git` · `gkg` · `problem-solving` · `repomix` · `research` · `security-scan` · `test-quality-guard`

Vai có sẵn khai chúng **theo tên** trong `capabilities.skills`:

| Vai | Skill |
|---|---|
| `main` | `alp-plan`, `problem-solving`, `delegation`, `git`, `agent-memory` |
| `worker` | `problem-solving`, `alp-debug`, `git`, `agent-memory`, `test-quality-guard` |
| `review` | `code-review`, `alp-scenario`, `security-scan`, `test-quality-guard` |
| `librarian` | `docs-seeker`, `research`, `repomix` |
| `oracle` | `alp-debug`, `alp-predict`, `alp-scenario`, `problem-solving` |
| `search` | `gkg`, `repomix` |

Hai luật đi kèm:

- Khai skill theo tên thì **phải** có tool `Skill` trong `capabilities.tools`. Grant một thứ mà không có cách gọi nó là một grant chết.
- Project skill **không** khai lại trong `capabilities.skills`; entry trong `<agent>/skills/` đã là grant. Khai cả hai cho cùng một tên → loader từ chối vì grant lặp.

## Overlay cho vai có sẵn

Thêm skill cho một vai có sẵn bằng cách tạo thư mục overlay, **không** tạo `agent.yaml` cạnh một ID có sẵn:

```text
.alp/agents/review/skills/house-conventions.skillref
```

Overlay chỉ thêm skill. Nó không thêm tool `Skill` cho một vai chưa có tool đó, và không sửa được bất kỳ phần nào khác của definition — đó là ranh giới giữa "cấu hình" và "định nghĩa lại một vai đã được review".

## Kiểm chứng

```bash
alp agent show review     # thứ tự skill và target đã resolve
alp doctor
```

`alp agent show` in **path đã resolve**, nên một `.skillref` trỏ sai chỗ hiện ra ở đây trước khi nó làm hỏng một phiên.

## Liên quan

- [Capability](../capability/) — quan hệ `skills` ↔ tool `Skill`
- [Agent](../agent/) — nơi grant được khai
- [Skill của project](../../guides/project-skills/) — hướng dẫn từng bước

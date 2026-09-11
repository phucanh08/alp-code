---
title: Memory
description: Logical ID, ba scope, versioning lạc quan, audit trail, và vì sao path không bao giờ do agent tự chọn.
---

> **Một câu:** Memory là kiến thức **sống lâu hơn một execution**, và mọi truy cập đi qua một **logical ID** mà policy hiểu — chứ không qua một đường dẫn file mà agent tự nghĩ ra.

Đây là khác biệt nền tảng so với "cho agent quyền đọc thư mục notes". Nếu agent chọn path, quyền của nó là *bất kỳ path nào nó nghĩ ra*. Nếu agent chọn ID, quyền của nó là *đúng những ID policy đã cấp*.

## Logical ID

```text
shared:<segment>[:<segment>…]
project:<projectId>:<segment>[:<segment>…]
private:<role>:<segment>[:<segment>…]
```

`parseMemoryId` là cửa duy nhất. Nó tách theo `:` và đòi:

- segment đầu là đúng một trong `shared` / `project` / `private`;
- `shared` có **ít nhất 2** phần, `project` và `private` có **ít nhất 3** (vì phần thứ hai là project ID hoặc role);
- mọi segment còn lại đều **hợp lệ**: không rỗng, không phải `.` hay `..`, không chứa `/` hay `\`.

Sai bất kỳ điểm nào → `InvalidMemoryIdError`, trước khi chạm tới bất kỳ hệ thống file nào. Đây là chỗ `../../.ssh/id_rsa` chết: nó không "bị chặn khi mở file", nó không bao giờ được công nhận là một memory ID.

## Ba scope

| Scope | Dùng cho | Ai đọc được |
|---|---|---|
| `shared` | Fact chung, preference của principal, reference dùng chung | Vai có grant phủ |
| `project:<id>` | Mục tiêu, quyết định, log, reference của một project | Vai có grant phủ đúng project đó |
| `private:<role>` | Draft và nhật ký làm việc của đúng vai đó | Chỉ chính vai đó, khi được grant |

`reportsTo` **không** cấp quyền đọc private của vai khác. `main` là cha của `worker` trong sơ đồ báo cáo, và vẫn không đọc được `private:worker:*`. Fact cần dùng chung phải đi vào `shared`/`project`, hoặc quay về trong output — đó là hai đường hợp pháp.

## Grant phủ ID thế nào

Grant là chuỗi có cùng hình dạng, so khớp **theo segment**, với `*` ở cuối phủ mọi thứ sâu hơn:

| Grant | Phủ | Không phủ |
|---|---|---|
| `shared` | mọi ID `shared:…` | `project:…`, `private:…` |
| `project:alp` | `project:alp:goals`, `project:alp:log:2026-09` | `project:other:goals` |
| `project:*` | mọi project | `shared:…`, `private:…` |
| `private:worker` | mọi private của `worker` | `private:main:…` |
| `shared:team:*` | `shared:team:onboarding` và sâu hơn | `shared:team` (chính nó, không sâu hơn) |

Dạng hai phần (`project:alp`, `private:worker`) đã phủ toàn bộ nhánh bên dưới — `*` chỉ cần khi
bạn muốn phủ **mọi** project hay mọi vai, hoặc khi cắt ở một tầng sâu hơn.

Một grant không phủ → `MEMORY_NOT_GRANTED` (hoặc `PRIVATE_MEMORY_DENIED` khi vai đụng vào private của vai khác), request bị deny trước khi có I/O.

## Năm thao tác, một cổng

`MemoryService` mở đúng năm cửa: `search`, `get`, `create`, `update`, `delete`. Mỗi cửa làm ba việc, luôn theo thứ tự:

1. **parse** ID thành scope + grant;
2. **authorize** qua policy engine với `{ type: "memory", actor, operation: "read" | "write", scope }`;
3. **audit** kết quả — `allowed`, `denied`, hay `error` — kèm actor, thao tác, ID và timestamp.

Deny được ghi audit **rồi** mới ném `UnauthorizedMemoryAccessError` kèm đúng deny code. Một lần từ chối không được phép biến mất im lặng: nó là dữ liệu về việc ai đã cố làm gì.

Đổi storage adapter không đổi quyền, vì authorize nằm ở service boundary chứ không nằm trong adapter.

## Versioning lạc quan

Mỗi entry có `version` tăng dần. `update` và `delete` phải mang `expectedVersion`; lệch thì `MemoryVersionConflictError` với cả số mong đợi lẫn số thật.

Hai execution cùng sửa một fact thì một cái thắng và cái kia **biết rằng mình thua**. Đây là cùng một triết lý với revision của [execution graph](../execution-graph/): lost update là lỗi, không phải kết quả.

Các lỗi còn lại: `MemoryEntryNotFoundError`, `MemoryEntryAlreadyExistsError` (`create` không bao giờ ghi đè).

## Năm `kind`

`fact` · `decision` · `reference` · `log` · `draft`.

Store Markdown đọc `kind:` từ frontmatter của file; thiếu hoặc không nhận ra thì rơi về `reference` chứ không từ chối file. Một note viết tay bị sai frontmatter vẫn đọc được — nó chỉ mất khả năng được lọc theo kind.

## Trên đĩa

Root mặc định là `~/.alp/memory`; `ALP_MEMORY_ROOT` ghi đè, và đó là đường duy nhất chạy một ALP hoàn toàn cô lập (test, CI, sandbox).

```text
~/.alp/memory/
├── shared/<segments…>.md
├── projects/<projectId>/<segments…>.md
└── private/<role>/<segments…>.md
```

`MemoryPathMapper` dựng path từ ID đã parse, rồi kiểm ba lần:

- path dựng ra phải nằm trong root (`memory path escapes root`);
- thư mục cha gần nhất đang tồn tại, sau `realpath`, phải vẫn nằm trong root — nên một symlink giữa đường không đưa ghi ra ngoài;
- chính file đích **không được là symlink** (`memory path symlink escape`).

Ghi là atomic: file tạm `0600` trong cùng thư mục, rồi `rename`. Một lần `kill -9` giữa chừng để lại file cũ nguyên vẹn, không để lại một file nửa vời.

## Ranking là tất định

`DeterministicContextRanker` xếp hạng theo ba tiêu chí, đúng thứ tự: số term khớp (trong `id` + `content`, không phân biệt hoa thường) → `updatedAt` mới hơn → `id` theo alphabet.

Không có embedding, không có điểm số học được. Hai lần chạy cùng một query trên cùng dữ liệu cho **cùng một thứ tự** — thứ khiến một phiên có thể tái lập được, và khiến một bug về context là thứ debug được.

## Ngân sách ký tự

`buildMemoryContext` nhận một `characterBudget` và trả về `diagnostics`: `charactersUsed`, `truncated`, và `omittedEntryIds` — **danh sách ID bị bỏ**, không chỉ một cờ boolean.

Vì vậy "agent không biết fact đó" là một câu trả lời kiểm chứng được: hoặc ID không nằm trong grant, hoặc nó nằm trong `omittedEntryIds` vì hết ngân sách.

:::caution[Mức cưỡng chế khác nhau theo runtime]
Trên Claude, cách ly private memory là ACL thật trong `permissions.deny`. Trên Codex, sandbox chỉ hạn chế **ghi** — đọc mọi path đều được — nên ở đó đây là ràng buộc mức prompt. Phiên interactive bỏ qua deny list ở cả hai runtime. Xem [Capability](../capability/#phần-nào-runtime-cưỡng-chế-thật).
:::

## Kiểm chứng

```bash
ls -R "${ALP_MEMORY_ROOT:-$HOME/.alp/memory}"
alp agent show worker    # memory grant của một vai
```

## Liên quan

- [Capability](../capability/) — grant memory nằm ở đâu trong definition
- [Policy](../policy/) — request `memory` được phán xử thế nào
- [Checkpoint và continuity](../continuity/) — thứ **không** phải memory: state của một execution
- [Memory và continuity](../../guides/memory-and-continuity/) — hướng dẫn dùng hằng ngày

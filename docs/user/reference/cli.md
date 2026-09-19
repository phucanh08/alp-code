---
title: CLI reference
description: Public command và option của stable ALP.
---

Reference này phản ánh stable `v0.15.0`. Nguồn kiểm chứng: [`src/cli/alp.ts`](https://github.com/phucanh08/alp-code/blob/v0.15.0/src/cli/alp.ts) và [`src/cli/commands/`](https://github.com/phucanh08/alp-code/tree/v0.15.0/src/cli/commands).

Internal hook/supervisor dispatch không thuộc public API và không được liệt kê ở đây.

## Phiên main và mode

| Command | Ý nghĩa |
|---|---|
| `alp` | Mở phiên `main`, dùng mode theo precedence |
| `alp --mode <low\|medium\|high\|ultra\|puck>` | Override mode cho phiên này |
| `alp --title <tiêu đề>` | Đặt tên cho Thread mới mở; chỉ là nhãn |
| `alp mode show` | Xem mode đã lưu, kèm file settings và role bị ghi đè |
| `alp mode set <mode>` | Lưu mode cho phiên sau |

Chỉ được chọn một mode. Option lạ và mode sai đều fail thay vì fallback.

Loadout của mode (model + reasoning effort của từng role) ghi đè được bằng `~/.alp/settings.json`, `<project>/.alp/settings.json` và `<project>/.alp/settings.local.json` — đọc theo đúng thứ tự đó, file sau thắng. Xem [Tùy biến loadout của mode](../../guides/customize-mode-loadouts/) để cấu hình và [Nấc và runtime](../../concepts/modes-and-runtimes/) để hiểu cách định tuyến.

## Project và identity

```text
alp init [path]
alp deinit [path]
alp identity sync
alp principal show
alp principal set
```

- `init`/`deinit` nhận tối đa một path; mặc định là cwd.
- `principal set` cần terminal tương tác để hỏi ba trường profile.
- `identity sync` sinh lại machine-local identity cache từ built-in registry.

## Agent

```text
alp agent test <role...> [--project <path>] [--tier 1|2|3] [--mode <mode>] [--json]
alp agent test --all [--project <path>] [--tier 1|2|3] [--mode <mode>] [--json]
alp agent add <id> [--project <path>]
alp agent show <id> [--project <path>]
alp agent untrust <id> [--project <path>]
alp agent list [--project <path>] [--json]
```

- `--tier` có thể lặp; không truyền thì chạy 1 → 2 → 3 và dừng ở tier đỏ đầu tiên.
- `--all` không đi cùng role positional.
- `add` chạy test rồi mở trust prompt; chỉ nhận `--project` ngoài agent ID.
- `show` in definition, trust/capability diff và skill resolution.
- `untrust` thu trust theo project + ID.
- `list --json` và `test --json` phù hợp cho script; `add/show/untrust` không nhận `--json`.

- Tier 2 của `test` và `add` in disclosure đầy đủ: Authority, **Enforced by**, Egress, Cost, Launch.

`agent test` trả `0` khi sạch, `1` khi có finding.

## Delegation

```text
alp delegate <role> [--background] [--timeout-ms <positive>] [--project <path>] -- <task>
alp delegate <role> [--background] [--timeout-ms <positive>] [--workspace <path>] -- <task>
alp delegate <role> [--write-scope <path>]... [--require-evidence change|verify:<id>]...
                    [--budget-tokens N] [--budget-tool-calls N] -- <task>
```

`--project` và `--workspace` là hai spelling của cùng input. Foreground đợi kết quả; `--background` trả execution ID ngay. Task rỗng, timeout không dương hoặc target role thiếu đều bị từ chối.

`alp delegate` chỉ chạy bên trong một phiên ALP: gõ từ terminal trần trả `PARENT_EXECUTION_REQUIRED`, vì vai cha đến từ execution đang chạy chứ không từ biến môi trường. Lệnh lifecycle dưới đây không chịu ràng buộc đó — chúng tra theo execution ID và chạy được từ terminal trần.

Lifecycle:

```text
alp delegation tree <execution-id> [--json]
alp delegation status <execution-id>
alp delegation wait <execution-id>
alp delegation cancel <execution-id>
alp delegation cleanup <execution-id>
alp delegation list
alp delegation evidence <execution-id> [--json]
alp delegation accept <request-id> [--reason <why>]...
alp delegation reject <request-id> --reason <why>...
alp trust verify [--project <path>] [--revoke]
```

- `tree` nhận ID của **bất kỳ** execution nào trong phiên và luôn vẽ từ gốc xuống, đánh dấu `←` vào execution được hỏi. Header mang revision, hạn của phiên, allowance đã dùng/còn lại, số node sống, số chỗ đã giữ, và trần. Không có `--json` thì CLI tự định dạng — đây là lệnh lifecycle duy nhất làm vậy; `--json` trả nguyên view.
- `cancel` dừng execution và mọi execution nó đã giao xuống; nhánh khác không bị đụng.
- `cleanup` chỉ dọn file tạm, log và record process của backend. Node và kết quả lịch sử ở lại. Nó từ chối execution còn `queued`/`running` (`INVALID_REQUEST`); một backend đã quên execution thì được coi là đã dọn xong, không phải lỗi.
- `evidence` thu (hoặc thu lại phần còn `unknown`) bằng chứng của một execution đã kết thúc và in `evaluation`, từng item với nguồn/độ tin, `usage`, `budget`, `decision`. `wait` cũng thu; `status`/`tree`/`cancel` không bao giờ thu. `evaluation` là `unevaluated` khi request không có `--require-evidence` — chưa kiểm gì, không phải đạt; `wait --json` còn có `evidence.changes[]` (nguồn, `provenance`, commit, số path) để phân biệt con đã đổi gì với con không làm gì, và `evidence.toolCalls` / `evidence.toolErrors[]` (`name`, `summary`, `tail` — tối đa 5) để thấy tool nào của con đã lỗi và nó nói gì. Item `tool-call` mang `result: { digest, bytes, tail }` của output (đã lọc secret, 2 KB cuối); text view in 3 dòng cuối cho call lỗi, `--json` có nguyên đuôi.
- `wait`/`status` của một execution đã kết thúc có `outcome: { disposition, reason, evidenceRefs }` — cái con **tự khai** ở đuôi báo cáo (`Disposition: done | blocked | reopen-request | dependency-request`), tách khỏi `status` (process có sống hết không) và `evidence` (workspace có đổi không). Con không khai, khai sai bảng, hay chết trước khi khai đọc là `unknown` — không phải `done`. `tree` in `disposition …` trên mọi node đã dừng.
- `accept|reject` nhận **request ID**, chỉ từ cha trực tiếp, trong một phiên ALP; con phải đã kết thúc; mỗi request quyết một lần. `reject` bắt buộc `--reason`. Dòng phán quyết in `disposition …` con khai lúc cha quyết, và bản ghi acceptance giữ lại giá trị đó.
- `trust verify` duyệt khối `verify.commands` của project trên terminal — điều kiện để `verify:<id>` chạy.
- Cả năm lệnh hỏi cây trước và chỉ dùng record cũ khi cây không có node nào cho ID đó. Cây hỏng thì lệnh **lỗi**, không lặng lẽ trả lời bằng record cũ. `tree` không có đường lui đó: execution trước-execution-graph trả `EXECUTION_NOT_FOUND`.

### Lỗi hay gặp của delegation

| Lỗi | Nghĩa | Làm gì |
|---|---|---|
| `PARENT_EXECUTION_REQUIRED` | `alp delegate` chạy ngoài một phiên ALP | Mở `alp` rồi nhờ `main` giao việc |
| `DEPTH_LIMIT_EXCEEDED` | Cây đã sâu 2 tầng | Giao việc từ tầng trên, hoặc cắt nhỏ ở chỗ khác |
| `CHILD_LIMIT_EXCEEDED` · `CONCURRENCY_LIMIT_EXCEEDED` | Một execution đã giao 4 việc, hoặc đang chạy 2 | `tree` để xem cái nào còn sống; đợi hoặc `cancel` |
| `GRAPH_CONCURRENCY_LIMIT_EXCEEDED` | Cả phiên đã có 6 execution sống | Như trên, nhìn cột `active` |
| `DELEGATION_LIMIT_EXCEEDED` | Hết 8 lượt của cả đời phiên | Mở phiên mới |
| `WALL_CLOCK_EXCEEDED` | Phiên quá hạn 2 giờ | Mở phiên mới; hạn không gia hạn được |
| `WRITE_SCOPE_NOT_FOUND` · `WRITE_SCOPE_OUTSIDE_WORKSPACE` · `WRITE_SCOPE_EXCEEDS_PARENT` · `WRITE_SCOPE_ON_READ_ONLY` | `--write-scope` trỏ vào chỗ không có, ngoài workspace, rộng hơn scope của cha, hay vai đích không ghi được | Sửa đường dẫn; scope phải tồn tại sẵn, ALP không tạo hộ |
| `ACCEPTANCE_NOT_PARENT` · `ACCEPTANCE_SUBJECT_RUNNING` · `ACCEPTANCE_ALREADY_DECIDED` | Nghiệm thu một request không phải của mình, con còn chạy, hay đã quyết rồi | Chỉ cha trực tiếp quyết; `cancel` rồi `reject` nếu muốn dừng; đổi ý là giao lại |
| `EXECUTION_GRAPH_CORRUPT` · `EXECUTION_GRAPH_LOCK_TIMEOUT` | Không đọc/khoá được file cây | Xem [Xử lý sự cố](../troubleshooting/#cây-execution-hỏng-hoặc-bị-khoá) |

## Thread

```text
alp thread list [--all]
alp thread show [<thread-id>]
alp thread continue <thread-id> [--mode <mode>]
alp thread context <thread-id>
alp thread reconcile <thread-id>
alp thread sync <thread-id>
alp thread close <thread-id>
alp thread archive <thread-id>
```

- Bare `alp` **luôn** mở Thread mới; `continue` là cách duy nhất mở lượt tiếp theo của một Thread, và lượt đó là một execution mới (ID, policy, tiến trình mới — không `--resume`).
- `list` mặc định chỉ Thread `open` trong workspace hiện tại; `--all` thêm mọi workspace và trạng thái.
- `show` không đối số đọc `ALP_THREAD_ID` của phiên đang chạy; luôn reconcile trước khi in.
- `continue` từ chối khi Thread còn một lượt đang chạy (`THREAD_BUSY`), đã đóng (`THREAD_CLOSED`) hoặc đã archive (`THREAD_ARCHIVED`).
- `sync` chép lại history từ transcript runtime cho mọi lượt đã kết thúc; chạy lại không nhân đôi entry.
- `close` chỉ từ `open`; `archive` chỉ từ `closed`. Không có reopen.

Xem [Thread](../../deep-dive/thread/).

## Context và continuity

```text
alp context status [execution-id]
alp context validate [execution-id]
alp context pin decision -- <text>
alp context pin constraint -- <text>
alp context pin open-item -- <text>
alp context pin next-action -- <text>
alp context unpin <pin-id>
```

`status`/`validate` lấy positional execution ID trước, sau đó mới dùng `ALP_DELEGATION_EXECUTION_ID`. Pin/unpin thao tác trên execution hiện tại và không đoán “latest”.

## Bảo trì

| Command | Ý nghĩa |
|---|---|
| `alp doctor [--quiet]` | Kiểm installation, registry, runtime, memory và execution state |
| `alp update` | Cập nhật theo channel đã cài; không nhận option |
| `alp uninstall [--force]` | Gỡ ALP-owned installation/state, backup memory mặc định |
| `alp --version`, `alp -v` | In build version qua fast path |
| `alp help`, `alp --help`, `alp -h` | In help |

Doctor trả `0` khi healthy, `1` khi có finding và `2` khi doctor tự lỗi.

:::danger[Memory purge]
`alp uninstall --purge-memory` xoá memory thay vì tạo backup. Flag này cố ý nằm ngoài happy path; tự sao lưu trước khi dùng.
:::

## Environment variables thường dùng

| Biến | Tác dụng |
|---|---|
| `ALP_MODE` | Chọn mode sau CLI flag và trước saved preference |
| `ALP_EXECUTION_GRAPH_ID` · `ALP_DELEGATION_EXECUTION_ID` · `ALP_EXECUTION_CAPABILITY` · `ALP_EXECUTION_DEADLINE_AT` | Binding do ALP cấp cho execution nó spawn — tất-cả-hoặc-không. **Không tự đặt**: chúng là danh tính của một execution, không phải cấu hình |
| `ALP_THREAD_ID` | Nhãn Thread của execution đang chạy, để `alp thread show` không đối số. **Không phải quyền**: đặt tay không đổi gì |
| `ALP_SKIP_UPDATE_CHECK=1` | Tắt background update check, hữu ích trong test/CI cô lập |
| `ALP_STATE_HOME` | Đổi machine state root |
| `ALP_MEMORY_ROOT` | Đổi riêng memory root |

Với lỗi parser hoặc policy, xem [Xử lý sự cố](../troubleshooting/).

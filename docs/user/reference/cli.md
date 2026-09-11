---
title: CLI reference
description: Public command và option của stable ALP.
---

Reference này phản ánh stable `v0.13.0`. Nguồn kiểm chứng: [`src/cli/alp.ts`](https://github.com/phucanh08/alp-code/blob/v0.13.0/src/cli/alp.ts) và [`src/cli/commands/`](https://github.com/phucanh08/alp-code/tree/v0.13.0/src/cli/commands).

Internal hook/supervisor dispatch không thuộc public API và không được liệt kê ở đây.

## Phiên main và mode

| Command | Ý nghĩa |
|---|---|
| `alp` | Mở phiên `main`, dùng mode theo precedence |
| `alp --mode <low\|medium\|high\|ultra\|puck>` | Override mode cho phiên này |
| `alp mode show` | Xem mode đã lưu, kèm file settings và role bị ghi đè |
| `alp mode set <mode>` | Lưu mode cho phiên sau |

Chỉ được chọn một mode. Option lạ và mode sai đều fail thay vì fallback.

Loadout của mode (model + reasoning effort của từng role) ghi đè được bằng `~/.alp/settings.json`, `<project>/.alp/settings.json` và `<project>/.alp/settings.local.json` — đọc theo đúng thứ tự đó, file sau thắng. Xem [Nấc và runtime](../../concepts/modes-and-runtimes/#đổi-model-của-một-role-settingsjson).

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
```

- `tree` nhận ID của **bất kỳ** execution nào trong phiên và luôn vẽ từ gốc xuống, đánh dấu `←` vào execution được hỏi. Header mang revision, hạn của phiên, allowance đã dùng/còn lại, số node sống, số chỗ đã giữ, và trần. Không có `--json` thì CLI tự định dạng — đây là lệnh lifecycle duy nhất làm vậy; `--json` trả nguyên view.
- `cancel` dừng execution và mọi execution nó đã giao xuống; nhánh khác không bị đụng.
- `cleanup` chỉ dọn file tạm, log và record process của backend. Node và kết quả lịch sử ở lại. Nó từ chối execution còn `queued`/`running` (`INVALID_REQUEST`); một backend đã quên execution thì được coi là đã dọn xong, không phải lỗi.
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
| `EXECUTION_GRAPH_CORRUPT` · `EXECUTION_GRAPH_LOCK_TIMEOUT` | Không đọc/khoá được file cây | Xem [Xử lý sự cố](../troubleshooting/#cây-execution-hỏng-hoặc-bị-khoá) |

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
| `ALP_SKIP_UPDATE_CHECK=1` | Tắt background update check, hữu ích trong test/CI cô lập |
| `ALP_STATE_HOME` | Đổi machine state root |
| `ALP_MEMORY_ROOT` | Đổi riêng memory root |

Với lỗi parser hoặc policy, xem [Xử lý sự cố](../troubleshooting/).

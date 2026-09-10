---
title: Xử lý sự cố
description: Chẩn đoán các lỗi thường gặp khi chạy ALP, delegation, custom agent và continuity.
---

Các hướng dẫn dưới đây phản ánh stable `v0.11.0`. Command trên máy luôn kiểm theo bản đang cài bằng `alp --help`.

```bash
alp --version
alp doctor
```

Nguồn kiểm chứng chính: [`src/cli/`](https://github.com/phucanh08/alp-code/tree/v0.11.0/src/cli), [`src/agents/loader/`](https://github.com/phucanh08/alp-code/tree/v0.11.0/src/agents/loader) và [`src/policy/`](https://github.com/phucanh08/alp-code/tree/v0.11.0/src/policy).

## `main` chỉ đọc được project

**Triệu chứng:** Agent có thể phân tích nhưng không được sửa file.

**Nguyên nhân thường gặp:** cwd chưa đăng ký; ALP cố ý cho `main` read-only ở project lạ.

```bash
cd ~/code/my-app
alp init
alp
```

Kiểm output `READY` của init và bảo đảm mở phiên từ đúng project canonical.

## Runtime flag bị từ chối

**Triệu chứng:** CLI báo runtime không còn là lựa chọn hoặc option không biết.

**Cách xử lý:** Chọn mode; model trong mode quyết định runtime.

```bash
alp mode set medium
alp --mode high
```

Nếu máy chỉ có Codex CLI, thử `alp --mode puck`.

## Settings file bị từ chối

**Triệu chứng:** Lệnh dừng ngay với một thông báo có tên file, ví dụ `/Users/me/.alp/settings.json: modes.deep is not a mode` hoặc `... unknown key \`effort\``.

**Cách xử lý:** ALP đọc `~/.alp/settings.json`, `<project>/.alp/settings.json` và `<project>/.alp/settings.local.json`, và **không** lặng lẽ bỏ qua dòng sai — một loadout khác loadout bạn viết còn tệ hơn một lỗi. Kiểm trong khối `modes`:

- Tên mode phải là `low`, `medium`, `high`, `ultra`, `puck` hoặc `"*"`.
- Trong mỗi role chỉ có hai khoá: `model` và `reasoningEffort`.
- `model` phải là model ALP biết định tuyến (`claude-*` hoặc `gpt-*` có trong bảng runtime).
- `reasoningEffort` là một trong `low`, `medium`, `high`, `xhigh`, `max`, `ultra`.
- Một role có mặt thì phải khai ít nhất một trong hai trường; role chưa có trong loadout built-in (custom agent) phải khai cả hai.

Khoá ngoài `modes` không bị đụng tới — ALP không phải chủ duy nhất của file này.

```bash
alp mode show
```

## Runtime không có trên máy

**Triệu chứng:** Probe báo Claude Code hoặc Codex CLI không tìm thấy.

```bash
alp doctor
alp agent test main --tier 2 --mode medium
```

Cài CLI mà model yêu cầu hoặc chọn mode phù hợp. Tier 2 cho biết runtime được định tuyến tới đâu mà không spawn model.

## Delegation dừng trước khi launch

Kiểm lần lượt:

1. Có target role và task sau `--`.
2. `--timeout-ms` là số dương.
3. Caller có target trong `delegatesTo`.
4. `--project`/`--workspace` nằm trong scope được cấp.
5. Target agent load/trust thành công.

```bash
alp agent show search
alp agent test search
alp delegate search --project ~/code/my-app -- "Find the auth entrypoint"
```

Policy denial xảy ra trước runtime probe/spawn. Đừng sửa prompt để cố vượt quyền; sửa definition hoặc chọn đúng role/workspace.

## Background execution không cho kết quả

```bash
alp delegation status exec_abc123
alp delegation wait exec_abc123
```

Spawn thành công không đồng nghĩa task hoàn thành. Đọc terminal status và output; nếu không còn cần execution đang chạy, dùng `cancel`, sau đó chỉ `cleanup` khi không cần artifact để chẩn đoán nữa.

## Custom agent không xuất hiện hoặc không load

```bash
alp agent list --json
alp agent show migrator
alp agent test migrator --tier 1
```

Các nguyên nhân phổ biến:

- `.alp/agents/<id>/agent.yaml` thiếu hoặc directory khác `id`;
- YAML có key lạ, duplicate key, alias/anchor hoặc nhiều document;
- ID không kebab-case hoặc đụng built-in role;
- tool, model, memory/workspace grant vượt ceiling;
- skill thiếu `SKILL.md`, trỏ ra ngoài root hoặc qua nhiều symlink hop.

Loader trả toàn bộ issue tìm thấy; sửa theo report thay vì chỉ lỗi đầu tiên.

## `alp agent add` từ chối

`add` cần cả ba tier xanh, terminal thật và câu trả lời đúng `yes`. Không có auto-approve flag. Nếu definition đổi kể từ lần trust trước, đọc capability diff rồi duyệt lại:

```bash
alp agent test migrator
alp agent add migrator
```

ALP update có thể đổi house rules và làm definition hash lệch dù `agent.yaml` không đổi; đây vẫn là thay đổi prompt thực sự cần review.

## Context command không tìm thấy execution

Ngoài delegated session, truyền explicit ID:

```bash
alp context status exec_abc123
alp context validate exec_abc123
```

ID phải bắt đầu bằng `exec_`. ALP không đoán execution mới nhất.

## Context validation không xanh

Nguyên nhân có thể là checkpoint integrity/policy hash không khớp, journal có record lỗi hoặc replay không ổn định. Không tiếp tục dựa trên checkpoint đó như fact đã xác minh.

```bash
alp context status exec_abc123
alp context validate exec_abc123
```

Đọc warning, kiểm đúng execution ID và policy source. Pin quá dài, rỗng sau sanitize hoặc thiếu `-- <text>` cũng bị từ chối.

## Doctor báo finding

| Exit | Ý nghĩa | Hành động |
|---|---|---|
| `0` | Healthy | Không cần sửa |
| `1` | Có finding | Làm theo remediation được in |
| `2` | Doctor tự lỗi | Kiểm installation/state rồi chạy lại |

`--quiet` giảm output nhưng không đổi exit semantics:

```bash
alp doctor --quiet
```

:::danger[Đừng dùng purge như cách “sửa nhanh”]
`alp uninstall --purge-memory` xoá memory không có backup từ ALP. Một finding về runtime, trust hoặc context không phải lý do để purge dữ liệu.
:::

---
title: Xử lý sự cố
description: Chẩn đoán các lỗi thường gặp khi chạy ALP, delegation, custom agent và continuity.
---

Các hướng dẫn dưới đây phản ánh stable `v0.12.1`. Command trên máy luôn kiểm theo bản đang cài bằng `alp --help`.

```bash
alp --version
alp doctor
```

Nguồn kiểm chứng chính: [`src/cli/`](https://github.com/phucanh08/alp-code/tree/v0.12.1/src/cli), [`src/agents/loader/`](https://github.com/phucanh08/alp-code/tree/v0.12.1/src/agents/loader) và [`src/policy/`](https://github.com/phucanh08/alp-code/tree/v0.12.1/src/policy).

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

## `alp delegate` báo cần parent execution

**Triệu chứng:**

```text
delegation requires an authenticated parent execution; run it from inside an ALP session
```

**Nguyên nhân:** Từ bản kế tiếp `v0.12.1`, vai cha đến từ execution đang chạy chứ không từ biến môi trường, nên `alp delegate` gõ từ terminal trần không còn cha để đứng dưới.

**Cách xử lý:** Mở phiên rồi nhờ `main` giao việc.

```bash
cd ~/code/my-app
alp
```

Đừng tự đặt `ALP_EXECUTION_CAPABILITY` hay ba biến binding còn lại: chúng là danh tính của một execution ALP cấp, không phải cấu hình, và một capability không khớp chỉ đổi lỗi thành `CAPABILITY_INVALID`.

## Giao việc bị từ chối vì chạm trần

**Triệu chứng:** `DEPTH_LIMIT_EXCEEDED`, `CHILD_LIMIT_EXCEEDED`, `CONCURRENCY_LIMIT_EXCEEDED`, `GRAPH_CONCURRENCY_LIMIT_EXCEEDED`, `DELEGATION_LIMIT_EXCEEDED` hoặc `WALL_CLOCK_EXCEEDED`.

```bash
alp delegation tree exec_abc123
```

Đọc bốn dòng header: allowance đã dùng/còn lại, số node đang sống, số chỗ đã giữ, và trần. Đó gần như luôn là câu trả lời cho "vì sao nó không giao thêm việc nữa".

- Trần là **cố định**, không có khoá config nào mở được. Sửa trần là sửa code.
- Hết allowance (`8` lượt) hoặc quá hạn (2 giờ): mở phiên mới. Hạn của phiên là mốc tuyệt đối, không gia hạn.
- Chạm trần đồng thời: đợi execution đang chạy xong, hoặc `alp delegation cancel <id>` cái không còn cần.
- `slot(s) held` lớn hơn 0 mà không thấy node tương ứng là chuyện bình thường trong vài giây: một chỗ đã giữ mà process chưa kịp sinh ra. Reservation tự hết hạn sau 2 phút và được quét ở lần giao việc sau.

## Cây execution hỏng hoặc bị khoá

**Triệu chứng:** `EXECUTION_GRAPH_CORRUPT`, `EXECUTION_GRAPH_INVALID` hoặc `EXECUTION_GRAPH_LOCK_TIMEOUT` từ `tree`/`status`/`wait`/`cancel`/`cleanup`.

ALP **không** lặng lẽ trả lời bằng record cũ khi cây hỏng: một fallback che lỗi cây là cách một cây hỏng trở thành một cây vô hình. Lệnh lỗi, và đó là chủ ý.

```bash
alp doctor
ls ~/.alp/execution-graphs/
```

- **`LOCK_TIMEOUT`**: một process khác đang giữ lease. Đợi vài giây rồi chạy lại. Còn kẹt thì tìm process `alp` còn sống (`ps`), vì lease thuộc về nó.
- **`CORRUPT`/`INVALID`**: file `~/.alp/execution-graphs/<graph-id>.json` không parse được hoặc không thoả invariant — thường là đĩa đầy hoặc máy tắt giữa lúc ghi. Phiên đó không cứu được: kiểm không còn process nào của nó (`alp doctor` báo `ORPHAN-EXECUTION`), dọn process còn sót, rồi chuyển file hỏng đi chỗ khác và mở phiên mới.

```bash
mv ~/.alp/execution-graphs/exec_abc123.json /tmp/
```

Đừng sửa tay file cây để "cấp thêm chỗ": revision và invariant được kiểm lúc đọc, nên một file sửa tay chỉ đổi lỗi này thành lỗi khác.

## Execution cũ không tra được nữa

**Triệu chứng:** `alp delegation tree exec_...` trả `EXECUTION_NOT_FOUND` trong khi `status` vẫn trả lời.

Đó là một execution tạo **trước** execution graph. `status`/`wait`/`cancel`/`cleanup` vẫn đọc được nó từ record cũ; `tree` thì không, vì vẽ một cây một node cho nó là bịa ra một cây chưa từng tồn tại.

```bash
alp delegation status exec_abc123
alp delegation cleanup exec_abc123
```

Record cũ chỉ còn được đọc — không execution mới nào ghi vào đó nữa. Dọn dần bằng `cleanup`, và khi chắc không còn gì cần tra thì xoá `code-native-executions.json` trong delegation state dir.

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

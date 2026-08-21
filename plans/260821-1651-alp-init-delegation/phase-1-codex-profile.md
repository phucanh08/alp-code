# P1 — Codex profile từ loadout

> ~0.5 ngày · phụ thuộc P0
>
> **Trạng thái: XONG (2026-08-21).** Kết quả đo thật ở mục "Đã làm gì" cuối file —
> ba chỗ tiền đề của plan sai, đọc trước khi làm P2/P3.

## Mục tiêu

`loadout.yaml` → `~/.codex/<role>.config.toml`. Sau đó chạy một vai chỉ còn:

```bash
codex exec -p search -C /path/to/project < /dev/null "<task>"
```

Không flag model, không flag sandbox, không nhồi prompt boot.

## Bằng chứng (đã đo, codex v0.149.0)

Profile `~/.codex/alptest.config.toml` chứa 4 field → `codex exec -p alptest` in ra:

```
model: definitely-not-a-real-model-xyz     ← profile
approval: never                            ← profile
sandbox: read-only                         ← profile
reasoning effort: low                      ← profile
```

**Toàn bộ loadout nhét vừa vào profile.**

## Việc

### 1.1 `scripts/lib/codex-profile.cjs` (module mới)

`buildProfile(loadout, role, repoRoot) -> string` (TOML).

| Field | Nguồn | Ghi chú |
|---|---|---|
| `model` | `loadout.model` | |
| `model_reasoning_effort` | `loadout.reasoning_effort` | bỏ qua nếu không khai |
| `sandbox_mode` | `"read-only"` mọi vai phụ; `"workspace-write"` cho `main` | **BẪY 2** — mặc định của `exec` là `workspace-write` |
| `approval_policy` | `"never"` | |
| `tools.web_search` | `true` chỉ cho `librarian` | thay `--search` |
| `[hooks]` | `SessionStart` → `hooks/session-start.cjs`, `PreToolUse` → `hooks/acl-guard.cjs` | path tuyệt đối |

`ALP_ROLE=<role>` phải tới được hook. Codex không có `env` như Claude settings ⇒ nhúng vào
`command` của hook: `ALP_ROLE=<role> node <repo>/hooks/session-start.cjs`.

**Wire format Codex = camelCase** (`hookSpecificOutput`/`additionalContext`) — trùng Claude Code.
Nhưng schema có `deny_unknown_fields`: `session-start.cjs` xuất thêm `systemMessage`.
**Phải test.** Bị reject → viết adapter mỏng, **không fork hook**.

### 1.2 `compile-acl.cjs` sinh thêm profile

Sinh `~/.codex/<role>.config.toml` cho **mọi** vai. `--check` so sánh, exit 1 nếu lệch.

Ghi vào `$CODEX_HOME` nếu có, mặc định `~/.codex`.

### 1.3 `run-role.cjs --exec`

```js
const args = ["exec", "-p", role, "-C", cwd, "--skip-git-repo-check", prompt];
spawnSync("codex", args, { stdio: ["ignore", "pipe", "pipe"] });   // BẪY 1
```

- **BẪY 1:** stdin phải là `ignore`/`/dev/null`. Không thì treo vô hạn ở
  `Reading additional input from stdin...` (đã dính 120s khi test).
- **Xoá `buildBoot()`** (`run-role.cjs:74-86`) — profile + hook lo. DRY: 3 chỗ → 1.
- **Giữ `wrapDelegatedPrompt`** — contract main-only không nằm trong loadout.
- Giữ chế độ tương tác cũ làm mặc định; `--exec` là opt-in.

### 1.4 Test

- `scripts/test-codex-profile.cjs` (mới): loadout → TOML đúng field; `main` được
  `workspace-write`, vai phụ `read-only`; chỉ librarian có `web_search`.
- `test-loadout-models.cjs`: mở rộng phủ profile.
- Manual: `node scripts/run-role.cjs read-thread --exec -- "liệt kê file trong memory/shared"`
  → trả text, không treo, không ghi được file.

## Định nghĩa hoàn thành

- [x] `codex exec -p <role>` áp đúng model + effort + `read-only` + `approval never`
- [x] `run-role --exec` trả text về stdout, không treo
- [x] `buildBoot()` đã xoá; boot chỉ còn ở hook
- [x] hook `SessionStart` chạy được trên Codex — **không cần adapter**, `systemMessage` lọt
- [x] `compile-acl.cjs --check` phát hiện profile lệch **lẫn profile chưa sinh**

---

## Đã làm gì — và ba chỗ plan đoán sai

Đo trên `codex-cli 0.149.0`. Mọi kết luận dưới đây đều từ chạy thật, không từ đọc source.

### Sai 1: `[hooks]` cắm vào là chạy

Chạy được, nhưng **hook bị trust-gate**: profile chưa qua duyệt thì Codex **BỎ QUA hook,
im lặng** — không lỗi, không cảnh báo, phiên vẫn "thành công". Mất bốn lượt thử mới thấy,
vì mọi dấu hiệu bên ngoài đều giống hệt lúc hook chạy.

Chốt (principal duyệt): `run-role --exec` luôn kèm `--dangerously-bypass-hook-trust`.
Bề mặt rủi ro là các profile do chính `compile-acl` sinh ra.

Hình dạng đúng — PascalCase, array-of-tables, hook thật nằm trong array **con**:

```toml
[[hooks.SessionStart]]

[[hooks.SessionStart.hooks]]
type = "command"
command = "ALP_ROLE=search node '/repo/hooks/session-start.cjs'"
```

Wire format trùng Claude Code cả hai chiều (`tool_name`/`tool_input` vào,
`hookSpecificOutput`/`additionalContext` ra). `systemMessage` **không** bị từ chối —
lo `deny_unknown_fields` là lo thừa, không cần adapter. `command` chạy qua shell nên
`ALP_ROLE=` đứng trước là đủ.

### Sai 2: "`main` được `workspace-write` trong profile"

Làm thế là bake quyền ghi vào DANH TÍNH. Nhưng quyền ghi phụ thuộc **cwd của từng lần chạy**
(P0 đã học): main ở repo lạ vẫn phải read-only. Profile thì tĩnh, không biết cwd.

Chốt: profile pin `read-only` cho **mọi** vai, kể cả main. `run-role` nâng bằng
`-s workspace-write` đúng lần chạy được phép, dùng lại `isInside()` như P0 dặn.
Cờ CLI thắng profile — đã đo. Hỏng thì hỏng đóng.

### Sai 3: "thiếu profile thì `codex -p` báo lỗi"

Không. `codex -p ten-khong-co-that` chạy tiếp **im lặng** với config mặc định — và mặc định
của `exec` là `workspace-write`. Đây là BẪY 2 hiện nguyên hình ở dạng tệ hơn: không phải quên
khai sandbox, mà là quên chạy `compile-acl.sh`.

Ba lớp chặn: `run-role` từ chối chạy khi thiếu profile · `compile-acl --check` báo
`PROFILE-MISSING`/`PROFILE-DRIFT` · `doctor.sh` báo `CODEX-PROFILE`.

### Ăn theo

- `codex exec` 0.149 **bỏ cờ `-a`** — approval phải nằm trong profile. Lệnh cũ đã hỏng sẵn.
- `ALP_ROLE` nay là đường lấy danh tính CHÍNH của cả hai hook (`sessionIdentity()`),
  cwd chỉ còn là fallback. Trước đó `acl-guard` thấy cwd ngoài repo là **buông**, nên
  phiên delegation ở repo người khác không có ACL. Ba ca mới trong `test-isolation.cjs`
  khoá lại; đã mutation-test cả bảy bất biến mới (phá logic → test đỏ).
- Nợ P0 đã trả: `codex_model` vào `KNOWN_KEYS`, và khoá lạ trong loadout nay là **lỗi**
  (`codex_modl:` từng rơi về `model:` mà không kêu một tiếng).
- Xoá `codex-role.reasoningArgs()` — profile mang effort, hàm này thành code chết.

### File đã đụng

`scripts/lib/codex-profile.cjs` (mới) · `scripts/lib/loadout.cjs` · `scripts/lib/codex-role.cjs` ·
`scripts/compile-acl.cjs` · `scripts/run-role.cjs` · `scripts/doctor.cjs` ·
`hooks/session-start.cjs` · `hooks/acl-guard.cjs` · `scripts/test-codex-profile.cjs` (mới) ·
`test-isolation.cjs` · `test-agent-routing.cjs` · `test-loadout-models.cjs` ·
`test-codex-role.cjs` · `README.md` · `docs/model-routing.md`

### Còn nợ

- **Windows:** `command` của hook dùng cú pháp shell POSIX (`ALP_ROLE=x node '...'`).
  Codex có field `commandWindows` cho đúng việc này — làm ở P2 cùng phần parity Windows.
- `compile-acl.sh` nay ghi ra **ngoài repo** (`$CODEX_HOME`). P2 làm `alp init` cần nhớ:
  gỡ cài phải xoá cả profile, không chỉ file trong project.
- Hook `Stop`/`SessionEnd` chưa nối cho Codex (Claude có `session-end.cjs`). Chưa đo.

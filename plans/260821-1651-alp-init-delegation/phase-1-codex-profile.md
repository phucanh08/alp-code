# P1 — Codex profile từ loadout

> ~0.5 ngày · phụ thuộc P0

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

- [ ] `codex exec -p search` áp đúng model + effort + `read-only` + `approval never`
- [ ] `run-role --exec` trả text về stdout, không treo
- [ ] `buildBoot()` đã xoá; boot chỉ còn ở hook
- [ ] hook `SessionStart` chạy được trên Codex (hoặc adapter đã có nếu bị `deny_unknown_fields`)
- [ ] `compile-acl.cjs --check` phát hiện profile lệch

---
status: in-progress
created: 2026-09-18
slug: execution-relay
source: plans/260918-0700-execution-relay/research/alp-inside-sandbox.md
blockedBy: []
blocks: [plans/260912-0749-governance-loop/plan.md#gate]
---

# Execution relay — `alp` trong sandbox giao việc qua process root

## Bối cảnh

Chạy thật `RUNBOOK.md` 2026-09-18 trên cả Claude lẫn Codex: `main` gõ `alp delegate worker …`
và không giao được việc nào. Nguyên nhân gần là `ensureState()` ghi `~/.alp/install.json` trong
sandbox read-only; nguyên nhân xa là **kiến trúc**: process `alp` chạy *trong* sandbox không thể
là process thi hành delegation (cần ghi state ALP, cần spawn worker không thừa kế sandbox của
cha). Đo đạc đầy đủ và lý do loại từng phương án: [research](./research/alp-inside-sandbox.md).

## Quyết định (ADR)

**Process root `alp` là process duy nhất thi hành lệnh ALP thay cho một execution.** `alp`
trong sandbox chỉ là *client*: viết một request vào `<execution>/relay/`, đợi response. Root
thi hành với **binding của execution mà ALP gắn lúc đăng ký thư mục** — không đọc từ request.

| # | Quyết định | Vì sao |
|---|---|---|
| 1 | Kênh = file trong `<execution>/relay/` (tmp + rename) | Kênh duy nhất cả hai runtime cho phép từ trong sandbox (unix socket EPERM cả hai; `excludedCommands` rò rỉ `&&`/`;`; Codex không escalate được dưới `approval_policy=never`) |
| 2 | Client không chạy `ensureState`, không load full CLI | Trong sandbox không có quyền ghi `~/.alp`; và không có lý do để `alp` trong execution tự làm gì in-process ngoài `hook`/`__internal`/`--version` |
| 3 | Server = subprocess `layout.stableCommand <argv>` do root spawn, env = env của root ⊕ launch env của execution, **bỏ** `ALP_RELAY_DIR` | Không thay đổi semantics của `alp delegate`/`alp delegation`/`alp context` (cùng code path như gõ từ terminal); không phải luồn `env` qua 19 chỗ `process.env` trong `alp.ts`; stdio pipe nên không dính TTY của phiên interactive |
| 4 | Allowlist **server-side**, fail-closed: `delegate`, `delegation *`, `context *`, `--version`, `help` | Đúng bằng những gì session context bảo vai gõ (`render-session-context.ts`, `agents/main.ts`, `skills/delegation`). Mọi thứ khác exit 2 với lỗi rõ |
| 5 | Binding = của thư mục, không của request | Request là input untrusted từ model; nếu tin `argv`/env trong request thì child A có thể mượn binding của root |
| 6 | Codex: sandbox đi bằng `-c default_permissions="alp"` + `-c permissions.alp.filesystem={…}` trên argv, cho cả delegated lẫn interactive; bỏ `--dangerously-bypass-approvals-and-sandbox` | `codex-config.toml` mà adapter viết **không được Codex đọc** (bug có sẵn: writeScope/rules/approval chưa từng bind). Profile thắng `sandbox_mode`, phân cấp, chặn tạo entry cạnh scope — đo trên 0.154.0 |
| 7 | Claude: `sandbox.filesystem.allowWrite: [<execution>/relay]` cho mọi launch có sandbox | `denyWrite` thắng `allowWrite` nhưng relay dir nằm ngoài workspace nên không đụng scope |

**Ngoài phạm vi:** relay cho lệnh không có trong allowlist; streaming stdout; huỷ request đang
chạy (client hết deadline thì bỏ đi, subprocess vẫn chạy tới khi xong — settle như thường);
relay cho execution không do root này spawn.

## Bất biến giữ nguyên

Fail-closed (không có `server.json`/pid chết/hết deadline ⇒ lỗi, không im lặng); ALP quyết
(policy không đọc request); Thread ≠ Execution ≠ Graph ≠ Process (relay dir sống cùng execution
dir, đóng khi execution settle); không thư mục mới (`src/execution/relay-*.ts`,
`src/cli/relay-client.ts`).

## Giao thức v1

```
<execution>/relay/server.json            { v:1, pid, executionId, registeredAt }
<execution>/relay/<id>.request.json      { v:1, id, argv: string[], cwd, requestedAt }
<execution>/relay/<id>.response.json     { v:1, id, exitCode, stdout, stderr, finishedAt }
```

`id` = 32 hex do client sinh. Cả hai phía ghi `*.tmp` rồi `rename`. Client poll 50 ms → 500 ms
(backoff), mỗi vòng kiểm `kill(pid, 0)` và `ALP_EXECUTION_DEADLINE_AT`. Server poll thư mục
150 ms (timer unref), xử lý request song song, xoá request sau khi ghi response.

## Phase

| Phase | Nội dung | Test (oracle) |
|---|---|---|
| R1 | Giao thức + client (`src/cli/relay-client.ts`) + gating trong `dispatchEntry` (`ALP_RELAY_DIR` ⇒ relay, không `ensureState`, không full CLI; `--version`/`hook`/`__internal` giữ nguyên) | `test/cli/entry.test.ts`, `test/cli/relay-client.test.ts` — oracle: giao thức ở trên + fail-closed |
| R2 | Server (`src/execution/relay-server.ts`): `register`, allowlist, executor spawn `stableCommand`, `relay` dir trong `executionArtifactPaths` + store | `test/execution/relay-server.test.ts` — oracle: allowlist từ session context; env ⊕ rule; response contract |
| R3 | Nối vào `runThreadRoot` (root) và `DelegationService` (child): đăng ký lúc spawn, đóng lúc settle; `ALP_RELAY_DIR` vào launch env | `test/e2e/relay.test.ts` — fake runtime viết request theo giao thức, root phục vụ với binding của root |
| R4 | Claude `allowWrite`; Codex profile argv + bỏ bypass; `capabilities.ts` (measuredAt 2026-09-18) | `test/runtime/runtime-adapters.test.ts` — oracle: settings/argv contract đo trong research |
| R5 | Docs (`docs/delegation.md`, `docs/architecture.md`), gate của governance-loop, `npm run build`, chạy lại RUNBOOK trên cả hai runtime | `check.sh` trên alp-usage-probe |

## Tiến độ

| Phase | Commit | Ghi chú |
|---|---|---|
| R1 | `2112f7e` | Client + gating; mutant M1–M5 bị bắt |
| R2 | `c8d859f`, `217633f` | Server, allowlist, `relay/` 0700 trong artifact; mutant S1–S7 bị bắt |
| R3 | `39cb2b8` | Root + child foreground được phục vụ với binding của chính nó; 8 mutant bị bắt |
| R4 | `ac25081` | Claude `allowWrite` relay dir; Codex profile `default_permissions="alp"` trên argv, bỏ `-s` và bypass; `capabilities.ts` đo lại 2026-09-18; 8 mutant bị bắt |
| R5 | (đang) | Docs xong (`docs/delegation.md` § relay, `docs/architecture.md` §3.1/3.2/4.6/4.7/6); `npm run build`; smoke thật 2026-09-18: `codex sandbox` + profile ALP → `alp help` relay về root ok, `alp thread show` exit 2, `--version` in-process; còn nợ RUNBOOK trên hai runtime + gate/README |

### Ngoài phạm vi (ghi lại khi làm R3)

- Con `--background` không được đăng ký relay: process gọi `alp delegate --background` thoát
  ngay, không còn ai để trả lời. `alp` trong con đó fail-closed ("no ALP process is serving").
  Delegation lồng từ một con background sẽ cần supervisor phục vụ relay — chưa làm.
- Bản dev không có supervisor chạy được trong vitest, nên "không đăng ký background" chứng
  minh ở unit (`delegation-service.test.ts`), "không server.json ⇒ fail-closed" ở
  `relay-client.test.ts`; e2e chỉ chạy con foreground.

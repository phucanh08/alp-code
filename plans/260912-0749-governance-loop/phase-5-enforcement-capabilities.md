# P5 — Runtime enforcement capabilities

**Mục tiêu:** biến `enforcementNotes` (text) thành dữ liệu có `measuredOn`; `policy.json` ghi enforcement đã dựa vào; `alp agent test` tầng 2 phát hiện drift.
**Phụ thuộc:** P2 (bảng tối thiểu đã tạo). Nên trước P3/P6 vì hai phase đó đọc `policy.enforcement` — nếu làm sau, evaluator P3 tạm coi mọi mức là `declared-only`.

---

## Bối cảnh

- `enforcementNotes` viết tay ở `src/runtime/permission-rules.ts`, hiển thị qua `src/agent-test/tier2.ts` (`alp agent test`, `alp agent add`).
- Số liệu đã đo 2026-09-10: Codex **không** cưỡng chế tool grant và read isolation; cưỡng chế write + egress. Claude: sandbox darwin/linux; Windows không sandbox (`claude-adapter.ts:57-64`).
- `alp doctor` (`src/install/doctor.ts`) là chỗ in trạng thái máy.

## Thiết kế

### Contract

```ts
// src/runtime/capabilities.ts (mở rộng bản tối thiểu của P2)
export type EnforcementLevel = "enforced" | "declared-only" | "none";
export interface RuntimeEnforcementCapabilitiesV1 {
  readonly version: 1;
  readonly runtime: RuntimeId;
  readonly measuredOn: { readonly platform: NodeJS.Platform; readonly runtimeVersion: string;
                         readonly measuredAt: string };
  readonly toolGrant: EnforcementLevel;
  readonly readIsolation: EnforcementLevel;
  readonly writeIsolation: EnforcementLevel;
  readonly writeScope: EnforcementLevel;
  readonly networkEgress: EnforcementLevel;
  readonly nativeDelegationDeny: EnforcementLevel;
}
// ExecutionPolicy — vào policyHash
readonly enforcement: RuntimeEnforcementCapabilitiesV1;
```

### Bảng built-in theo `(runtime, platform)`

| | toolGrant | readIsolation | writeIsolation | writeScope | networkEgress | nativeDelegationDeny |
|---|---|---|---|---|---|---|
| codex · darwin/linux | declared-only | none | enforced | enforced | enforced | enforced (`[[rules]]`) |
| codex · win32 | declared-only | none | *đo* | *đo* | *đo* | enforced |
| claude · darwin/linux | enforced (permissions) | enforced | enforced (sandbox) | *P2 đo* | declared-only | enforced (`deny Task/Agent`) |
| claude · win32 | enforced | declared-only | none | declared-only | declared-only | enforced |

Ô *đo* = phải đo trước khi merge; chưa đo ⇒ `none` (fail-closed).

### Version lệch

Tại launch, adapter so `runtimeVersion` thật (`claude --version` / `codex --version`, cache theo path binary) với `measuredOn.runtimeVersion`. Lệch ⇒ **vẫn chạy**, `policy.enforcement` ghi bảng như cũ, `<execution>/runtime/launch.json` (P7) ghi version thật; evaluator P3 hạ provenance một bậc; `alp doctor` cảnh báo. Không chặn vì chặn = ALP chết mỗi lần CLI update.

### `enforcementNotes` sinh từ bảng

`describeEnforcement(capabilities): string[]` thay cho text viết tay; `tier2.ts` dùng hàm này.

### `alp agent test` tầng 2

Probe thật cho từng dòng có thể probe (ghi file ngoài scope, gọi tool không grant, đọc private memory role khác, `Task`), so với bảng ⇒ `OK | DRIFT(<field>: bảng nói X, đo thấy Y)`. `DRIFT` ⇒ exit code ≠ 0.

## Việc phải làm

1. Test fail trước: bảng có đủ mọi `(runtime, platform)`; `policyHash` đổi khi enforcement đổi; ô chưa đo ⇒ `none`; `describeEnforcement` khớp notes cũ (snapshot test để không mất thông tin); tier 2 với fake binary giả lập drift ⇒ `DRIFT`.
2. `src/runtime/capabilities.ts`: bảng đầy đủ, `capabilitiesFor(runtime, platform)`, `describeEnforcement`.
3. `src/execution/types.ts`, `execution-policy.ts`: `enforcement`; cutover reader.
4. `src/runtime/permission-rules.ts`: xoá notes viết tay; `src/agent-test/tier2.ts`: probe + so bảng.
5. `src/runtime/{claude,codex}-adapter.ts`: đọc version thật (cache), truyền cho P7.
6. `src/install/doctor.ts`: in bảng + cảnh báo lệch version.

## File đụng tới

| File | Hành động | Đổi gì |
|---|---|---|
| `src/runtime/capabilities.ts` | sửa | bảng đầy đủ |
| `src/execution/types.ts`, `execution-policy.ts` | sửa | `enforcement` |
| `src/runtime/permission-rules.ts`, `src/agent-test/tier2.ts` | sửa | notes sinh, probe |
| `src/runtime/*-adapter.ts`, `src/install/doctor.ts` | sửa | version, doctor |
| `test/runtime/capabilities.test.ts`, `test/agent-test/tier2-drift.test.ts` | tạo | |
| `docs/delegation.md` | sửa | bảng enforcement |

## Rủi ro

| Failure mode | Giảm thiểu |
|---|---|
| `--version` chậm/treo | Timeout 2s, cache theo binary path + mtime; fail ⇒ `runtimeVersion: "unknown"` ⇒ coi là lệch |
| Bảng "đúng" nhưng máy user khác | Tier 2 probe thật là nguồn cuối; `DRIFT` là tín hiệu, không phải bug ALP |
| Snapshot cũ thiếu `enforcement` | Reader: thiếu ⇒ `enforcement: null`-tương-đương cho hiển thị; evaluator coi `declared-only` |

## Tiêu chí hoàn thành

- `npx vitest run test/runtime test/agent-test test/cutover` xanh.
- `alp agent test` trên darwin với Claude + Codex thật: không `DRIFT`.
- `policy.json` có `enforcement`; `alp doctor` in bảng.
- `npm test` xanh.

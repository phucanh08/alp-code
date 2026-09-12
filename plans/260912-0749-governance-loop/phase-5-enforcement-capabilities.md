# P5 — Runtime enforcement capabilities + launch receipt

<!-- Sửa: rà đối kháng + kiểm chứng lượt 2 (2026-09-12) — gộp P7 launch provenance vào đây; measuredOn chỉ cho enforcement, transcript dùng pinned version của bridge -->

**Mục tiêu:** biến `enforcementNotes` (text) thành dữ liệu có `measuredOn`; `policy.json` ghi enforcement đã dựa vào; mỗi process có receipt version/auth thật lúc phóng; `alp agent test` tầng 2 phát hiện drift.
**Phụ thuộc:** P2 (bảng tối thiểu đã tạo). Nên trước P3/P6 vì hai phase đó đọc `policy.enforcement` và `launch.json`.

---

## Bối cảnh

- `enforcementNotes` viết tay ở `src/runtime/permission-rules.ts`, hiển thị qua `src/agent-test/tier2.ts`.
- Số liệu đã đo 2026-09-10: Codex **không** cưỡng chế tool grant và read isolation; cưỡng chế write + egress. Claude: sandbox darwin/linux; Windows không sandbox (`claude-adapter.ts:57-64`).
- Bridge đã có `pinnedVersion` + `completenessForVersion` (`src/runtime/codex-history-bridge.ts:3,52,75`, `history-bridge-shared.ts`) cho *định dạng transcript* — **không** dựng `measuredOn` thứ hai cho việc đó; `measuredOn` ở đây chỉ cho *enforcement*.
- `RuntimeLaunchSpec` freeze khi rời `prepare()`; `src/backend/local-process-backend.ts` spawn. `runtime/` bị dọn sau execution; `context/` sống (`execution/types.ts:164`).
- `alp doctor` (`src/install/doctor.ts`) không biết runtime version/auth.

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

// src/runtime/launch-provenance.ts — KHÔNG vào policyHash (sự kiện, không phải quyết định)
export interface LaunchProvenanceV1 {
  readonly version: 1;
  readonly executionId: string;
  readonly runtime: RuntimeId; readonly runtimeVersion: string;   // "unknown" khi không lấy được
  readonly platform: NodeJS.Platform;
  readonly authMethod: "oauth" | "api-key" | "unknown";           // chỉ kiểm tồn tại env/file, không đọc giá trị
  readonly credentialConfigured: boolean;
  readonly launchSpecDigest: string;   // sha256 canonical(spec) — env chỉ lấy **tên** biến
  readonly launchedAt: string;
}
```

### Bảng built-in theo `(runtime, platform)`

| | toolGrant | readIsolation | writeIsolation | writeScope | networkEgress | nativeDelegationDeny |
|---|---|---|---|---|---|---|
| codex · darwin/linux | declared-only | none | enforced | enforced | enforced | enforced (`[[rules]]`) |
| codex · win32 | declared-only | none | *đo* | *đo* | *đo* | enforced |
| claude · darwin/linux | enforced (permissions) | enforced | enforced (sandbox) | *P2 đo* | declared-only | enforced (`deny Task/Agent`) |
| claude · win32 | enforced | declared-only | none | declared-only | declared-only | enforced |

Ô *đo* = phải đo trước khi merge; chưa đo ⇒ `none` (fail-closed).

### Launch receipt

Backend ghi `<execution>/context/launch.json` (trong `context/`, không phải `runtime/`, để sống qua cleanup) ngay trước `spawn`. `runtimeVersion` từ `claude --version` / `codex --version`, timeout 2s, cache theo binary path + mtime; fail ⇒ `"unknown"`. `authMethod`: Claude — `ANTHROPIC_API_KEY` ⇒ `api-key`, credentials file OAuth tồn tại ⇒ `oauth`; Codex — `OPENAI_API_KEY` ⇒ `api-key`, `~/.codex/auth.json` ⇒ `oauth`.

### Version lệch

`launch.json.runtimeVersion ≠ policy.enforcement.measuredOn.runtimeVersion` (hoặc `"unknown"`) ⇒ **vẫn chạy**; evaluator P3 hạ provenance một bậc; `alp doctor` cảnh báo "capability chưa đo lại cho version này". Không chặn vì chặn = ALP chết mỗi lần CLI update.

### `enforcementNotes` sinh từ bảng

`describeEnforcement(capabilities): string[]` thay text viết tay; `tier2.ts` dùng hàm này.

### `alp agent test` tầng 2

Probe thật cho từng dòng probe được (ghi file ngoài scope, ghi vào executions root, gọi tool không grant, đọc private memory role khác, `Task`), so với bảng ⇒ `OK | DRIFT(<field>: bảng nói X, đo thấy Y)`. `DRIFT` ⇒ exit code ≠ 0.

### Consumer

`alp doctor`: bảng + `authMethod`/`credentialConfigured` + cảnh báo lệch. `alp thread show`: runtime version từng E-n (từ `launch.json`). Evidence P3 `boundary` tham chiếu `launchSpecDigest`.

## Việc phải làm

1. Test fail trước: bảng đủ mọi `(runtime, platform)`; `policyHash` đổi khi enforcement đổi; ô chưa đo ⇒ `none`; `describeEnforcement` khớp notes cũ (snapshot test); tier 2 với fake binary giả lập drift ⇒ `DRIFT`; `launch.json` tồn tại cho root và child, digest ổn định, chuỗi secret giả không xuất hiện trong file; `authMethod` từ fixture env/fs; `--version` treo ⇒ `"unknown"` trong 2s.
2. `src/runtime/capabilities.ts`: bảng đầy đủ, `capabilitiesFor(runtime, platform)`, `describeEnforcement`.
3. `src/runtime/launch-provenance.ts`: contract, `detectAuthMethod`, `runtimeVersion` cache; `src/backend/local-process-backend.ts` ghi receipt trước spawn.
4. `src/execution/types.ts`, `execution-policy.ts`: `enforcement`; cutover reader (thiếu ⇒ hiển thị "chưa ghi", evaluator coi `declared-only`).
5. `src/runtime/permission-rules.ts`: xoá notes viết tay; `src/agent-test/tier2.ts`: probe + so bảng.
6. `src/install/doctor.ts`, `alp thread show`.

## File đụng tới

| File | Hành động | Đổi gì |
|---|---|---|
| `src/runtime/capabilities.ts` | sửa | bảng đầy đủ |
| `src/runtime/launch-provenance.ts` | tạo | receipt |
| `src/backend/local-process-backend.ts` | sửa | ghi receipt |
| `src/execution/types.ts`, `execution-policy.ts` | sửa | `enforcement` |
| `src/runtime/permission-rules.ts`, `src/agent-test/tier2.ts` | sửa | notes sinh, probe |
| `src/install/doctor.ts`, thread show | sửa | in |
| `test/runtime/capabilities.test.ts`, `test/runtime/launch-provenance.test.ts`, `test/agent-test/tier2-drift.test.ts`, `test/e2e/launch-provenance.test.ts` | tạo | |
| `docs/delegation.md` | sửa | bảng enforcement |

## Rủi ro

| Failure mode | Giảm thiểu |
|---|---|
| `--version` chậm/treo | Timeout 2s, cache; fail ⇒ `"unknown"` ⇒ coi là lệch |
| Bảng "đúng" nhưng máy user khác | Tier 2 probe thật là nguồn cuối; `DRIFT` là tín hiệu, không phải bug ALP |
| Digest vô tình chứa secret qua args | Spec không truyền secret qua args; test assert; env chỉ lấy tên |
| Snapshot cũ thiếu `enforcement` | Reader chấp nhận; evaluator coi `declared-only` |

## Tiêu chí hoàn thành

- `npx vitest run test/runtime test/agent-test test/cutover test/e2e/launch-provenance.test.ts` xanh.
- `alp agent test` trên darwin với Claude + Codex thật: không `DRIFT`.
- `policy.json` có `enforcement`; `context/launch.json` cho mọi execution; `alp doctor` in bảng + `authMethod` hai runtime.
- `npm test` xanh.

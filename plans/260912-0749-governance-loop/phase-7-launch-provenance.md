# P7 — Launch provenance

**Mục tiêu:** mỗi process có một receipt: CLI version nào, xác thực kiểu nào, spec digest gì.
**Phụ thuộc:** không (P5 dùng version thật — nếu P5 trước thì tái dùng cache version ở đây).

---

## Bối cảnh

- `RuntimeLaunchSpec` freeze khi rời `prepare()`; backend spawn (`src/backend/*`).
- `alp doctor` (`src/install/doctor.ts`) không biết runtime xác thực kiểu gì.
- Evidence `boundary` (P3) muốn tham chiếu "process nào đã sinh transcript này".

## Thiết kế

```ts
// src/runtime/launch-provenance.ts
export interface LaunchProvenanceV1 {
  readonly version: 1;
  readonly executionId: string;
  readonly runtime: RuntimeId; readonly runtimeVersion: string;   // "unknown" khi không lấy được
  readonly platform: NodeJS.Platform;
  readonly authMethod: "oauth" | "api-key" | "unknown";           // suy từ env/config, không đọc giá trị secret
  readonly credentialConfigured: boolean;
  readonly launchSpecDigest: string;   // sha256 canonical(spec) — env chỉ lấy **tên** biến, không giá trị
  readonly launchedAt: string;
}
```

- Ghi `<execution>/runtime/launch.json` ngay trước `spawn`, **sau** policy — không vào `policyHash` (là sự kiện, không phải quyết định). `runtime/` bị dọn sau execution ⇒ copy digest + version vào `context/` qua boundary (P3 item `boundary` thêm `launch: { runtimeVersion, launchSpecDigest }`, additive) để tồn tại lâu dài.
- `authMethod`: Claude — có `ANTHROPIC_API_KEY` ⇒ `api-key`, có credentials file OAuth ⇒ `oauth`; Codex — `OPENAI_API_KEY` ⇒ `api-key`, `~/.codex/auth.json` ⇒ `oauth`. Chỉ kiểm **tồn tại**, không đọc nội dung.

### Consumer

`alp doctor`: `authMethod`/`credentialConfigured` cho hai runtime. `alp thread show`: runtime version của từng E-n. Evidence boundary tham chiếu digest.

## Việc phải làm

1. Test fail trước: digest ổn định, không chứa giá trị env (assert chuỗi secret giả không xuất hiện trong file); `authMethod` từ fixture env/fs; file tồn tại cho root và child (E2E); boundary có `launch`.
2. `src/runtime/launch-provenance.ts`; backend local ghi file trước spawn.
3. `src/thread/history-types.ts` boundary `launch` (additive); `src/execution/evidence.ts` copy vào boundary item.
4. `src/install/doctor.ts`, `alp thread show`.

## File đụng tới

| File | Hành động | Đổi gì |
|---|---|---|
| `src/runtime/launch-provenance.ts` | tạo | |
| `src/backend/local-process-backend.ts` | sửa | ghi receipt trước spawn |
| `src/thread/history-types.ts`, `src/execution/evidence.ts` | sửa | boundary `launch` |
| `src/install/doctor.ts`, thread show | sửa | in |
| `test/runtime/launch-provenance.test.ts`, `test/e2e/launch-provenance.test.ts` | tạo | |

## Rủi ro

| Failure mode | Giảm thiểu |
|---|---|
| Digest vô tình chứa secret qua args (`--api-key …`) | Spec hiện không truyền secret qua args; test assert chuỗi giả không xuất hiện; env chỉ lấy tên |
| `runtime/` dọn mất receipt | Digest + version sống trong boundary ở `context/` |

## Tiêu chí hoàn thành

- `npx vitest run test/runtime test/e2e/launch-provenance.test.ts` xanh.
- Receipt cho mọi execution; `alp doctor` in `authMethod` cho hai runtime thật.
- `npm test` xanh.

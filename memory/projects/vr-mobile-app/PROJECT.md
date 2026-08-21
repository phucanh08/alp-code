---
slug: vr-mobile-app
name: DKVN — App đặt lịch đăng kiểm xe cơ giới
status: ACTIVE
priority: P1
summary: App Flutter cho dân đặt lịch đăng kiểm, tra hồ sơ, eKYC bằng CCCD gắn chip
path: ~/EpayProjects/vr-mobile-app
updated: 2026-08-19
---

# DKVN — vr-mobile-app

## Mục tiêu
App di động chính thức của Cục Đăng kiểm (`vn.gov.vr.app`) cho người dân: đặt lịch đăng kiểm,
quản lý phương tiện, hồ sơ miễn kiểm định, thanh toán phí, tra vi phạm — định danh bằng eKYC
đọc chip CCCD qua NFC. Do EPAY làm, tiếp nhận lại từ Skyline.

## Trạng thái hiện tại
Branch tích hợp là `dev` (không phải `main`). Nhánh release prod hiện tại
`chore/release-prod-0.0.4`, version `0.0.4+26081910`, đã push commit `e794a9a` ngày
2026-08-19. Stg gần nhất `1.0.0+24`.
**Commit cuối 2026-08-05.** 309 file Dart / ~51.6k LOC, 11 danh tính git.
2 plan (`dang-ky-xe-v2`, `auth-flow-v06`) đều đứng ở phase 5 QA, `status: in-progress` từ 23/07.
Mở lại 2026-08-17 theo lệnh principal — đang làm màn `signup_personal_id_card_page`
(nhập CCCD + họ tên) của luồng đăng ký cá nhân. Working tree có sẵn nhiều file dirty
(`ios/`, `main.dart`, `pubspec.yaml`, 2 file schedule) **không phải do Phở sửa**.

## Việc tiếp theo
1. Nối điểm vào cho `/signup/personal/id-card` — route đã có, chưa màn nào push tới.

Còn tồn từ phiên 2026-08-14, xếp theo thứ tự này:
1. Vá 3 lỗ P0 sửa được trong repo: secret hardcode, `DebugLoggingInterceptor` ở release,
   dev tool 20-tap. Không cần rewrite lịch sử.
2. Dọn 6 IPA tracked — **cần duyệt riêng**, phải `filter-repo`/BFG trên lịch sử chung 11 người.
3. Gỡ `docs/` + `plans/` khỏi `.gitignore` hoặc backup ra nơi khác.
4. Đóng phase 5 QA của 2 plan, hoặc hạ `status` của chúng cho đúng thực tế.

## Đang chặn
- Không phải blocker kỹ thuật — principal chưa cho đụng repo. Mọi việc trên chờ lệnh.

## Stack & lệnh
| | |
|---|---|
| Stack | Flutter (Dart), bloc + go_router + dio + signalr_netcore, freezed |
| Chạy | `flutter run --dart-define=MAPS_API_KEY=<key>` |
| Test | `flutter test` (8 file, ~662 dòng) · `flutter analyze` |
| Deploy | **Thủ công trên máy dev — không có CI/CD nào** |
| Env | Sửa tay `AppConfigs.env` trong `lib/main.dart` + `version` trong `pubspec.yaml` |

## Cạm bẫy đã biết
- **P0 — secret hardcode:** `config/app_configs.dart:65` `AnalyticsConfig.secretKey` là literal,
  dùng thật ở `analytics_repository.dart:21`; bản `String.fromEnvironment` bị comment ngay dưới.
- **P0 — log rò rỉ ở release:** `api_client.dart:27` add `DebugLoggingInterceptor` **ngoài**
  khối `kDebugMode`; nó ghi `Authorization: Bearer <JWT>` + body (password/OTP/CCCD) vào
  `DebugLogStore` — list tĩnh, `clear()` không call site nào.
- **P0 — dev tool trong bản release:** `home_header.dart:130,200` chạm 20 lần → `DevToolDialog`
  đổ toàn bộ `readAll()` của cả hai secure storage + log trên. Không có `kDebugMode`.
- **P0 — 6 IPA đã ký bị git track:** `ios/Runner 2026-06-*/` (18 file tracked, ~223 MB), kèm
  provisioning profile team `9MWNUFY2N6` (khác team hiện tại `TBTBA72U5V`).
- **Key Google/Firebase plaintext tracked** ở 5 chỗ; key Maps ≡ key Firebase ⇒ `--dart-define`
  chỉ là hình thức, có fallback hardcode ở `build.gradle.kts:61` và `inject_dart_defines.sh:8`.
- **`docs/` và `plans/` bị gitignore** (`.gitignore:56-57`) — ~2700 dòng contract API v0.6 và
  toàn bộ kế hoạch chỉ tồn tại trên một máy. Mất máy là mất hết.
- `signalRUrl` hardcode prod (`app_configs.dart:14`) — build dev/stg vẫn nối hub production.
- Token hết hạn bị `handler.resolve()` thành response thành công (`api_expir_interceptor.dart:19`).
- eKYC đang chạy `_sdk.debugReadCard()` với `secret: ''` (`ekyc_card_reader.dart:60`) — blocker
  phát hành thật, chờ credentials Epay cấp.
- Repo **không có** CLAUDE.md/AGENTS.md; `.gitignore:58` chặn `.claude/`. Agent làm việc ở đây
  phải nhận prompt tự đủ. Codex chưa trust path này trong `~/.codex/config.toml`.

## Tham chiếu
- Quét sâu 2026-08-14 (3 agent herdr): `refs/scan-260814.md`

# Changelog

Mọi thay đổi đáng chú ý của alp-code được ghi ở đây.

Định dạng theo [Keep a Changelog](https://keepachangelog.com/vi/1.1.0/); phiên bản theo
[Semantic Versioning](https://semver.org/lang/vi/). Mỗi mục `## [X.Y.Z]` tương ứng một tag
`vX.Y.Z` và một GitHub Release.

## [Chưa phát hành]

### Thêm

- `CODE_CRAFT_RULES` trong `src/agents/shared/house-rules.ts` — bốn quy tắc tay nghề phỏng theo
  [ghi chép của Andrej Karpathy](https://x.com/karpathy/status/2015883857489522876) về các lỗi
  code thường gặp của LLM: nêu giả định thay vì hành động theo nó, chọn lời giải nhỏ nhất, sửa
  đúng phạm vi được yêu cầu, biến task thành một check chạy được. Chỉ spread vào `main`,
  `review`, `oracle` là các vai viết hoặc phán xét code; `search`, `librarian`, `read-thread`,
  `compaction`, `titling` không nhận vì không hành động theo được.

## [0.1.2] - 2026-08-27

### Sửa

- `alp update` chạy được trở lại. Từ 0.1.0, `scripts/alp.cjs` gọi `updateInstallation` đồng bộ
  trong khi hàm này đã thành async, nên đọc `result.ok` trên một Promise luôn ra `undefined`:
  lệnh in `ERROR undefined`, thoát 1 và **không update gì cả**. Nay await đúng Promise, in cả
  tag vừa checkout. Thêm test chạy thật `alp.cjs update` để khoá hợp đồng async này.
- `alp help` không còn bảng hardcode riêng trong `alp.cjs` lệch với `helpText()` — nay hiện
  đủ, gồm `alp --version`.

## [0.1.1] - 2026-08-27

### Sửa

- `cut-release.cjs` bump cả `package-lock.json`, không chỉ `package.json`. Trước đó hai file
  lệch version sau mỗi lần cắt release mà `git status` vẫn sạch nên không có gì báo động.

### Gỡ

- Bỏ `.github/workflows/release.yml`. Release nay publish bằng `gh release create` từ máy
  maintainer. Workflow không chạy khi cắt `v0.1.0` vì nó vừa được thêm trong chính cú push
  mang tag, và với một maintainer dùng `gh` sẵn thì nó chỉ thêm một bộ phận async có thể im
  lặng hỏng. Bất biến `tag == package.json.version` vẫn do `cut-release.cjs` giữ lúc tạo tag.

## [0.1.0] - 2026-08-27

Bản release đánh số đầu tiên. Trước mốc này alp-code chưa có version, chưa có tag, và
`alp update` fast-forward thẳng nhánh `main`.

### Thêm

- Version là nguồn sự thật duy nhất trong `package.json`; `alp --version` / `alp -v` in
  phiên bản đang cài.
- Phát hành qua git tag + GitHub Release: `.github/workflows/release.yml` chạy trên tag
  `v*.*.*`, verify tag khớp `package.json.version` rồi publish release kèm auto-generated
  notes.
- Kiểm tra bản mới ở nền mỗi lần chạy `alp`: cache tại `~/.alp/update-check.json` với TTL
  24h, network chạy trong detached child process nên không bao giờ chặn lệnh hiện tại. Có
  bản mới thì chỉ in một dòng gợi ý `alp update` — không tự cập nhật, không hỏi lại. Đặt
  `ALP_SKIP_UPDATE_CHECK=1` để tắt.
- `scripts/checkout-release.cjs` — resolve và checkout tag release, dùng chung bởi
  installer và `alp update`.
- Ghim phiên bản khi cài: `--version <tag>` / `ALP_VERSION` (bash) và `$env:ALP_VERSION`
  (PowerShell).

### Thay đổi

- `alp update` và installer chuyển hẳn sang release-based: resolve tag GitHub Release mới
  nhất (`api.github.com/.../releases/latest`, fallback `git ls-remote --tags` khi API không
  tới được) rồi `git checkout --detach <tag>`, thay cho `git pull --ff-only` trên `main`.
  Guarantee cũ giữ nguyên: từ chối khi working tree còn thay đổi chưa commit, và backup/khôi
  phục `memory/`, runtime preference, backend preference quanh mỗi lần update.
- `--branch` / `ALP_BRANCH` không còn mặc định là `main`. Giờ đây nó là escape hatch tường
  minh cho dev: bỏ qua release resolution và theo dõi trực tiếp một nhánh (hành vi
  fast-forward pull như cũ).

### Nền tảng sẵn có tính đến 0.1.0

- Agent registry code-native (`main`, `search`, `librarian`, `read-thread`, `review`,
  `oracle`, `compaction`, `titling`) với `PolicyEngine` fail-closed trước mọi delegation,
  memory operation, workspace access và tool request.
- Hai runtime adapter Claude/Codex sinh launch spec; backend Herdr/Paseo chỉ quản lifecycle.
- `MemoryService`/`MemoryStore` storage-neutral với adapter Markdown và remote API.
- `alp init`/`alp deinit`, `alp delegate`, `alp doctor`, `alp uninstall`, installer một dòng
  cho macOS/Linux/WSL và Windows.

[Chưa phát hành]: https://github.com/phucanh08/alp-code/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/phucanh08/alp-code/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/phucanh08/alp-code/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/phucanh08/alp-code/releases/tag/v0.1.0

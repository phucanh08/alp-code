---
name: release
description: Cắt bản release cho alp-code — bump version, cập nhật CHANGELOG, tạo tag `vX.Y.Z` và publish GitHub Release. Kích hoạt khi principal yêu cầu "cắt release", "tag bản mới", "phát hành vX.Y.Z", hoặc hỏi về quy trình release/tag của repo.
---

# release — cắt bản phát hành

Skill này cần `Write`/`Edit` và `Bash` (kèm `gh` để xác minh). Execution policy không cấp đủ
thì chỉ đọc và đề xuất được kế hoạch release, không tạo tag.

**Phạm vi: chỉ repo alp-code.** Nó nói về `package.json`, `CHANGELOG.md` và `cut-release.cjs`
của chính repo này, nên nằm ở `.claude/skills/` (project scope) chứ không phải `skills/` —
`skills/` được ship cho mọi project qua `ALP_REPO_ROOT/skills`.
`.codex/skills/release` là symlink trỏ về đây; sửa bản ở `.claude/`, đừng tạo bản sao thứ hai.

## Cổng chặn — đọc trước mọi thứ khác

**Không tạo tag, không push tag, không publish release, trừ khi principal yêu cầu trong phiên
này.** Tag đã push và release đã publish là việc ra ngoài máy: người khác `alp update` về ngay
lập tức. Duyệt ở lần trước không tính cho lần này (HOUSE-RULES §1.2).

Hai việc **không bao giờ tự làm**, kể cả khi thấy sai:

| Việc | Vì sao |
|---|---|
| xoá / trỏ lại tag đã push | máy khác đã checkout tag đó; đổi nghĩa tag là đổi code dưới chân người dùng |
| sửa/xoá GitHub Release đã publish | release notes là bản ghi công khai |

Tag sai thì **cắt version mới** (`v0.1.1`), không sửa tag cũ. Báo principal, để họ quyết.

## Bất biến của repo

`tag vX.Y.Z` **phải** khớp `package.json.version` là `X.Y.Z` — `alp update` resolve tag rồi
checkout, nên tag lệch version nghĩa là máy người dùng báo sai bản đang chạy. `cut-release.cjs`
giữ bất biến này ngay lúc tạo tag (bump và tag cùng một commit, không tag commit chưa bump).

Không có ai verify lại phía server: repo cố ý **không** dùng GitHub Actions cho release. Với
một maintainer cắt release từ máy local, workflow chỉ thêm một bộ phận async có thể im lặng
không chạy — đã xảy ra ở `v0.1.0`. Đổi lại, tag tạo bằng tay ngoài `cut-release.cjs` sẽ không
được kiểm gì cả; đừng làm thế.

## Tiền điều kiện

Chạy hết, không bỏ bước nào:

```bash
git branch --show-current                 # phải là main
git status --porcelain                    # phải rỗng
git fetch origin --tags && git log --oneline -1 origin/main   # main local phải bằng origin
git tag -l                                # xem version gần nhất đã phát hành
gh auth status                            # publish release cần gh đã đăng nhập
npm run typecheck && npm run build && npm test
for f in scripts/test-*.cjs; do node "$f" || break; done
```

Bất kỳ bước nào đỏ → **DỪNG**, báo principal. Không release trên tree bẩn, không release khi
test đỏ, không release từ nhánh feature.

## Chọn số version

Từ version hiện tại trong `package.json`, theo SemVer:

| Bump | Khi |
|---|---|
| `PATCH` (0.1.0 → 0.1.1) | chỉ fix, không đổi hành vi công khai |
| `MINOR` (0.1.0 → 0.2.0) | thêm lệnh/flag/hành vi mới, tương thích ngược |
| `MAJOR` (0.1.0 → 1.0.0) | phá tương thích: bỏ lệnh, đổi nghĩa flag, đổi format state |

Đọc `git log <tag-gần-nhất>..HEAD --oneline` rồi đề xuất số cho principal kèm lý do. Principal
chốt số, không tự quyết MAJOR.

## Quy trình

### 1. Viết CHANGELOG trước

Mục `## [Chưa phát hành]` trong `CHANGELOG.md` phải mô tả xong thay đổi của bản này, nhóm
theo `### Thêm` / `### Thay đổi` / `### Sửa` / `### Gỡ`. Viết cho người dùng đọc, không phải
chép lại `git log`.

Mục rỗng là tín hiệu dừng, không phải chuyện nhỏ: không có gì để kể cho người dùng thì hỏi
principal xem có thật sự cần release không.

### 2. Bump version + đóng mục CHANGELOG + commit + tag

```bash
node scripts/cut-release.cjs <patch|minor|major|X.Y.Z> --dry-run   # xem trước
node scripts/cut-release.cjs <patch|minor|major|X.Y.Z>
```

Script làm đúng bốn việc và **dừng trước `git push`**: bump `package.json.version` (chỉ sửa
đúng dòng đó, giữ nguyên format), đổi `## [Chưa phát hành]` thành `## [X.Y.Z] - ngày` rồi mở
lại mục rỗng mới, nối link compare ở cuối file, và tạo commit `chore(release): vX.Y.Z` + tag.

Script tự chặn: tree bẩn, tag đã tồn tại, version không tăng, mục Chưa phát hành rỗng
(`--allow-empty` để vượt, chỉ dùng khi principal đồng ý). Cần tự tay commit thì thêm
`--no-commit` — script chỉ ghi file rồi in lệnh git cần chạy.

### 3. Push và publish — hỏi principal trước

```bash
git push origin main --tags
gh release create vX.Y.Z --generate-notes
```

Push commit và tag **cùng lúc**: tag trỏ vào commit mà `origin/main` chưa có thì release trỏ
vào lịch sử mà người khác chưa fetch được.

`gh release create` chạy tại máy nên biết kết quả ngay — nó in URL release. Không có bước
async nào để phải đi moi log.

### 4. Xác minh

```bash
gh release view vX.Y.Z --json tagName,isDraft,url
gh api repos/phucanh08/alp-code/releases/latest --jq .tag_name   # đúng cái alp update đọc
```

Release phải tồn tại, không phải draft, và `releases/latest` phải trả đúng tag vừa cắt — đây
mới là thứ `resolveLatestReleaseTag` dựa vào.

## Mẫu báo cáo về principal

```
✓ preflight: main sạch, đồng bộ origin, test xanh
✓ version:   0.1.0 → 0.2.0 (MINOR: thêm `alp --version`)
✓ changelog: [0.2.0] - 2026-08-27
✓ commit:    <hash> chore(release): v0.2.0
✗ tag/push:  CHƯA — chờ principal duyệt
```

Chưa push thì ghi rõ chưa push. Đã push thì dán link release.

## Xử lý lỗi

| Lỗi | Làm gì |
|---|---|
| tag `vX.Y.Z` đã tồn tại | DỪNG. Không `-f`. Báo principal, đề xuất số kế tiếp |
| lỡ tag lệch `package.json.version` | cắt version mới, **không** sửa tag đã push |
| `gh release create` báo release đã tồn tại | ai đó publish rồi — `gh release view` xem, đừng tạo đè |
| `gh auth status` đỏ | `gh auth login` rồi chạy lại; không tự đổi credential của principal |
| push bị từ chối | `origin/main` đã tiến — DỪNG, báo principal, không force |
| lỡ tag nhầm commit, **chưa push** | `git tag -d vX.Y.Z && git reset --hard HEAD~1` rồi chạy lại script; chỉ an toàn khi chưa push |
| repo chưa có tag nào | bình thường cho bản đầu; `resolveLatestReleaseTag` sẽ fail cho tới khi có tag đầu tiên |

## Vì sao không dùng GitHub Actions

`v0.1.0` từng có `.github/workflows/release.yml` trigger trên tag push. Nó không chạy: tag lên
remote đúng commit, file có mặt tại tag, Actions bật, chỉ push một tag — nhưng 0 run.
`workflow.created_at` trùng đúng thời điểm push, tức GitHub mới biết đến workflow trong chính
cú push đó nên ref-update của tag không khớp workflow nào. (Tài liệu GitHub: `push` dùng file
workflow của chính ref được push, và ràng buộc "phải tồn tại trên default branch" **không** áp
cho `push` — nên file-có-mặt-tại-tag vẫn không đủ.)

Repo đã bỏ workflow thay vì vá cái bẫy bootstrap đó. Với một maintainer cắt release từ máy
local, `gh` đã auth sẵn, workflow chỉ đóng góp: một bộ phận async có thể im lặng không chạy,
và việc ép `tag == version` cho những tag tạo ngoài `cut-release.cjs` — thứ không nên xảy ra
ngay từ đầu. `gh release create` cho kết quả y hệt, đồng bộ, biết ngay đúng sai.

Chỉ nên quay lại workflow khi có người thứ hai cắt release, hoặc cần tag từ web UI. Khi đó
nhớ: push `release.yml` lên `main` thành **một cú push riêng trước**, rồi mới push tag.

## Sau khi release

`alp update` trên máy khác resolve tag mới nhất qua GitHub API (fallback `git ls-remote --tags`).
Máy đang chạy `alp` chỉ thấy thông báo sau khi cache `~/.alp/update-check.json` hết TTL 24h —
đây là hành vi đúng, không phải lỗi. Muốn kiểm tra ngay thì xoá file cache đó rồi chạy lại `alp`.

## Ranh giới

- Không release từ nhánh khác `main`, không release khi test đỏ.
- Không tự viết release notes đè lên auto-generated notes trừ khi principal yêu cầu.
- Không thêm lại GitHub Actions cho release trong lúc đang cắt release — đó là thay đổi thiết
  kế, cần bàn riêng (xem mục "Vì sao không dùng GitHub Actions").
- Không commit `dist/`, `memory/` (xem skill `git` — chúng phải nằm ngoài mọi commit).

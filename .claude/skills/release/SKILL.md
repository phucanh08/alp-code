---
name: release
description: Cắt bản release cho alp-code — bump version, cập nhật CHANGELOG, tạo tag `vX.Y.Z` và publish GitHub Release. Kích hoạt khi principal yêu cầu "cắt release", "tag bản mới", "phát hành vX.Y.Z", hoặc hỏi về quy trình release/tag của repo.
---

# release — cắt bản phát hành

Skill này cần `Write`/`Edit` và `Bash` (kèm `gh` để xác minh). Execution policy không cấp đủ
thì chỉ đọc và đề xuất được kế hoạch release, không tạo tag.

**Phạm vi: chỉ repo alp-code.** Nó nói về `package.json`, `CHANGELOG.md`, `cut-release.cjs`
và `release.yml` của chính repo này, nên nằm ở `.claude/skills/` (project scope) chứ không
phải `skills/` — `skills/` được ship cho mọi project qua `ALP_REPO_ROOT/skills`.
`.codex/skills/release` là symlink trỏ về đây; sửa bản ở `.claude/`, đừng tạo bản sao thứ hai.

## Cổng chặn — đọc trước mọi thứ khác

**Không tạo tag, không push tag, trừ khi principal yêu cầu trong phiên này.** Tag đã push là
việc ra ngoài máy: nó kích hoạt workflow, sinh GitHub Release, và người khác `alp update` về
ngay lập tức. Duyệt ở lần trước không tính cho lần này (HOUSE-RULES §1.2).

Hai việc **không bao giờ tự làm**, kể cả khi thấy sai:

| Việc | Vì sao |
|---|---|
| xoá / trỏ lại tag đã push | máy khác đã checkout tag đó; đổi nghĩa tag là đổi code dưới chân người dùng |
| sửa/xoá GitHub Release đã publish | release notes là bản ghi công khai |

Tag sai thì **cắt version mới** (`v0.1.1`), không sửa tag cũ. Báo principal, để họ quyết.

## Bất biến của repo

`tag vX.Y.Z` **phải** khớp `package.json.version` là `X.Y.Z`. `.github/workflows/release.yml`
verify điều này và fail release nếu lệch. Đây là lý do bump version và tạo tag luôn đi cùng
một commit — không tag một commit chưa bump.

## Tiền điều kiện

Chạy hết, không bỏ bước nào:

```bash
git branch --show-current                 # phải là main
git status --porcelain                    # phải rỗng
git fetch origin --tags && git log --oneline -1 origin/main   # main local phải bằng origin
git tag -l                                # xem version gần nhất đã phát hành
gh workflow list                          # Release phải đã tồn tại trên remote TỪ TRƯỚC
npm run typecheck && npm run build && npm test
for f in scripts/test-*.cjs; do node "$f" || break; done
```

Bất kỳ bước nào đỏ → **DỪNG**, báo principal. Không release trên tree bẩn, không release khi
test đỏ, không release từ nhánh feature.

**Nếu `release.yml` vừa được thêm/sửa và chưa có trên remote**: push nó lên `main` trước,
thành một cú push riêng, rồi mới tag ở bước sau. Xem mục "Workflow không chạy" bên dưới.

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

### 3. Push — hỏi principal trước

```bash
git push origin main --tags
```

Push commit và tag **cùng lúc**: tag trỏ vào commit mà `origin/main` chưa có thì workflow
checkout được nhưng lịch sử nhánh lệch với release.

Ngoại lệ duy nhất: cú push nào **lần đầu mang `release.yml` lên remote** thì phải tách làm
hai — `git push origin main` trước, đợi `gh workflow list` thấy workflow, rồi
`git push origin --tags` sau. Đẩy cả hai một lần khiến tag không sinh run nào.

### 4. Xác minh

```bash
gh run list --workflow=release.yml --limit 1
gh release view vX.Y.Z
```

Workflow phải xanh và release phải tồn tại kèm auto-generated notes. Workflow đỏ ở bước
"Verify tag matches package.json version" nghĩa là tag lệch version — xem mục Xử lý lỗi.

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
| workflow fail ở bước verify | tag lệch `package.json.version` — cắt version mới, không sửa tag |
| workflow không chạy | xem mục "Workflow không chạy" bên dưới trước khi nghi ngờ pattern hay tag |
| push bị từ chối | `origin/main` đã tiến — DỪNG, báo principal, không force |
| lỡ tag nhầm commit, **chưa push** | `git tag -d vX.Y.Z && git reset --hard HEAD~1` rồi chạy lại script; chỉ an toàn khi chưa push |
| repo chưa có tag nào | bình thường cho bản đầu; `resolveLatestReleaseTag` sẽ fail cho tới khi có tag đầu tiên |

## Workflow không chạy

Đã xảy ra thật khi cắt `v0.1.0` (2026-08-27): tag lên remote đúng commit, `release.yml` có
mặt tại tag, Actions bật, repo public, chỉ push một tag — nhưng `total_count` runs = 0.

Chẩn đoán theo thứ tự, dừng ở cái đầu tiên sai:

```bash
git ls-remote --tags origin                                   # tag có trên remote chưa
gh api "repos/<slug>/contents/.github/workflows/release.yml?ref=vX.Y.Z" --jq .size
gh api repos/<slug>/actions/permissions                       # enabled: true
gh api repos/<slug>/actions/workflows --jq '.workflows[] | {name, state, created_at}'
```

Nguyên nhân của ca 2026-08-27: `workflow.created_at` **trùng đúng thời điểm push** — nghĩa là
GitHub mới biết đến workflow ngay trong chính cú push đó, nên ref-update của tag không khớp
workflow nào. Tài liệu GitHub ghi rõ `push` dùng file workflow **của chính ref được push**
("includes workflows that are not merged into the default branch") và ràng buộc "phải tồn tại
trên default branch" **không** áp cho `push` — nên file-có-mặt-tại-tag vẫn không đủ. Cộng đồng
mô tả cùng hiện tượng: workflow chỉ bắt các push xảy ra **sau khi** nó đã tồn tại trên repo.

Loại trừ các nguyên nhân khác trước khi kết luận:

| Nghi ngờ | Bác bỏ bằng |
|---|---|
| push > 3 tag một lúc (documented: không sinh event) | chỉ push một tag |
| tag do workflow khác push bằng `GITHUB_TOKEN` | push từ máy local bằng credential người dùng |
| Actions bị tắt / repo là fork / repo archived | `gh api repos/<slug>` + `/actions/permissions` |
| sai pattern `v*.*.*` | `v0.1.0` khớp |

**Khắc phục — không đụng vào tag đã push:**

```bash
gh release create vX.Y.Z --generate-notes
```

Kết quả giống hệt cái workflow sinh ra. Trước khi chạy, tự tay kiểm cái mà workflow lẽ ra
verify: tag phải khớp `package.json.version`.

**Không** xoá rồi push lại tag để ép workflow bắn — vi phạm cổng chặn ở đầu skill. Lần release
sau workflow chạy bình thường vì nó đã tồn tại từ trước.

## Sau khi release

`alp update` trên máy khác resolve tag mới nhất qua GitHub API (fallback `git ls-remote --tags`).
Máy đang chạy `alp` chỉ thấy thông báo sau khi cache `~/.alp/update-check.json` hết TTL 24h —
đây là hành vi đúng, không phải lỗi. Muốn kiểm tra ngay thì xoá file cache đó rồi chạy lại `alp`.

## Ranh giới

- Không release từ nhánh khác `main`, không release khi test đỏ.
- Không sửa `.github/workflows/release.yml` trong lúc cắt release — đó là thay đổi riêng,
  cần review riêng.
- Không tự viết release notes đè lên auto-generated notes trừ khi principal yêu cầu.
- Không commit `dist/`, `memory/` (xem skill `git` — chúng phải nằm ngoài mọi commit).

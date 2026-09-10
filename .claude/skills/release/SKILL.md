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

**Không tạo tag, không push tag, không `npm publish`, không publish release, trừ khi principal
yêu cầu trong phiên này.** Tag đã push, package đã publish và release đã publish đều là việc ra
ngoài máy: người khác `npm i -g alp-code` hoặc `alp update` về ngay lập tức. Duyệt ở lần trước
không tính cho lần này (HOUSE-RULES §1.2).

Ba việc **không bao giờ tự làm**, kể cả khi thấy sai:

| Việc | Vì sao |
|---|---|
| xoá / trỏ lại tag đã push | máy khác đã checkout tag đó; đổi nghĩa tag là đổi code dưới chân người dùng |
| sửa/xoá GitHub Release đã publish | release notes là bản ghi công khai |
| `npm unpublish` | npm chỉ cho gỡ trong 72h và **không bao giờ** cho dùng lại số version đó; gỡ một bản đang có người cài là làm hỏng máy họ |

Version đã `npm publish` là vĩnh viễn. Sai thì publish bản vá tiếp theo, không gỡ bản cũ.

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
npm whoami                                # `npm publish` cần đã đăng nhập registry
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

### 2. Rà `docs/user/`

`docs/user/` được xuất bản lên <https://alp.anhlp.com/docs/> và mô tả hành vi của chính repo
này. Repo `alp-docs` không giữ bản sao nào — nó kéo thư mục này từ `main` rồi build, nên cắt
release mà không rà là đẩy tài liệu sai ra ngoài trong vòng một giờ.

```bash
node scripts/check-docs-drift.cjs --version X.Y.Z
```

Script chỉ đo và chỉ chỗ, không tự sửa. Ba nhóm nó báo:

| Nhóm | Nghĩa | Cách xử lý |
|---|---|---|
| `VERSION` | chuỗi version ALP khác bản sắp phát hành | đổi số |
| `PIN` | commit được trích nhưng không nằm trên nhánh hiện tại | trỏ lại commit có thật trên `main` |
| `PREVIEW` | banner "chưa có trong stable `vX.Y.Z`" | **quyết định**, xem dưới |

Banner preview là nhóm duy nhất máy không làm thay được. Nếu bản này đưa tính năng đó vào
stable thì banner phải bị **xoá**, không phải đổi số — đổi số là biến docs từ cũ thành sai.
Nếu tính năng vẫn chưa vào stable thì mới đổi số. Đọc `git log <tag-gần-nhất>..HEAD` rồi
quyết từng cái một.

`WARN` cho banner không nói version nào: script không đọc hộ được, tự mở file ra xem.

Sửa xong thì commit riêng trước khi sang bước 3 — `cut-release.cjs` chặn tree bẩn:

```bash
git add docs/user && git commit -m "docs: rà docs/user cho vX.Y.Z"
node scripts/check-docs-drift.cjs --version X.Y.Z   # phải xanh
```

Script này cũng chạy trong `for f in scripts/test-*.cjs` ở phần Tiền điều kiện qua
`test-check-docs-drift.cjs`, nhưng đó chỉ kiểm logic của script — nội dung docs vẫn phải rà ở
bước này.

### 3. Bump version + đóng mục CHANGELOG + commit + tag

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

### 4. Dựng artifact

```bash
node scripts/pack-release.cjs
```

Ra **7 file** trong `build/release/`, cho hai channel cài:

| File | Đi đâu | Là gì |
|---|---|---|
| `alp-code-X.Y.Z.tgz` | `npm publish` | wrapper **mỏng** — 9 file, không có `dist/` |
| `alp-code-vX.Y.Z-<target>.tar.gz` × 5 | asset của GitHub Release | native binary + `skills/` `scaffold/` `hooks/` |
| `SHA256SUMS` | asset của GitHub Release | checksum của 5 archive trên |

Năm target lấy từ `src/install/binary-targets.json`: `darwin-arm64`, `darwin-x64`,
`linux-x64-gnu`, `linux-arm64-gnu`, `windows-x64`.

**Gói npm không chứa code.** Nó chỉ có `install.cjs`, `bin/alp.cjs`, `lib/resolve-target.cjs`,
`lib/install-payload.cjs`, `lib/binary-targets.json`, `scripts/ensure-state.cjs` (shim cho
`alp update` của bản npm < 0.10.0), README và LICENSE; postinstall resolve OS/CPU rồi tải đúng
native archive từ GitHub Release. Nên **`npm publish` mà release chưa có asset là hỏng cả hai
channel**, không riêng channel tarball — xem thứ tự ở bước 5.

Native archive là thứ chứa sản phẩm thật: binary do `bun build --compile --minify` sinh ra từ
`src/cli/entry.ts`, kèm `skills/`, `scaffold/`, `hooks/`, `LICENSE` và `install-manifest.json`.
Máy người dùng không cần Node, Bun, npm hay Git.

Script kiểm trước khi dừng: gói npm phải đủ `NPM_WRAPPER_REQUIRED` và không lọt
`NPM_WRAPPER_FORBIDDEN` (`dist/`, `src/`, `scripts/` trừ đúng shim, `hooks/`, `skills/`,
`scaffold/`, `node_modules/`) — cả hai danh sách ở `scripts/lib/release-manifest.cjs`, vì
`files` trong `package.json` sai thì `npm pack` vẫn xanh; version của Bun phải khớp
`.bun-version`; và `validateArchiveEntries` từ chối mọi entry path tuyệt đối hoặc có `..`.
Archive dựng reproducible: mtime epoch, uid/gid 0, gzip mtime 0. Nó **dừng trước**
`npm publish` và `gh release upload`, giống `cut-release.cjs` dừng trước `git push`.

`--npm-only` (alias `--skip-bundle`) bỏ qua phần native, `--out <dir>` đổi thư mục ra. Cả hai
là để thử tại chỗ; release thật chạy không cờ.

**`build-binary.cjs` đòi `git status --porcelain` rỗng — kể cả file untracked.** Một thư mục
`.idea/` hay bất kỳ rác IDE nào cũng đủ chặn, dù `cut-release.cjs` đã cho qua (nó chỉ nhìn
staged + tracked). Loại nó ở `.git/info/exclude` (machine-local, không cần commit thêm sau khi
đã tag) rồi chạy lại. **Không** `ALP_SKIP_GIT_CHECK=1` cho release thật — biến đó có để chạy
test. Nó không chặn `sourceCommit` được ghi vào `install-manifest.json`; nó làm giá trị đó nói
dối, vì binary khi ấy build từ cây file không khớp commit mà manifest trích.

### 5. Push và publish — hỏi principal trước

```bash
git push origin main --tags
npm publish build/release/alp-code-X.Y.Z.tgz   # 2FA: xem ghi chú dưới

# Release notes = đúng mục CHANGELOG.md của bản này, không phải "Full Changelog: ..." tự sinh —
# principal đọc release muốn thấy đổi gì, không phải đi bấm vào link compare.
awk -v ver="X.Y.Z" '
  $0 ~ "^## \\[" ver "\\]" { on=1; next }
  on && /^## \[/ { exit }
  on { print }
' CHANGELOG.md > /tmp/release-notes-X.Y.Z.md
prev_tag=$(git describe --tags --abbrev=0 vX.Y.Z^)
printf '\n**Full Changelog**: https://github.com/phucanh08/alp-code/compare/%s...vX.Y.Z\n' "$prev_tag" \
  >> /tmp/release-notes-X.Y.Z.md

gh release create vX.Y.Z --title vX.Y.Z --notes-file /tmp/release-notes-X.Y.Z.md
(cd build/release && gh release upload vX.Y.Z \
  alp-code-vX.Y.Z-darwin-arm64.tar.gz \
  alp-code-vX.Y.Z-darwin-x64.tar.gz \
  alp-code-vX.Y.Z-linux-arm64-gnu.tar.gz \
  alp-code-vX.Y.Z-linux-x64-gnu.tar.gz \
  alp-code-vX.Y.Z-windows-x64.tar.gz \
  SHA256SUMS)
```

Push commit và tag **cùng lúc**: tag trỏ vào commit mà `origin/main` chưa có thì release trỏ
vào lịch sử mà người khác chưa fetch được.

Đọc lại `/tmp/release-notes-X.Y.Z.md` trước khi chạy `gh release create` — gõ sai `ver` (không
khớp header CHANGELOG vừa đóng) cho ra file rỗng, và đây là thông báo công khai nên phải đúng
ngay từ lần đầu, không sửa lại sau khi đã publish.

Thứ tự trên là có ý: tag lên trước, rồi npm, rồi release + asset. `install.sh` resolve
`releases/latest`, tải archive theo tên **và tải `SHA256SUMS`** để kiểm trước khi cài — thiếu
một trong hai thì mọi lần cài trong khoảng đó đều fail. Gói npm cũng tải chính những asset ấy
ở postinstall, nên khoảng trống giữa `npm publish` và `gh release upload` là khoảng cả hai
channel cùng hỏng. Đẩy asset ngay sau khi tạo release, đừng để sang việc khác.

Cả `npm publish` lẫn `gh release` đều chạy tại máy nên biết kết quả ngay. Không có bước async
nào để phải đi moi log.

`npm publish` có thể dừng ở `EOTP` — tài khoản bật 2FA thì npm đòi one-time password hoặc xác
thực qua browser, và agent không làm hộ được. Đưa lệnh cho principal chạy trong terminal của họ
(`--otp=<mã>` nếu dùng authenticator app). Artifact đã dựng rồi; không cắt lại version.

Nếu bước 2 có sửa `docs/user/`, đẩy site luôn sau khi push — cùng lý do: biết kết quả ngay
thay vì đợi cron mỗi giờ của `alp-docs`.

```bash
gh workflow run deploy.yml -R phucanh08/alp-docs
```

`alp-code` cố ý không tự bắn sang: bắn tự động cần token của `alp-docs` nằm trong secret của
một repo public, đắt hơn nhiều so với vài chục phút độ trễ mà nó tiết kiệm.

### 6. Xác minh

```bash
gh release view vX.Y.Z --json tagName,isDraft,url
gh api repos/phucanh08/alp-code/releases/latest --jq .tag_name   # đúng cái alp update đọc
gh release view vX.Y.Z --json assets --jq '.assets[].name'       # 5 archive + SHA256SUMS
npm view alp-code version                                        # phải là X.Y.Z
```

Release phải tồn tại, không phải draft, `releases/latest` phải trả đúng tag vừa cắt — đây mới
là thứ `resolveLatestReleaseTag` dựa vào — và phải đủ **6 asset**: 5 native archive cộng
`SHA256SUMS`. Thiếu một target nghĩa là OS/CPU đó không cài được ở cả hai channel; thiếu
`SHA256SUMS` thì không máy nào cài được.

## Mẫu báo cáo về principal

```
✓ preflight: main sạch, đồng bộ origin, test xanh
✓ version:   0.1.0 → 0.2.0 (MINOR: thêm `alp --version`)
✓ changelog: [0.2.0] - 2026-08-27
✓ docs:      docs/user/ sạch (xoá 2 banner preview, repin 1 commit)
✓ commit:    <hash> chore(release): v0.2.0
✓ artifact:  build/release/ — alp-code-0.2.0.tgz + 5 native archive + SHA256SUMS
✗ tag/push:  CHƯA — chờ principal duyệt
✗ npm/release: CHƯA — chờ principal duyệt
✗ docs site:  CHƯA — build alp-docs sau khi push
```

Chưa push thì ghi rõ chưa push, và ghi riêng npm với GitHub Release: dựng được artifact không
có nghĩa là đã đẩy đi. Đã publish thì dán link release và dòng `npm view alp-code version`.

## Xử lý lỗi

| Lỗi | Làm gì |
|---|---|
| tag `vX.Y.Z` đã tồn tại | DỪNG. Không `-f`. Báo principal, đề xuất số kế tiếp |
| lỡ tag lệch `package.json.version` | cắt version mới, **không** sửa tag đã push |
| `gh release create` báo release đã tồn tại | ai đó publish rồi — `gh release view` xem, đừng tạo đè |
| `gh auth status` đỏ | `gh auth login` rồi chạy lại; không tự đổi credential của principal |
| push bị từ chối | `origin/main` đã tiến — DỪNG, báo principal, không force |
| lỡ tag nhầm commit, **chưa push** | `git tag -d vX.Y.Z && git reset --hard HEAD~1` rồi chạy lại script; chỉ an toàn khi chưa push |
| `pack-release` báo "requires a clean working tree" | file untracked (`.idea/`, rác IDE) — loại ở `.git/info/exclude`, **không** `ALP_SKIP_GIT_CHECK=1` |
| `npm publish` báo `EOTP` | tài khoản bật 2FA — đưa lệnh cho principal chạy trong terminal của họ, đừng cắt lại version |
| `check-docs-drift` báo PIN | commit được trích chưa lên `main` — trỏ lại commit có thật, không release docs trỏ vào nhánh feature |
| `check-docs-drift` báo PREVIEW | tự đọc `git log <tag-cũ>..HEAD`: đã vào stable thì **xoá** banner, chưa thì đổi số |
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

`alp update` cập nhật theo channel của bản cài: bản npm gọi `npm install -g alp-code@X.Y.Z`,
bản binary tải native archive đúng OS/CPU của tag mới nhất, dev clone checkout tag rồi build. Cả ba đều
resolve tag mới nhất qua GitHub API (fallback `git ls-remote --tags`).
Máy đang chạy `alp` chỉ thấy thông báo sau khi cache `~/.alp/update-check.json` hết TTL 24h —
đây là hành vi đúng, không phải lỗi. Muốn kiểm tra ngay thì xoá file cache đó rồi chạy lại `alp`.

## Ranh giới

- Không release từ nhánh khác `main`, không release khi test đỏ.
- Không `npm publish` khi principal mới chỉ duyệt tag/GitHub Release — đó là hai lần ra ngoài
  máy khác nhau, hỏi riêng từng lần.
- Release notes lấy từ đúng mục CHANGELOG.md của bản này (bước 5), không dùng
  `--generate-notes` mặc định — nội dung để principal đọc là gì đã đổi, không phải link
  compare. Không tự ý viết thêm ngoài CHANGELOG hoặc sửa lại notes sau khi đã publish.
- Không thêm lại GitHub Actions cho release trong lúc đang cắt release — đó là thay đổi thiết
  kế, cần bàn riêng (xem mục "Vì sao không dùng GitHub Actions").
- Không commit `dist/`, `memory/` (xem skill `git` — chúng phải nằm ngoài mọi commit).

# Changelog

Mọi thay đổi đáng chú ý của alp-code được ghi ở đây.

Định dạng theo [Keep a Changelog](https://keepachangelog.com/vi/1.1.0/); phiên bản theo
[Semantic Versioning](https://semver.org/lang/vi/). Mỗi mục `## [X.Y.Z]` tương ứng một tag
`vX.Y.Z` và một GitHub Release.

## [Chưa phát hành]

### Thay đổi

- **Mở phiên interactive không còn tốn một lượt trả lời.** Gõ `alp` trước đây là agent đáp ngay
  trước khi principal kịp gõ gì — và thứ nó đáp lại là một task không có thật, vì phiên interactive
  chưa có task nào cho tới khi principal gửi. Nguyên nhân không nằm ở chữ trong prompt: session
  context và task input có vòng đời khác nhau nhưng đi chung một kênh. Nay tách hai:
  `session-context.md` mô tả agent cho cả phiên (identity, quyền hạn thực tế, invariants, policy,
  reporting contract) và không bao giờ tạo lượt; `task.md` mang memory đã chọn cùng task, và **chính
  là** lượt đầu tiên. Phiên interactive không sinh `task.md`, nên không còn gì để adapter lỡ tay đưa
  thành positional prompt. Delegated execution không đổi: vẫn submit task đúng một lần.
- **Codex nhận identity qua `SessionStart` hook, giống Claude.** Đo trên `codex-cli 0.149.0`: hook
  chạy đúng một lần và `additionalContext` vào transcript thành message `role: developer`, **trước**
  lượt của người dùng. Ghi nhận cũ "Codex báo `SessionStart Failed`" đã lỗi thời, nên mục
  `## Identity` thừa trong prompt Codex bị gỡ — một kênh cho mỗi runtime, nếu không identity vào
  context hai lần. Hệ quả thấy được: cả hai runtime nay nhận file session context byte-identical, và
  phiên interactive biết rõ workspace, invariants, policy trước câu hỏi đầu tiên — trước đây những
  thứ này chỉ đến qua prompt, tức là qua lượt giả.
- **Phiên `alp` interactive chạy không guardrail.** Claude nhận `--dangerously-skip-permissions`,
  Codex nhận `--dangerously-bypass-approvals-and-sandbox`. Principal ngồi ngay đó và tự duyệt được
  từng bước, nên prompt quyền chỉ là ma sát. Đánh đổi ghi rõ trong `docs/architecture.md`: cờ này vô
  hiệu hoá `permissions.deny` (Claude) và sandbox (Codex) **cho riêng phiên đó**, gồm cả cách ly
  private memory giữa các role. Nó không phải công tắc toàn cục — chỉ `run-main` đặt
  `interactive: true`, còn `alp delegate` luôn `false`, nên mọi delegated execution giữ nguyên deny
  list, sandbox và bất biến read-only. Ở Codex, `-s` bị bỏ hẳn khi bypass thay vì để lẫn: Codex
  nhận cả hai mà không báo lỗi và cờ bypass thắng, nên giữ `-s` chỉ để lại một tham số nói sai về
  chế độ đang chạy.

### Thêm

- `CODE_CRAFT_RULES` trong `src/agents/shared/house-rules.ts` — bốn quy tắc tay nghề phỏng theo
  [ghi chép của Andrej Karpathy](https://x.com/karpathy/status/2015883857489522876) về các lỗi
  code thường gặp của LLM: nêu giả định thay vì hành động theo nó, chọn lời giải nhỏ nhất, sửa
  đúng phạm vi được yêu cầu, biến task thành một check chạy được. Chỉ spread vào `main`,
  `review`, `oracle` là các vai viết hoặc phán xét code; `search`, `librarian`, `read-thread`,
  `compaction`, `titling` không nhận vì không hành động theo được.
- `docs/orchestrator-vision.md` — đề xuất role built-in thứ 9 `orchestrator`, điều phối nhiều
  execution dài chạy song song trên workspace tách biệt (mô hình orchestration của Paseo). Ghi rõ ba
  ràng buộc: nó phải là built-in vì `delegatesTo` khác rỗng mà §5.5 chốt custom agent là lá; nó
  **không** được miễn trừ khỏi invariant cấm `create_agent`/`paseo` — cái phải lớn lên là
  `DelegationService`, không phải danh sách ngoại lệ; và §4.10 (budget, cancellation, trace) phải
  xong trước, vì orchestrator thiếu hai thứ đó là fork bomb kèm file policy. Doc triết lý giữ §5.9
  làm đoạn trỏ sang, cùng một dòng điều kiện mở khoá trong bảng hoãn §8.

### Sửa

- `docs/alp-design-philosophy-and-vision.md` viết trước v0.2.0 nên còn mô tả thế giới cũ: backend
  Herdr, `hooks/acl-guard.cjs`, `instructions: (context) =>`, và output `kind: json`. Nay bám đúng
  code hiện tại. Hai chỗ đáng chú ý hơn sửa chữ: §5.4 đổi tiền đề — output JSON đã bị gỡ khỏi cả 8
  role nên `kind: text` là lựa chọn duy nhất cho custom agent v1; và §5.7 phải sống chung với việc
  v0.2.0 đã chiếm trước `.alp/agents/` bằng file phẳng `<role>.md`, nên custom agent trùng tên
  built-in role phải bị từ chối lúc load.
- `docs/delegation.md` còn nói `acl-guard.cjs` kiểm raw-runtime target — hook đó đã bị gỡ; việc kiểm
  nằm ở `src/policy/invariants.ts` cộng deny rule khai báo của từng runtime.
- `docs/model-routing.md` còn nói adapter "có thể dùng Herdr hoặc Paseo".

## [0.2.0] - 2026-09-02

### Thay đổi

- **Role trả lời bằng văn xuôi, không còn JSON.** Trước đây `renderCapsulePrompt` nhét
  JSON Schema (sinh từ Zod) vào prompt và Stop hook trả `{"decision":"block"}` khi output
  không parse được — nên mọi phiên, kể cả phiên `main` nói chuyện trực tiếp với principal,
  đều đáp lại bằng một cục JSON. Cả 8 role nay dùng contract `textOutput` vốn đã có sẵn
  trong `shared/voice.ts`; chỉ chuỗi rỗng bị từ chối. Không consumer nào đọc field lẻ nên
  giữ schema cho specialist không mang lại gì.
- **Identity vào context qua `SessionStart` hook thay vì con trỏ trong `prompt.md`.**
  `hooks/session-boot.cjs` đọc đúng một file `.alp/agents/<role>.md` phẳng và không
  `require()` gì từ `dist/` (~45ms). Trước đó agent phải đốt một tool call `Read` trước khi
  làm bất cứ việc gì. Hook fail-open: lỗi thì trả context rỗng kèm cảnh báo, vì phiên thiếu
  identity còn cứu được còn phiên bị chặn thì không.
- **ACL chuyển từ chặn từng tool call sang khai báo trong runtime config.** Claude nhận
  `permissions.{additionalDirectories,deny}`; Codex nhận `[sandbox_workspace_write]` và
  `[[rules]]`. `hooks/acl-guard.cjs` spawn một process Node và load `dist/` cho **mọi** tool
  call — đây là nửa còn lại của việc boot chậm.
- `AgentDefinition.instructions` không còn nhận tham số. Identity vì thế giống hệt nhau
  giữa các execution, điều kiện để render một lần ra file cho hook đọc; workspace và task
  chuyển sang prompt của từng execution.
- Backend mặc định là `paseo`. `fallback_backend` cố ý để trống: âm thầm nhảy sang backend
  khác khi backend chính có vẻ unhealthy thì khó chẩn đoán hơn là fail rõ ràng — chọn
  `local` tường minh bằng `alp delegation switch local`.

### Thêm

- `alp identity sync` — render identity của cả 8 role ra `.alp/agents/<role>.md` (mode 0600).
  `alp init` cũng gọi tự động và cài `SessionStart` hook vào `.claude/settings.local.json`
  của project, loại trừ qua `.git/info/exclude` nên `git status` của project không đổi.

### Sửa

- `LocalProcessBackend` không spawn được runtime cài qua npm trên Windows: Node từ chối
  chạy thẳng `.cmd`/`.bat`, nên `alp run` và `alp delegate` đều chết với `EINVAL` khi gặp
  `claude.cmd`/`codex.cmd`. Bản cài native (`.exe`) không dính, nên lỗi này lọt lâu.
  `shell: true` không phải cách sửa ở đây — cmd.exe sẽ diễn giải lại tham số prompt vốn
  chứa dấu cách và dấu nháy; `resolveSpawnCommand` đọc shim, lấy ra script Node bên trong
  rồi spawn trực tiếp, argv qua nguyên vẹn.
- `hookCommand` quote bằng `JSON.stringify` — sai loại: nó escape backslash chứ không quote
  shell, nên path Windows nằm trong settings.json dưới dạng `C:\\Users\\…`.
- `scripts/test-cli-link.cjs` **xoá `node_modules` của chính repo**. Nó chạy `bootstrap.cjs`
  với `cwd` trỏ vào repo này, nhưng bootstrap lấy root từ `__dirname` nên `cwd` vô tác dụng;
  bước đầu của bootstrap là `npm ci`, lệnh này xoá `node_modules` trước khi cài lại, và với
  `npm_config_offline` bật cứng thì chỉ cần cache thiếu một tarball là bỏ lại checkout rỗng.
  Nay bootstrap trên một bản copy tạm và spawn `bootstrap.cjs` của chính bản copy đó.
- `alp delegate --runtime claude` chết ngay lúc khởi động trên Windows: adapter xin sandbox
  kèm `failIfUnavailable` nhưng Claude Code không kích hoạt filesystem sandbox trên nền tảng
  này. Nay chỉ xin sandbox ở nơi cấp được, và bù lại bằng cách rút `Bash` khỏi role read-only
  — mất shell chứ không mất bất biến read-only.
- Phiên Codex không nhận được identity: cùng `session-boot.cjs` chạy tốt trên Claude Code lại
  bị Codex báo `SessionStart Failed`. Prompt của Codex mang thêm mục `## Identity`; Claude
  Code vẫn đi đường hook.
- Test suite chạy được thật trên Windows. Harness e2e ghi fake runtime là script `#!` không
  đuôi và ghim adapter vào `platform: "linux"` — cả sáu test e2e chết ở `spawn ENOENT` và
  không phủ gì; bốn assertion `mode & 0o777` không thể pass vì Windows không có POSIX
  permission bit; và `rm` recursive trên thư mục temp mới tạo trả `ENOTEMPTY` đủ thường để
  khoảng một nửa số lần chạy đỏ ở `afterEach`, mỗi lần một test khác nhau.
- …và chạy được cả trên macOS/Linux: assertion về deny rule của Claude tự chép lại format
  thay vì gọi hàm sinh ra nó, nên nối `//` vào một path POSIX vốn đã có `/` đầu và kỳ vọng
  ba dấu gạch. Nó chỉ xanh trên Windows, nơi `C:\…` không có gạch đầu để cộng dồn.
  `absoluteRule` nay được export và test gọi thẳng, kèm assertion ghim format cho cả hai
  nền tảng. Deny list sinh ra không đổi.

### Gỡ

- Backend Herdr (`scripts/lib/delegation/backends/herdr/`, `herdr-fleet.cjs`, skill
  `herdr`). `LocalProcessBackend` nay luôn được register — nó không cần daemon, nên là
  backend giữ cho delegation chạy được trên máy chưa cài gì. Regex chặn `herdr`/`paseo`
  trong `src/policy/invariants.ts` giữ nguyên làm defense-in-depth.
- Cụm CJS delegation đã chết: `create-service`, `index`, `init-backend`, `runtime-installer`,
  `core/{backend,backend-registry,context-builder,logger,policy,role-registry,service}`,
  `testing/fake-backend` và `scripts/lib/delegation.cjs`. Composition root thật chỉ load 6
  file từ thư mục này lúc chạy; phần còn lại đã được TypeScript trong `src/` thay thế và chỉ
  còn test của chính nó gọi tới. Thư mục từ 18 file còn 6.
- Skill `delegation-switch` — lệnh `alp delegation switch` mà nó bọc thì giữ nguyên.
- Đoạn docs mô tả `alp init` hỏi và tự cài runtime: `alp init` chỉ ghi backend đã chọn vào
  `~/.alp/projects.json` và không cài gì, nên prompt tương tác và bước
  `npm install -g @getpaseo/cli` được tả trong docs là một flow không còn tồn tại.

**Mất mát phải chấp nhận, ghi trong `docs/architecture.md`:** ACL khai báo không diễn đạt
được ba thứ mà hook cũ cưỡng chế — guardrail `hasIndirectCommand` (`$(...)`, `eval`,
`bash -c`, `xargs`), tool gating theo workflow state, và cách ly private-memory phía **đọc**
trên Codex (sandbox của nó chặn ghi, không chặn đọc). `PolicyEngine` vẫn chạy lúc prepare.

## [0.1.4] - 2026-08-28

### Sửa

- `RuntimeAdapter.probe()`/`prepare()` của Claude và Codex hardcode đuôi `claude.cmd`/
  `codex.cmd` trên Windows, chỉ khớp bản cài qua npm. Bản cài qua winget/native installer
  (vd. `claude.exe`) đã có sẵn trên PATH và chạy tốt — kể cả chính phiên Claude Code đang
  gõ commit này — nhưng `alp doctor`/`alp` vẫn báo "not found". Thêm
  `resolveRuntimeCommand()` resolve theo PATHEXT thay vì hardcode một đuôi.

## [0.1.3] - 2026-08-28

### Sửa

- `install.ps1`: chuỗi lỗi `"$target: checkout release thất bại…"` khiến PowerShell parse
  `$target:` như scope qualifier (giống `$env:`), làm `irm .../install.ps1 | iex` gãy ngay ở
  bước parse trước khi script kịp chạy. Đổi thành `${target}:`.
- `bootstrap.cjs`/`alp.cjs`/`run-role.cjs`/`delegate.cjs`: gọi thẳng
  `spawnSync("npm.cmd", …)` ăn `EINVAL` trên các bản Node đã vá CVE-2024-27980 (chặn spawn
  `.cmd`/`.bat` khi không có `shell: true`), khiến `npm ci`/`npm run build` gãy trên Windows —
  gồm cả installer một dòng. Route qua `spawnSyncCommand` (đã có sẵn cho delegation backends,
  resolve `npm.cmd` về `npm-cli.js` rồi spawn Node trực tiếp) thay vì tự viết lại yếu hơn.
- `cut-release.cjs` không cắt được release trên working tree CRLF (vd. Windows với
  `core.autocrlf=true`): `text.indexOf(UNRELEASED + "\n")` không khớp dù nội dung committed
  luôn là LF. Chuẩn hoá CRLF→LF khi đọc CHANGELOG.md trước khi so khớp.

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

[Chưa phát hành]: https://github.com/phucanh08/alp-code/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/phucanh08/alp-code/compare/v0.1.4...v0.2.0
[0.1.4]: https://github.com/phucanh08/alp-code/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/phucanh08/alp-code/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/phucanh08/alp-code/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/phucanh08/alp-code/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/phucanh08/alp-code/releases/tag/v0.1.0

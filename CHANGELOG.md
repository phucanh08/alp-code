# Changelog

Mọi thay đổi đáng chú ý của alp-code được ghi ở đây.

Định dạng theo [Keep a Changelog](https://keepachangelog.com/vi/1.1.0/); phiên bản theo
[Semantic Versioning](https://semver.org/lang/vi/). Mỗi mục `## [X.Y.Z]` tương ứng một tag
`vX.Y.Z` và một GitHub Release.

## [Chưa phát hành]

## [0.10.4] - 2026-09-09

### Sửa

- Trang npm của `alp-code` không còn thiếu README. `pack-release.cjs` dựng gói npm từ
  `npm-wrapper/` và có copy `LICENSE` vào, nhưng quên copy `README.md` — `npm pack` chỉ tự
  gộp README khi file đó có sẵn ngay trong thư mục được đóng gói, nên mọi bản đã publish trước
  đây đều không có readme trên npmjs.com.

## [0.10.3] - 2026-09-09

### Sửa

- `alp update` (kênh npm) và tải native archive nói chung không còn ưu tiên nhầm một tuyến IPv6
  chạy được nhưng chậm hơn IPv4 tới 4-5 lần trên một số mạng — `fetch()` của Node dùng thứ tự
  DNS mặc định, không tự đua song song IPv4/IPv6 như `curl`, nên archive 25-40MB có thể vượt cả
  timeout 120s vừa tăng ở v0.10.2 khi gặp biến động mạng bình thường. Ép `dns` ưu tiên IPv4 khi
  cả hai cùng tồn tại; máy chỉ có IPv6 không bị ảnh hưởng.

## [0.10.2] - 2026-09-09

### Sửa

- Tải native archive (npm postinstall, `alp update` mọi channel) không còn bị abort giữa chừng
  trên mạng chậm. `AbortSignal.timeout(15_000)` bọc cả việc đọc body chứ không chỉ chờ response
  đầu tiên, mà archive hiện tại nặng 25-40MB — dưới ~2.5MB/s là chắc chắn timeout giữa chừng,
  đúng lỗi `The operation was aborted due to timeout` người dùng gặp phải. Tăng lên 120s.

## [0.10.1] - 2026-09-09

### Sửa

- `alp update` từ bản cài npm cũ hơn 0.10.0 không còn crash `MODULE_NOT_FOUND` trên
  `scripts/ensure-state.cjs`. Package npm cũ (trước v0.10.0) tự mở một tiến trình node mới nhắm
  đúng đường dẫn đó sau khi `npm install -g` xong; từ v0.10.0 npm package chỉ còn là wrapper
  mỏng và không còn cây `scripts/` thật, nên mọi lượt update từ bản cũ đều vỡ ngay sau khi gói
  mới đã cài xong. Thêm một shim tại đúng đường dẫn đó, chỉ để bản cũ gọi trúng — nó định vị
  native payload của phiên bản vừa cài rồi nhờ payload dựng state qua `__internal ensure-state`.

## [0.10.0] - 2026-09-09

### Thêm

- Native Bun executable cho macOS arm64/x64, Linux glibc x64/arm64 và Windows x64; archive
  phát hành mang theo `skills/`, `scaffold/`, legacy hooks, license, manifest và checksum.
- Installer binary không cần Node, validate archive/checksum/target/smoke trước khi atomically
  đổi `current`; self-update giữ previous version và rollback khi state bootstrap thất bại.
- npm chuyển thành wrapper-only package, tải payload đúng bằng version package vào cache
  per-user; first run vẫn hoạt động khi npm được cài với `--ignore-scripts`.
- Public hook subcommands (`alp hook session-boot|session-end|compact-record`) và internal
  supervisor/state/update-check subcommands trong cùng static binary.
- Native black-box, migration, installer, performance và năm-target CI runtime matrix.

### Thay đổi

- `alp init` ghi hook qua stable command, tự repair project v0.9 và link packaged skills qua
  asset root sống qua `current` switch. `session-boot` rẽ nhánh trước full registry/memory.
- `alp --version` dùng build-time version, không đọc `package.json`, không network và không
  khởi tạo state; p95 gate của direct darwin-arm64 binary là dưới 40 ms.
- Root package là development-only/private để không thể vô tình publish full source package;
  `scripts/pack-release.cjs` chỉ pack npm wrapper và native release artifacts.

## [0.9.0] - 2026-09-07

### Thêm

- **`npm i -g alp-code` — máy người dùng không build gì nữa.** Trước đây installer clone repo
  rồi chạy `npm ci --include=dev` và `tsc` ngay trên máy người dùng. Cách đó bắt mọi người cài
  phải có Git, phải tải toàn bộ devDependencies, và biến mỗi lần cài thành một lần build có thể
  hỏng vì lý do chẳng liên quan gì tới ALP. Claude Code và Codex CLI đều không làm vậy, và
  không có lý do gì ALP phải làm khác.

  Từ bản này có hai kênh phát hành, cùng một cây file, khác nhau ở ai sở hữu thư mục cài:

  | Channel | Cài bằng | Thư mục cài |
  |---|---|---|
  | `npm` (chính) | `npm i -g alp-code` | npm sở hữu, dưới `node_modules/` |
  | `tarball` (dự phòng) | `install.sh` / `install.ps1` tải bundle của GitHub Release | `~/.alp-code/versions/<tag>`, `current` trỏ vào bản đang dùng |

  Tarball tồn tại cho máy không có npm hoặc bị chặn registry, và nó mang sẵn dependency runtime
  — giải nén ra là chạy, không `npm install` sau đó. Dev clone (`--branch`) là channel thứ ba
  và là chỗ duy nhất còn build tại máy.

- **`scripts/pack-release.cjs`** dựng cả hai artifact trên máy maintainer, kiểm nội dung
  (`scripts/lib/release-manifest.cjs`) rồi cố ý dừng trước `npm publish` và `gh release
  upload` — giống `cut-release.cjs` dừng trước `git push`. `scripts/test-pack-release.cjs`
  kiểm cùng hợp đồng đó ở mỗi lần chạy test, vì `files` trong `package.json` sai thì `npm pack`
  vẫn xanh và lỗi chỉ lộ ra ở máy người dùng.

- **Giấy phép MIT.** `LICENSE` ở gốc repo và `"license": "MIT"` trong `package.json`.
  Trước đây cả hai đều thiếu: npm hiển thị package là không có giấy phép, và người dùng không
  có căn cứ nào để biết mình được phép làm gì với nó. `LICENSE` nằm trong danh sách file bắt
  buộc của artifact nên nó đi theo mọi bản cài.

- **Hook forwarder `~/.alp/hooks/<tên>.cjs` và `scripts/ensure-state.cjs`.**
  `<project>/.claude/settings.local.json` do `alp init` ghi nằm trong repo của người dùng và
  sống lâu hơn mọi bản cài, nên nó phải trỏ vào một đường dẫn không đổi. Forwarder đọc
  `~/.alp/install.json` để tìm bản cài hiện hành; project đã init từ trước được sửa lại tự
  động. `ensure-state.cjs` chạy được như một tiến trình riêng vì sau update, tiến trình `alp`
  đang chạy vẫn giữ code cũ trong RAM.

### Thay đổi

- **Memory và toàn bộ state chuyển sang `~/.alp`; thư mục cài thành artifact thay được.**
  Đây là điều kiện để bỏ được bước build: update giờ thay nguyên khối thư mục cài, nên bất cứ
  thứ gì của người dùng còn nằm trong đó đều là dữ liệu hẹn ngày mất. `<thư mục cài>/memory`
  được di trú sang `~/.alp/memory` ở lần chạy `alp` đầu tiên sau khi lên bản này, kèm một dòng
  ghi chú để lại chỗ cũ. Di trú chỉ chạy khi chỗ mới chưa có dữ liệu thật, và không hàm nào
  trong `state.cjs` được phép ghi đè nội dung đã có.

- **`alp update` đi theo channel của bản cài** — `npm install -g alp-code@<version>`, hoặc tải
  bundle mới và đổi `current`, hoặc checkout tag rồi build (dev clone). Không còn bước
  backup/restore memory nào cả: không có gì của người dùng nằm trong vùng bị thay nữa. Đường
  tarball tải về staging rồi mới rename và trỏ lại `current`, nên tải hỏng để lại thư mục rác
  chứ không để lại bản cài dở.

- **`alp uninstall` không còn xoá cả `~/.alp`.** Nó xoá đúng những tên do alp-code tạo
  (`agents`, `hooks`, `executions`, `delegation`, `install.json`, `update-check.json`,
  `mode.json`, `projects.json`) và không đụng vào thứ của người khác trong cùng thư mục.
  Memory vẫn được chuyển sang backup cạnh `~/.alp` trừ khi có `--purge-memory`. Bản npm được gỡ
  bằng `npm uninstall -g alp-code` thay vì `rm -rf` sau lưng npm; bản tarball gỡ cả
  `~/.alp-code`.

- **`install.sh`/`install.ps1` viết lại quanh `--channel auto|npm|tarball`.** `auto` dùng npm
  khi có, tự lùi về tarball khi npm thất bại. Cả hai không còn chạy `npm ci` hay `tsc`.
  `bootstrap.cjs` chỉ build khi channel là dev clone, và bỏ qua bước link `alp` cho bản npm —
  hai lệnh `alp` tranh nhau PATH thì lệnh của ta trỏ vào thư mục npm có quyền xoá.

- **`alp doctor` biết channel.** Bản phát hành được kiểm là còn đủ file artifact và install
  record còn khớp; gợi ý sửa là `alp update` thay vì `npm run build`. Kiểm build drift chỉ còn
  ý nghĩa với dev clone nên chỉ chạy ở đó.

- **`low` nâng `main` từ `claude-haiku-4-5 @ low` lên `claude-sonnet-5 @ high`.** `oracle` của
  `low` giữ nguyên `gpt-5.6-sol @ high`, nên bất biến "oracle luôn ở runtime đối diện main"
  vẫn giữ nguyên qua cả năm nấc.

## [0.8.0] - 2026-09-06

### Thêm

- **Dial công suất năm nấc: `alp --mode low|medium|high|ultra|puck`.** Trước đây mỗi vai chạy
  đúng một model **cho mỗi runtime**, khai cứng trong definition, nên hai câu hỏi lúc mở phiên
  là "chạy Claude hay Codex" và "sửa file nào để đổi model". Dial gộp cả hai thành thứ người
  dùng thật sự biết: **việc này khó cỡ nào**. Mượn khuôn của Amp — `medium` mặc định — nhưng
  chỉ dùng model Codex và Claude.

  Mỗi nấc là một **loadout hoàn chỉnh**: mỗi vai đúng **một** model và một mức suy nghĩ.

  | Nấc | `main` | effort | `oracle` | effort |
  |---|---|---|---|---|
  | `low` | claude-haiku-4-5 | low | gpt-5.6-sol | high |
  | `medium` (mặc định) | gpt-5.6-sol | high | claude-opus-5 | high |
  | `high` | claude-opus-5 | high | gpt-5.6-sol | xhigh |
  | `ultra` | claude-opus-5 | high | gpt-6-astra | high |
  | `puck` | gpt-5.6-sol | xhigh | gpt-5.6-sol | xhigh |

  Bốn nấc dial chỉ xoay hai ghế mà độ khó chạm tới: `main` (người làm) và `oracle` (người được
  hỏi khi bí). Sáu vai còn lại giống nhau qua cả bốn nấc — `search` gpt-5.6-terra, `librarian`
  gpt-5.6-sol, `read-thread` và `titling` claude-haiku-4-5, `review` và `compaction`
  claude-opus-5 — đúng chỗ Amp ghim cứng subagent: model của chúng là một phần công việc chứ
  không phải một mức cố gắng. `oracle` luôn đứng ở runtime **đối diện** `main`: người được hỏi
  khi bí phải là một cách nhìn khác, không phải cùng model tự hỏi lại chính nó. `high` và
  `ultra` cùng cầm bút bằng Opus 5 — khác nhau ở oracle, nơi `ultra` leo lên model mới nhất
  (`gpt-6-astra`) thay vì chỉ cộng thêm effort.

  **`puck` nằm ngoài trục độ khó**: toàn Codex ở cả tám vai (`read-thread`/`titling` sang
  gpt-5.6-luna, `review` sang gpt-5.6-terra). Dành cho máy chỉ cài `codex`, cho lúc hạn mức
  Claude đã hết, hoặc cho người muốn đúng loadout Amp mặc định.

  Chọn nấc theo thứ tự `--mode` → `ALP_MODE` → `alp mode set` (`~/.alp/mode.json`) → menu ↑/↓
  trên TTY → `medium`. Nấc gõ sai (`--mode smart`) dừng ngay chứ không rơi về mặc định, vì một
  phiên chạy nấc khác nấc người dùng tưởng là im lặng tốn tiền hoặc im lặng yếu đi. Nấc đi vào
  `ExecutionPolicy.mode`, nên `policy.json` ghi lại nấc đã chạy và `policyHash` đổi theo nấc —
  hai lần chạy khác model không thể trùng hash. `definitionHash` **không** đổi: nấc là lựa chọn
  lúc phóng, không phải một vai khác. Adapter export `ALP_MODE` nên execution delegated kế thừa
  nấc của phiên cha, thay vì subagent lặng lẽ tụt về `medium` giữa một phiên `ultra`.

  **Đổi hành vi mặc định:** `main` trước đây là opus-5 (Claude) hoặc gpt-5.6-sol (Codex) @
  high/xhigh. Mặc định mới `medium` cho `main` `gpt-5.6-sol` @ high — tức phiên mặc định giờ
  chạy trên Codex CLI, không phải Claude Code. Muốn một phiên main do Claude cầm bút: `alp
  --mode high|ultra` (Opus 5) hoặc `--mode low` (Haiku), hoặc `export ALP_MODE=ultra`.

  Một test giữ điều kiện mọi model của mọi nấc đều có mặt trong cả `MODEL_RUNTIMES` lẫn
  `MODEL_CONTEXT_WINDOWS` —
  thiếu bảng đầu thì không biết phóng CLI nào, thiếu bảng sau thì ngưỡng auto-compact mặc định
  (90% cửa sổ) lặng lẽ biến mất đúng ở nấc đó.

- **`alp mode show|set <nấc>`** — nấc ghi nhớ machine-local ở `~/.alp/mode.json` (0600, atomic
  write), thay chỗ `alp runtime show|set` và `~/.alp/runtime.json`. Menu lúc mở phiên giờ hỏi
  nấc chứ không hỏi runtime, mỗi dòng kèm một câu nói nấc đó dành cho việc gì. Preference hỏng
  → warning + fallback `medium`, không throw. `alp update` bảo toàn `mode.json` qua các lần
  cập nhật.

### Thêm

- **Ba grant khai bằng tên: `capabilities.skills`, `capabilities.subagents`,
  `capabilities.mcpServers`.** Một vai trước đây chỉ khai `tools`, nên `Skill` là một ô vuông
  duy nhất: có hoặc không. Có nghĩa là mọi skill trên máy — kể cả cái vừa `git pull` về sáng
  nay. Ba field mới nói tên cụ thể, và chỉ tên (§5.3): định nghĩa không được viết `command:`
  hay đường dẫn, vì một file khai báo tự viết được egress của mình thì nó không còn là khai
  báo nữa. Tên resolve đúng một lần, ở `createExecutionPolicy`, đối chiếu với catalog của
  principal trong `src/agents/capability-catalog.ts`; **spec đã resolve** (command, args,
  egress, prompt) mới là thứ đi vào snapshot. Nhờ vậy `policy.json` ghi lại lệnh thật sự đã
  chạy chứ không trỏ vào machine config có thể đổi phía dưới.

  Cả ba vào `definitionHash` **và** `policyHash`: nới một grant là đổi định danh của vai, y
  như đổi `tools`.

- **Trần thi hành lúc registry load.** `UNKNOWN_SKILL`, `UNKNOWN_SUBAGENT`,
  `UNKNOWN_MCP_SERVER` cho tên ngoài catalog; `DUPLICATE_GRANT` cho tên khai hai lần; và một
  bất biến hai chiều — có `Skill` trong `tools` thì phải kể tên skill, kể tên skill thì phải
  có `Skill` (`INVALID_SKILL_GRANT`). Chiều thứ nhất bắt được đúng hình dạng §5.5 cấm, và nó
  đang tồn tại thật: sáu built-in cầm `Skill` mà không kể tên gì, tức trần bằng cả skill root
  của máy. Subagent còn một trần nữa — `tools` của nó không bao giờ rộng hơn `tools` của vai
  cấp nó (`UNKNOWN_TOOL`), vì subagent không phải đường vòng qua một giới hạn.

  `SUBAGENT_CATALOG` và `MCP_SERVER_CATALOG` **rỗng** ở v1 (§5.5). Rỗng là mặc định
  fail-closed chứ không phải chỗ trống chờ điền: khai bất cứ tên nào cũng bị từ chối ngay lúc
  load. `SKILL_CATALOG` liệt kê 14 skill trong project scope, có test giữ đồng bộ với thư mục
  `skills/`.

- **Policy engine trả lời được ba câu hỏi mới** — `SKILL_NOT_GRANTED`, `SUBAGENT_NOT_GRANTED`,
  `MCP_SERVER_NOT_GRANTED` — và tự route tool name dạng `mcp__<server>__<tool>` về grant của
  server đó. Route này nằm **sau** guardrail raw runtime tool, nên `mcp__paseo__spawn_agent`
  vẫn dừng ở `RAW_RUNTIME_TOOL_DENIED` chứ không rơi xuống thành một câu hỏi về MCP.

- **Ba dòng mới trong bảng Authority** của session context: `Skills`, `Subagents`,
  `MCP servers` — server in kèm egress (`docs (network egress)`), vì "được nối MCP nào" thực
  chất là câu hỏi "cái gì rời khỏi máy này".

- **Harness test tier 2–3 cho agent** (`test/support/agent-dry-run.ts`): prepare một
  execution thật, đọc argv, settings file, `mcp-config.json` và bảng Authority mà không chạy
  runtime. Bộ test mới đi kèm phủ cả ba grant trên cả hai adapter.

- **`autoCompactTokens` — ngưỡng compact khai theo vai, theo từng model.** Trước bản này,
  một execution ALP spawn ra nén transcript theo cửa sổ mặc định của runtime, tức theo cấu
  hình của **máy** đang chạy chứ không theo vai đang chạy. Nhưng "còn nhớ được bao nhiêu" là
  thuộc tính của vai: `main` giữ cả bức tranh nên phải giữ được tối đa model cho phép, còn một
  `search` phình tới 150k token là đã hỏng — nén sớm là cách hỏng rẻ hơn.

  Field mới nằm trên `AgentDefinition` như một **map theo runtime** — `{ claude?, codex? }`,
  cùng khuôn với `model` và `reasoningEffort` — vì ngân sách này đi theo model chứ không theo
  vai một mình: cùng một con số 500 000 là "nén sớm" trên cửa sổ 1M của opus-5, nhưng trên cửa
  sổ 272k của gpt-5.6 thì transcript không bao giờ chạm tới, và runtime lặng lẽ rơi về chốt
  cứng của nó (95% cửa sổ) — muộn hơn cả mặc định, trong khi argv vẫn in ra con số nói ngược
  lại. Cả map vào `definitionHash` và `policyHash`; snapshot ghi đủ một khoá mỗi runtime, vì
  policy viết ra trước lúc dispatch và chưa biết runtime nào sẽ chạy.

  Dịch khác nhau ở hai runtime: Claude nhận `autoCompactWindow` trong settings file của
  execution, Codex nhận `-c model_auto_compact_token_limit=` **trên argv** — cùng lý do với
  hook và MCP, vì `codex-config.toml` là file ALP ghi chứ không phải file Codex đọc.

  Ngân sách tám vai built-in (— là bỏ trống, nhận mặc định 90%):

  | Vai | claude | codex | Thực nén ở (claude / codex) | Vì sao |
  |---|---:|---:|---|---|
  | `main` · `oracle` | — | — | 900 000 / 244 800 | Giữ tối đa model cho phép; suy luận trên cả tập bằng chứng |
  | `librarian` · `review` | 300 000 | — | 300 000 / 244 800 | Doc nguyên văn, diff cộng code quanh nó; quá 300k trên cửa sổ 1M là đã đi lạc |
  | `read-thread` | — | 200 000 | 180 000 / 200 000 | Thread hữu hạn; cửa sổ haiku-4-5 đúng bằng 200k nên phía Claude phải là mặc định |
  | `search` · `compaction` | 150 000 | 150 000 | 150 000 / 150 000 | Không được phép phình; viết handoff chứ không gom corpus |
  | `titling` | 100 000 | 100 000 | 100 000 / 100 000 | Sàn; một cái tiêu đề gần như không cần gì |

  Trần thi hành lúc registry load, cho **từng phía**: số nguyên trong khoảng 100 000–1 000 000
  **và** không vượt cửa sổ context của chính model phía đó, ngoài khoảng thì
  `INVALID_AUTO_COMPACT_LIMIT`. Vế thứ hai là vế bắt được lỗi im lặng: khai vượt cửa sổ không
  hỏng gì trông thấy, chỉ khiến vai nén **muộn hơn** mức nó tưởng. Chặn ở chỗ con số được viết
  ra, chứ không clamp ở chỗ nó được đọc.

- **Vai không khai ngưỡng thì mặc định là 90% cửa sổ context của model đó.** Bỏ trống trước đây
  nghĩa là "để runtime tự chọn", mà hai runtime chọn khác nhau: Codex nén ở 90% cửa sổ model,
  Claude nén ở cửa sổ nó tự tune theo model và theo settings của **máy** đang chạy. Cùng một vai
  lại nhớ được nhiều ít khác nhau tuỳ chỗ chạy — đúng cái phụ thuộc-vào-máy mà việc khai ngưỡng
  sinh ra để chấm dứt. Nay ALP tự tính mặc định từ bảng `MODEL_CONTEXT_WINDOWS`
  (`src/agents/model-context.ts`) và ghi ra cả hai runtime như một ngưỡng khai tường minh:

  | Model | Cửa sổ | Mặc định (90%) |
  |---|---:|---:|
  | `claude-opus-5` · `claude-sonnet-5` | 1 000 000 | 900 000 |
  | `claude-haiku-4-5` | 200 000 | 180 000 |
  | `gpt-5.6-sol` · `gpt-5.6-terra` · `gpt-5.6-luna` | 272 000 | 244 800 |

  Model không có trong bảng thì không có mặc định — runtime giữ cửa sổ của nó, vì để runtime
  tự lo còn hơn dựng ngân sách từ phỏng đoán. Test giữ bảng phủ hết model mà tám vai built-in
  route tới, và pin 90% của mọi cửa sổ trong bảng vẫn nằm trong khoảng Claude chấp nhận.

### Đã bỏ

- **`--runtime`, `alp runtime show|set`, và `alp delegate --runtime`.** Từ khi mỗi vai ở mỗi
  nấc chỉ có một model, **model quyết định runtime**: `claude-*` phóng Claude Code, `gpt-*`
  phóng Codex CLI, tra qua bảng `MODEL_RUNTIMES` viết tay trong `model-context.ts` (không đoán
  theo prefix — một tên lệch quy ước mà đoán sai thì phóng nhầm CLI trong im lặng). Giữ thêm
  một lựa chọn runtime song song chỉ tạo ra tổ hợp vô nghĩa: `--runtime claude` cộng nấc
  `medium` là yêu cầu Claude Code chạy `gpt-5.6-sol`.

  Cả ba đường cũ **dừng với lỗi chỉ sang nấc**, không bị bỏ qua trong im lặng — một script cũ
  còn `--runtime codex` sẽ nói ra rằng nó không còn ép được gì, thay vì chạy đúng nấc mặc định
  mà người viết tưởng đang ép Codex. `DelegationExecutionOptions.runtime` cũng biến mất khỏi
  request; `DelegationExecutionRecord.runtime` giữ nguyên, vì nó ghi lại CLI **đã thật sự
  chạy**. Một nấc có thể trộn hai CLI trong cùng một phiên — `high` chạy `main` trên Codex và
  `oracle` trên Claude — nên "runtime của phiên" không còn là một khái niệm có thật.

### Thay đổi

- **Mọi delegated execution giờ chạy với `--mcp-config` tường minh cộng `--strict-mcp-config`.**
  Trước bản này, một vai delegated kế thừa toàn bộ MCP config của máy — egress không policy
  nào cho phép, không hash nào ghi lại. Giờ ALP ghi ra một file cho từng execution, rỗng
  (`{"mcpServers":{}}`) khi vai không được cấp gì, và cờ strict cấm runtime đọc thêm chỗ khác.
  Phiên interactive vẫn giữ config của máy, cùng đánh đổi đã ghi với
  `--dangerously-skip-permissions`.

- **Codex nhận MCP qua `-c mcp_servers.<name>={ … }` trên argv**, không qua
  `codex-config.toml`. Lý do là file đó Codex không đọc: nó đọc `$CODEX_HOME/config.toml`, thứ
  ALP không ghi. Grant nào chỉ nằm trong file ấy là grant chỉ tồn tại trên giấy — hook đã đi
  đường `-c` từ trước, MCP giờ đi cùng đường. Codex không có subagent in-process và không có
  cờ strict tương đương; §4.6 đã ghi subagent là tối ưu hoá chứ không phải điều kiện, nên bên
  Codex không dịch gì cả.

- **Claude ACL đổi từ deny-only sang có `allow`.** Skill được cấp vào allow list dạng
  `Skill(<tên>)` thay vì deny từng skill không cấp — vì một tool name trần trong `deny` gỡ hẳn
  tool khỏi context của model, nên "chỉ những skill này" bắt buộc phải viết bằng allow.
  Subagent thành `Agent(<tên>)`, MCP server thành `mcp__<tên>`.

- **`Task` và `Agent` thật sự bị deny.** Vòng lặp deny chỉ chạy trên `TOOL_CATALOG`, mà hai
  tool này không nằm trong đó — nên chúng chưa từng bị chặn dù không vai nào được cấp. `Task`
  giờ luôn deny; `Agent` chỉ mở khi vai có subagent được cấp.

- **House rule tách theo audience.** Một vai đọc quy tắc của chính nó, không phải quy tắc của
  vai khác; `InstructionOptions.audience` quyết định block nào được render.

- Review chuyển sang `gpt-5.6-terra` ở phía Codex (`docs/model-routing.md` cập nhật theo).

### Sửa

- **Workspace root tương đối resolve theo từng request**, không còn theo `process.cwd()` lúc
  policy được tạo. Một delegation phát đi từ thư mục khác trước đây nhận nhầm root.

- **Vai không có workspace root giờ prepare được.** `ExecutionService.prepare` vẫn hỏi câu
  workspace cho cả vai chỉ đọc memory, nên `compaction` và `titling` chết ngay ở bước chuẩn
  bị. `ExecutionPolicy` có thêm `workspaceAccess: "granted" | "none"` để phần còn lại của
  chuỗi biết phân biệt "không được cấp" với "chưa resolve".

**Cần làm khi nâng cấp:** ba field mới là **bắt buộc** trên mọi `AgentCapabilities` — một
định nghĩa cũ không khai sẽ không compile. Vai không dùng skill khai `skills: []` và bỏ
`Skill` khỏi `tools`; vai có dùng thì kể tên, và tên phải có trong `SKILL_CATALOG`.
`subagents` và `mcpServers` khai `[]`, vì catalog của cả hai đang rỗng.

## [0.7.0] - 2026-09-04

### Thêm

- **Continuity qua compaction.** Claude Code và Codex CLI tự nén transcript khi hết context, và
  cái bị nén đi trước tiên là những gì đã chốt từ sớm: objective, ràng buộc, quyết định đã cân
  nhắc xong. ALP giờ giữ một checkpoint nhỏ **ngoài** transcript và trả nó lại ở `SessionStart`
  ngay sau lần compact kế tiếp. Không copy native summary, không chèn synthetic turn — chỉ
  đúng phần ALP tự biết là quan trọng vì chính agent hoặc principal đã pin nó.

  ```bash
  alp context status                  # objective, số pin, generation, restore mode
  alp context pin decision -- "chose X over Y because Z"
  alp context pin constraint -- "do not touch Z"
  alp context unpin <pin-id>
  alp context validate                # kiểm checkpoint + journal
  ```

  `pin`/`unpin` chạy được cả từ CLI của principal lẫn từ trong một phiên agent — không có
  execution ID trên dòng lệnh thì nó đọc `ALP_DELEGATION_EXECUTION_ID`. Bốn loại pin
  (`decision`, `constraint`, `open-item`, `next-action`) tương ứng bốn mục trong bản chiếu
  Markdown mà model đọc lại.

  Checkpoint và `continuity.md` được seed ngay trong `ExecutionService.prepare()`, nên một
  execution mới không bao giờ có continuity rỗng vì bị bỏ quên: riêng objective đã đáng
  reinject. Cả hai nằm dưới `context/` trong execution root, ghi atomic như mọi artifact khác.

- **`ALP_COMPACT_BRIDGE=1`** bật phần ghi journal lúc `PreCompact`/`PostCompact`. Đây là phần
  duy nhất opt-in; seed và reinject checkpoint chạy mặc định. Hook `hooks/compact-record.cjs`
  không có dependency, chỉ append envelope đã lọc vào `context/compact-events.jsonl` — journal
  append-only, replay ra được generation hiện tại và compaction nào đang dang dở.

  Cái đi vào journal là **whitelist**, không phải blacklist. Payload đo thật ngày 2026-09-04
  mang những trường không schema nào của binary khai báo (`context_tokens`,
  `estimated_cache_write_usd`, `prompt_cache_likely_expired`, `seconds_since_last_response`),
  và mang khác nhau tuỳ `source`; blacklist sẽ ghi hết chúng vào file ALP giữ lại.
  `compact_summary` bị loại theo tên lẫn theo luật — đo được 22–32 KB, so với giới hạn 16 KiB
  một dòng journal.

- Hai adapter khai báo `CompactCapabilities` đã ghim theo phiên bản CLI, và bridge chỉ bật
  những event mà capability đó xác nhận. Thứ tự event **khác nhau giữa hai runtime** và ALP
  không giả vờ là chúng giống nhau: Claude phát
  `PreCompact → SessionStart(source="compact") → PostCompact` (reinjection nằm *trong* lúc
  compact, nên `PostCompact` không phải chỗ an toàn để biết compaction đã xong), còn Codex
  phát `PreCompact → PostCompact → SessionStart`.

### Thay đổi

- Codex adapter nhận `hooksDirectory` tường minh trong `defaultDependencies` thay vì suy ra
  ngầm từ `ALP_REPO_ROOT` — nó wire bốn hook thay vì hai kể từ bản này.

## [0.6.0] - 2026-09-03

### Đã gỡ

- **Backend Paseo, và cùng với nó là cả khái niệm "chọn backend".** ALP giờ chỉ chạy trên
  `LocalProcessBackend`. Lý do là ACL: chỉ backend local trao cho runtime settings file của
  chính vai đó, nên `permissions.deny` và `sandbox.filesystem.denyWrite` mới thật sự tới được
  agent — đo ngày 2026-09-03, một `search` delegated đọc private memory của vai khác bị chặn ở
  ba lớp độc lập. Backend spawn runtime qua daemon riêng không tái hiện được điều đó vì
  permission request của nó không mang path. Giữ hai backend nghĩa là giữ một cấu hình cho
  phép chọn bản yếu hơn.

  Gỡ theo: `scripts/lib/delegation/backends/paseo/`, `CjsExecutionBackendAdapter`,
  `BackendRegistry`, `resolveBackend` + fallback, cờ `--backend` (giờ bị **từ chối** chứ không
  bị lờ đi, để một script cũ không âm thầm biến `--backend paseo` thành lời văn của task),
  `alp init --backend`, `alp delegation switch`, `alp delegation health`, các khoá
  `backends:`/`backend:`/`fallback_backend:` trong `alp.config.yaml`, biến môi trường
  `ALP_DELEGATION_BACKEND`/`ALP_DELEGATION_FALLBACK`, và `scripts/lib/delegation/core/` —
  cây type/store/error CJS không còn ai require sau khi backend đi.

  `ExecutionBackend` vẫn là interface, vì test cần thay nó bằng fake; nó thôi là điểm mở
  rộng. `DelegationService` nhận thẳng một backend thay vì một registry và một cái tên.

  **Cần làm khi nâng cấp:** bỏ `--backend` khỏi mọi script gọi `alp delegate`/`alp init`, bỏ
  hai biến môi trường trên khỏi shell profile, và xoá `backend:`/`fallback_backend:`/`backends:`
  khỏi `alp.config.yaml` (chỉ `state_dir` còn được đọc). Execution cũ do Paseo sở hữu trong
  `code-native-executions.json` không còn resolve được — lệnh lifecycle trên chúng trả
  `EXECUTION_NOT_FOUND`; dọn bằng tay trong `state_dir`.

- **`RuntimeLaunchSpec.intent`.** Launch spec từng mang hai cách viết cùng một lần chạy: form
  exec (`command`/`args`) và một form khai báo (`prompt`/`model`/`mode`) chỉ tồn tại vì backend
  cũ tự spawn runtime và không exec được `command`. Hai adapter phải giữ chúng khớp nhau, mà
  chỉ form exec là được thi hành — một permission mode đặt trong `args` là thật, cùng mode đó
  đặt trong `intent` chỉ là lời đề nghị. Một cách viết thì mode một vai chạy dưới không thể
  lệch khỏi mode policy của vai đó yêu cầu.

- Guardrail chặn agent tự gọi `paseo`/`herdr` **giữ nguyên**: regex trong
  `src/policy/invariants.ts`, `Bash(paseo:*)` trong deny rule Claude và `[[rules]] allow = false`
  bên Codex. Gỡ backend không có nghĩa là mở đường cho agent gọi thẳng binary.

### Thay đổi

- `scripts/test-delegation-backends.cjs` → `scripts/test-delegation.cjs`. Contract sáu method
  từng chạy hai lần, mỗi backend một lần, để chứng minh chúng thay thế được cho nhau; giờ chạy
  một lần trên backend thật. Test workspace của caller được viết lại: thay vì một CLI Paseo giả,
  nó che `codex` trên `PATH` bằng một runtime giả rồi đọc lại đúng thứ runtime nhận được.
- `scripts/lib/delegation/backends/command-runner.cjs` → `scripts/lib/delegation/command-runner.cjs`.
  Thư mục `backends/` không còn backend nào.

## [0.5.1] - 2026-09-03

### Thay đổi

- **Đã kiểm chứng ALP chạy đúng trên Paseo 0.7.2.** Không có thay đổi hành vi nào — bản này chỉ
  ghi lại kết quả đo. Trên daemon 0.7.2: `alp delegation health` báo đúng phiên bản, delegation
  end-to-end trả kết quả khớp, execution kẹt ở permission prompt vẫn được báo `failed` kèm lý do,
  và toàn bộ test xanh. Hai shape mà backend Paseo đọc không đổi so với 0.5.1 —
  `inspect --json` vẫn trả `Status: running` cho agent đã dừng chờ duyệt trong khi vẫn mang
  `PendingPermissions`, còn `permit ls --json` vẫn cắt `id` còn tám ký tự. Chạy được trên cả
  0.5.x lẫn 0.7.x, không cần nâng cấp.
- Bỏ ghim `0.5.x` trong hai comment giải thích vì sao vai Codex dùng mode `auto`: đã kiểm lại trên
  0.7.2, Paseo vẫn chỉ cho Codex `Default Permissions, Auto-review, Full Access`, không có
  `read-only`. Lập luận giữ nguyên, chỉ ghi rõ đã kiểm tới bản nào.

## [0.5.0] - 2026-09-03

### Thêm

- **Vai được cấp quyền delegate giờ biết delegate bằng cách nào.** Bảng Authority in
  `| Delegates to | search, librarian, … |` như một quyền hạn, nhưng không runtime nào có
  tool delegation — `DelegationService` chỉ với tới được qua CLI `alp delegate`. Vai cầm
  quyền đó tìm không ra tool nào khớp và **báo blocked**, đúng theo dòng "do not route around
  it" ngay dưới bảng. Session context nay có mục `## Delegation` nêu thẳng cú pháp. Chỉ hiện
  khi vai thật sự có `delegatesTo` và có `Bash` trong grant toàn phiên — không phải grant đã
  bị lọc theo workflow state, vốn không có shell ở state mở màn của `main` và sẽ giấu mục này
  suốt phiên.

### Sửa

- **Delegation qua backend Paseo chưa từng nhận được task.** `paseo run` là
  `run [options] <prompt>` và tự spawn runtime — CLI không có exec passthrough. ALP truyền
  `-- claude --settings … "ALP task is in …"`, parser đọc `claude` làm prompt rồi vứt phần còn
  lại. Mọi specialist thức dậy với đúng chữ `claude` làm việc phải làm, chạy model và
  permission mode mặc định của Paseo thay vì của ALP. Identity vẫn tới nơi qua `--env` +
  SessionStart hook, nên triệu chứng nhìn như treo chứ không như crash. `RuntimeLaunchSpec`
  nay mang thêm `intent` — cùng một launch nhưng diễn đạt khai báo — và Paseo dịch nó thành
  `--model`, `--mode` cùng prompt ở positional cuối. Spec không có prompt bị từ chối ngay tại
  chỗ gọi, vì agent không tự báo được lỗi đó.
- **Execution kẹt ở permission prompt bị báo là đang chạy.** `paseo inspect` trả
  `Status: running` cho agent đã dừng chờ duyệt; chỉ `paseo wait` gọi đúng tên `permission`,
  mà `wait` thì block. `alp delegation status` nay đọc `PendingPermissions` có sẵn trong chính
  response của `inspect`, và báo `failed` kèm lý do. Không ai trả lời được prompt đó: delegated
  run chạy background.
- **Delegation đầu tiên vào một project mới luôn thất bại.** `paseo run` in
  `Created workspace wks_… - <tên>` và một dòng `Tip:` **trước** JSON ở lần đầu nó đặt tên cho
  workspace, còn ALP thì `JSON.parse` cả stdout. Lần sau qua được vì workspace đã tồn tại.
  Nay parse bắt đầu từ `{` hoặc `[` đầu tiên.
- **Lý do thất bại bị nuốt trên đường về.** Backend sinh `error` từ lâu nhưng
  `BackendExecutionResult` không khai báo trường đó, nên `DelegationService` không thể copy
  thứ nó không biết — mọi thất bại tới tay người gọi dưới dạng `failed` trơ trọi. Đã khai báo
  ở cả hai kiểu kết quả và propagate.
- **`alp delegation status` không còn làm mất output.** `wait` đọc transcript rồi lưu lại,
  `status` thì không trả gì — poll sau khi `wait` là thấy output vừa nhận biến mất. Cả hai nay
  đi qua một `transcript()` chung, `status` fallback về bản đã lưu khi Paseo không đọc được log.

## [0.4.0] - 2026-09-03

### Thêm

- **Tên principal và cách xưng hô không còn hard-code trong source.** `src/agents/shared/principal.ts`
  từng giữ hằng `PRINCIPAL_CONTEXT = { name: "Lê Phúc Anh", … }`, nên tên một người đi vào
  prompt của cả 8 vai ở mọi bản cài. Nay profile sống ở `~/.alp/principal.json` (0600, cạnh
  `runtime.json`/`projects.json`) với ba trường: `name`, `addressAs` (agent gọi principal là
  gì), `selfAs` (agent tự xưng là gì). `alp init` hỏi một lần khi profile chưa có **và** có
  TTY, ghi xong mới sinh `.alp/agents/<role>.md` để tài liệu identity mang đúng tên. Không có
  TTY thì init vẫn thành công, in `NOTE` gợi ý `alp principal set` và mọi vai dùng bản trung
  tính `Serve the principal.` — không chặn CI, không đoán tên từ `git config`.
- **`alp principal show|set`.** `show` in profile và đường dẫn file (exit 1 khi chưa đặt);
  `set` hỏi lại ba câu, ghi đè, rồi chạy luôn `identity sync` để `.alp/agents/` không giữ tên
  cũ. Giá trị nhập vào bị gộp khoảng trắng, cấm rỗng và giới hạn 60 ký tự — chúng được nội
  suy thẳng vào prompt nên một ký tự xuống dòng sẽ lặng lẽ thành một dòng chỉ thị mới.

### Sửa

- Bỏ hai trường chết `PRINCIPAL_CONTEXT.language` và `.timezone`: không nơi nào đọc chúng, và
  `"Vietnamese"` thực ra là literal viết cứng lần thứ hai ngay trong câu instruction.

## [0.3.2] - 2026-09-03

### Sửa

- **Hook của Codex vẫn hỏng trên Windows sau v0.3.1 — chẩn đoán trước đó sai nguyên nhân.**
  Đo lại trên `codex-cli 0.153.0` (bản native `codex.exe`, cài qua winget) bằng cách nhét
  nhiều cách viết lệnh vào cùng một mảng `hooks.SessionStart` rồi xem cách nào thật sự chạy:
  Codex **tự tách argv**, nó không đưa chuỗi qua `cmd /C`. Luật thật là *token đầu tiên không
  được bọc nháy* — mọi lệnh bắt đầu bằng `"` đều báo `hook: SessionStart Failed`, không in gì.
  Nên cả `"<node>" "<script>"` lẫn dạng thêm một cặp nháy `""<node>" "<script>""` mà v0.3.1
  phát hành đều hỏng như nhau; đường dẫn có dấu cách chỉ là điều kiện đủ, không phải nguyên
  nhân. Đã đo: `<node> "<script>"`, `node "<script>"`, `C:\PROGRA~1\…\node.exe "<script>"` và
  `cmd /c "<node>" "<script>"` chạy được; `"C:\PROGRA~1\…\node.exe" "<script>"` (không dấu
  cách, chỉ có nháy đầu) thì hỏng. Nay interpreter đi vào trần: dùng thẳng `process.execPath`
  khi nó không có dấu cách, còn khi có — `C:\Program Files\nodejs\node.exe`, tức bản cài mặc
  định — thì dùng `node` trên PATH, đúng thứ mà shim `alp.cmd` lúc cài vốn đã phụ thuộc. Đường
  dẫn script vẫn được bọc nháy vì nó có thể chứa dấu cách. Kiểm chứng end-to-end: session
  context tới được model (agent trả đúng role id đặt trong file context) thay vì tự xưng là
  "Codex". Claude Code vẫn giữ dạng cũ — nó spawn qua `cmd /d /s /c "<lệnh>"` và dạng bọc nháy
  là dạng đang chạy đúng ở đó.

## [0.3.1] - 2026-09-03

### Sửa

- **Hook của Codex không chạy trên Windows, nên phiên Codex không có identity.** Cả hai hook
  báo `hook exited with code 1` và không in gì; agent tự xưng là "Codex" thay vì role của nó.
  Nguyên nhân nằm ở shell: Codex chạy hook qua `cmd.exe /C` trần, mà shell này có luật — dòng
  lệnh bắt đầu bằng dấu nháy và mang hơn hai dấu nháy thì nó **xoá dấu nháy đầu và cuối** rồi
  chạy phần còn lại. Chuỗi `"<node>" "<script>"` vì thế tới nơi thành
  `C:\Program Files\…\node.exe" "…\session-boot.cjs`, bị cắt ở dấu cách đầu tiên, và cmd báo
  `'C:\Program' is not recognized`. Chỉ xảy ra khi đường dẫn node có dấu cách — cài mặc định
  vào `C:\Program Files\nodejs` là dính. Bọc thêm một cặp nháy quanh cả chuỗi là cách xử lý
  có tài liệu: cmd bóc đúng cặp nó định bóc, lệnh bên trong còn nguyên. Claude Code **không**
  nhận thay đổi này: nó spawn qua `cmd /d /s /c "<lệnh>"`, mà `/s` đã ăn sẵn một cặp nháy
  ngoài, nên thêm cặp nữa sẽ làm hỏng đúng cái đang chạy tốt.

### Thay đổi

- **`alp update` in gọn lại.** Trước đây nó xả toàn bộ output của `git fetch`, `git checkout`
  và `npm ci` + build. Nay còn ba dòng: bản cũ → bản mới, một dòng báo đang build, một dòng
  kết quả. Output của lệnh con được capture chứ không bỏ đi, nên khi hỏng thì thông báo lỗi
  còn rõ hơn trước — `commandFailure` đọc đúng stream đó. `alp update --verbose` trả lại toàn
  bộ output, cần khi build hỏng và phải nhìn lỗi thật.

## [0.3.0] - 2026-09-03

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

[Chưa phát hành]: https://github.com/phucanh08/alp-code/compare/v0.10.4...HEAD
[0.10.4]: https://github.com/phucanh08/alp-code/compare/v0.10.3...v0.10.4
[0.10.3]: https://github.com/phucanh08/alp-code/compare/v0.10.2...v0.10.3
[0.10.2]: https://github.com/phucanh08/alp-code/compare/v0.10.1...v0.10.2
[0.10.1]: https://github.com/phucanh08/alp-code/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/phucanh08/alp-code/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/phucanh08/alp-code/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/phucanh08/alp-code/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/phucanh08/alp-code/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/phucanh08/alp-code/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/phucanh08/alp-code/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/phucanh08/alp-code/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/phucanh08/alp-code/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/phucanh08/alp-code/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/phucanh08/alp-code/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/phucanh08/alp-code/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/phucanh08/alp-code/compare/v0.1.4...v0.2.0
[0.1.4]: https://github.com/phucanh08/alp-code/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/phucanh08/alp-code/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/phucanh08/alp-code/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/phucanh08/alp-code/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/phucanh08/alp-code/releases/tag/v0.1.0

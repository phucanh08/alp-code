# Nhúng skill alp-plugin vào alp-code

Nhánh `worktree-embed-alp-skills` (trên `fix/session-repo-root-and-portable-workspaces`) · commit `1168350`

## Đã làm

Nhúng 13 skill từ `phucanh08/alp-plugin@master` (commit `107d219`) vào `skills/`, lọc theo
nhu cầu thật của 8 vai. 552KB, không binary, không node_modules, không secret.

Nhưng phát hiện chính không phải chuyện chép file: **`skills/` ở gốc repo không runtime nào
tự thấy.** Claude Code chỉ nạp skill từ `<cwd>/.claude/skills/`, mà CWD của phiên là
`identity/<role>/` (CHARTER §7). Trước commit này `skills:` trong loadout chỉ là một dòng
chữ in ra trong thẻ danh tính — kể cả `agent-memory` và `herdr` cũng chưa từng được nạp thật.
Nên phần lớn công việc là wiring.

## Mapping skill → vai

| Vai | Trước | Sau | Vì sao |
|---|---|---|---|
| main | `agent-memory, herdr, alp:plan, alp:cook` | `agent-memory, herdr, alp-plan, git` | `alp:cook` bắt spawn subagent qua Task tool, main không có `Task` trong `tools:` |
| search | `agent-memory, alp:scout` | `agent-memory, gkg` | `scout` cũng cần Task; `gkg` (go-to-definition, find-usages) đúng bước 3–4 PLAYBOOK |
| librarian | `agent-memory, alp:research, alp:docs-seeker` | `agent-memory, research, docs-seeker` | mapping đã đúng, chỉ bỏ tiền tố |
| read-thread | `agent-memory` | giữ nguyên | không có Bash → skill chạy script sẽ fail |
| review | `agent-memory` | `+code-review, alp-scenario, security-scan` | PLAYBOOK chia 4 concern nhưng trước đó không có skill nào |
| oracle | `agent-memory` | `+alp-predict, problem-solving, alp-debug` | `alp-predict` = 5 persona tranh luận, khớp "phản biện độc lập trước quyết định rủi ro cao" |
| compaction | `[]` | giữ `[]` | rà cả 81 skill: không skill nào nén thread |
| titling | `[]` | giữ `[]` | `tools: []`, không skill nào chạy được |

`scout` và `repomix` có nhúng nhưng chưa gán vai nào — để sẵn, không bật.

## Thay đổi code

| File | Việc |
|---|---|
| `scripts/lib/skill-links.cjs` (mới) | loadout `skills:` → symlink `identity/<role>/.claude/skills/<tên>`. Link **từng skill**, không link cả thư mục → vai chỉ thấy skill trong loadout của mình. Target tương đối (`../../../../skills/<tên>`) để không chết khi clone sang máy/đường dẫn khác |
| `scripts/compile-acl.cjs` | sinh + dọn link cùng lúc với `settings.json`; `--check` báo `SKILL-DRIFT` |
| `scripts/lib/loadout.cjs` | `validate()` nhận `knownSkills` (tham số 4, optional) — tên skill không có thật và tên trùng giờ là lỗi |
| `scripts/lib/claude-settings.cjs` | truyền `knownSkills` vào validate → compile fail đóng khi loadout khai skill ma |
| `scripts/doctor.cjs` | tín hiệu `SKILL-DRIFT` |
| `identity/_shared/HOUSE-RULES.md` | §5 mới: skill ở đâu, Claude tự nạp / Codex đọc `.claude/skills/<tên>/SKILL.md` khi cần |
| `.gitignore` | `identity/*/.claude/skills/` — sản phẩm sinh ra, cùng loại `settings.json` |
| `scripts/test-skill-links.cjs` (mới) | 18 ca |

Hệ quả phụ đáng giá: **`skills:` giờ là ACL thật**, cùng hạng với `tools:` và `memory:`,
không còn là dòng trang trí.

## Sửa khi nhúng

- Frontmatter `name:` của 6 skill không hợp lệ ngoài ngữ cảnh plugin — `alp:debug`,
  `alp:plan`, `alp:scenario`, `alp:predict`, `alp:security-scan` (ký tự `:` là reserved),
  và `Problem-Solving Techniques` (có dấu cách) → chuẩn hoá về tên thư mục.
- Tham chiếu chéo `alp:X` trong 14 file → tên local.
- Bỏ 6 thư mục lồng `skills/X/X/` (bản slash-command trùng nội dung, sinh ra từ commit
  `c9c4df3` của alp-plugin; alp-code không có hệ command).

Đính chính báo cáo trước: `alp:plan` trong loadout của main **không phải** lỗi gõ sai — nó
khớp frontmatter `name: alp:plan` của thư mục `alp-plan`. Vẫn phải đổi, vì tên có `:` không
dùng được cho skill repo-local.

## Kiểm chứng

`compile-acl --check` OK · `doctor` sạch · 8/8 test chạy được đều xanh
(skill-links 18 ca, loadout-models, agent-routing, communication, delegation, cli-link,
project-config, codex-role). Thử phá: xoá một link → doctor báo `SKILL-DRIFT` → compile
sinh lại → sạch.

Hai test không chạy được trong worktree, **cả hai đều là hạn chế môi trường có sẵn, không
phải hồi quy**:

- `test-codex-profile.cjs` — assert `!/claude/.test(toml)` mà đường dẫn worktree chứa
  `.claude/worktrees/`. Chạy từ checkout chính: xanh. Assertion này cũng sẽ fail với bất kỳ
  ai clone repo vào đường dẫn có chữ "claude".
- `test-isolation.cjs` — cần một project đã đăng ký trong `memory/projects/`.

## Chưa làm — cần bạn quyết

1. **Vai Codex vẫn chưa có hệ skill thật.** Codex chỉ nạp skill từ plugin cài qua
   marketplace (`codex plugin marketplace add` → `codex plugin add`); máy bạn hiện chưa cấu
   hình marketplace nào. HOUSE-RULES §5 xử lý bằng cách bảo vai Codex tự đọc `SKILL.md` —
   chạy được nhưng là đọc file, không phải skill system. Muốn đúng chuẩn thì alp-code phải
   tự thành Codex plugin (`.codex-plugin/plugin.json` + marketplace cục bộ).
2. **23 tham chiếu treo** tới 7 skill chưa nhúng: `alp:cook` (12, hầu hết trong `alp-plan`
   ở bước bàn giao sang implement), `alp:chrome-devtools` (5), `alp:journal` (2), `alp:test`,
   `alp:sequential-thinking`, `alp:project-organization`, `alp:mcp-management`. Đều là bước
   tuỳ chọn và `alp-debug` đã có fallback tử tế. Nhúng thêm hay sửa văn bản?
3. **`Skill` vẫn không nằm trong `KNOWN_TOOLS`** (`lib/loadout.cjs:210`) nên không bao giờ bị
   deny. Không còn nguy hiểm như trước — symlink đã giới hạn được vai thấy skill nào — nhưng
   một vai vẫn gọi được skill user/plugin cài ngoài repo.
4. **`librarian` mâu thuẫn ACL**: PLAYBOOK bước 5 bảo ghi `memory/shared/reference/` nhưng
   `memory.write: []`. Vai sẽ bị chặn ở đúng bước cuối quy trình của nó.
5. **`titling` thừa grant**: có `workspaces.read` nhưng `tools: []` → không đọc được gì.
6. **`~/StudioProjects/alp-plugin` không tồn tại** trên máy; 6/8 vai đang khai workspace này.

---

# Phần 2 — Custom skill cho alp-code (2026-08-22)

Commit `84fa7de` → `22c5e75`. Dịch tiếng Việt + viết lại theo quy trình alp-code.

## Vì sao phải viết lại, không chỉ dịch

Skill nhúng từ alp-plugin giả định một môi trường alp-code không có:

| Giả định | Thực tế alp-code |
|---|---|
| `AskUserQuestion` tool | không có. Main nói chuyện trực tiếp với principal |
| slash command `/alp-plan`, `/scout`, `/alp:cook` | không có hệ command |
| spawn subagent qua `Task` | **không vai nào có `Task`**. Giao việc qua `run-role`/herdr = phiên riêng |
| `TaskCreate`/`TaskUpdate`/`TodoWrite` | không có hệ task. `plan.md` là nguồn sự thật |
| hook inject `## Naming`, `## Plan Context` | hook alp-code chỉ inject thẻ danh tính + PROJECTS L0 + tín hiệu doctor |
| `.claude/.alp.json`, `docs/development-rules.md` | không tồn tại |
| `node scripts/…` (tương đối theo cwd) | CWD phiên là `identity/<role>/` → phải `.claude/skills/<tên>/scripts/…` |
| `set-active-plan.cjs`, `ck plan create` | không có |

## Nguyên tắc viết lại

**Mỗi skill giờ chỉ thuộc đúng một vai** (theo `skills:` trong loadout), nên viết thẳng cho
vai đó thay vì viết chung chung — kèm ranh giới ACL thật của vai:

| Vai | Skill | Ranh giới ghi vào skill |
|---|---|---|
| review | code-review · alp-scenario · security-scan | không `Edit`/`Write`, `delegates_to: []`, một concern mỗi phiên |
| oracle | alp-predict · problem-solving · alp-debug | không sửa được gì → sản phẩm là khuyến nghị, không phải bản vá |
| search | gkg | chỉ index workspace trong loadout, không MCP |
| librarian | research · docs-seeker | ngân sách 5 lượt tìm, `memory.write: []` |
| main | alp-plan · git | vai duy nhất có `Write`; cổng chặn commit/push/merge |

**Thống nhất thang mức** CHẶN / NÊN SỬA / GHI NHẬN giữa `code-review`, `alp-scenario`,
`security-scan`, `red-team-personas` — main không phải quy đổi giữa bốn báo cáo.

## Xoá

| Xoá | Vì sao |
|---|---|
| skill `scout` | toàn bộ tiền đề là spawn agent song song chia thư mục. Không vai nào có `Task`, và vai `search` **chính là** scout của hệ này. Giữ lại là mời một vai đi thử thứ nó không làm được |
| `alp-plan/references/task-management.md` | không có hệ task |
| `alp-plan/references/workflow-modes.md` | mode `--parallel`/`--two` dựa trên spawn researcher |
| `alp-debug/references/task-management-debugging.md` | như trên |
| `alp-debug/references/frontend-verification.md` | cần `chrome-devtools` + `mcp-management`, chưa nhúng |
| `code-review/references/requesting-code-review.md` | `review` **thực hiện** review, không đi xin |
| `gkg/references/mcp-tools.md` | `search` không có MCP |

## Sửa theo thực tế repo, không theo tài liệu gốc

- **`commit-standards.md`**: bản gốc **cấm** attribution AI. alp-code có `Co-Authored-By`
  ở 5/8 commit gần nhất → sửa theo lịch sử repo. Lịch sử là nguồn sự thật, không phải tài liệu.
- **`gh-cli-guide.md`**: **bỏ** hai mẫu của bản gốc — `gh pr create --fill && gh pr merge
  --auto --squash` và đóng hàng loạt PR bằng `xargs`. Cả hai vi phạm HOUSE-RULES §1.2:
  thao tác khó đảo ngược, hàng loạt, không có bước dừng.
- **`plan-organization.md`**: viết lại theo format **thật** của repo
  (`plans/YYMMDD-HHMM-slug/`, frontmatter 6 trường) thay vì format 12 trường của alp-plugin.
  Bỏ `priority`/`effort`/`tags`/`branch`/`issue` — chúng chỉ có nghĩa khi có dashboard đọc.

## Con số

71/71 file `.md` đã dịch và custom. 12 SKILL.md + 46 reference/workflow còn lại sau khi
xoá 7 file.

## Kiểm chứng

`doctor` sạch · `test-skill-links` 18 ca · 7/7 test khác xanh. `compile-acl --check` báo 8
`PROFILE-DRIFT` — **đúng như mong đợi**: `~/.codex/*.config.toml` đã được khôi phục trỏ về
checkout chính, nên nhìn từ worktree thì lệch. Không có `ACL-DRIFT` hay `SKILL-DRIFT` nào.

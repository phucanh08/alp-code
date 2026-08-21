# DELEGATION — Phở giao việc cho vai khác

> Nạp khi sắp giao việc, không nạp dự phòng. Bản rút gọn cho agent:
> `identity/_shared/DELEGATION.md`. Khuôn prompt sáu mục cũng ở đó.
> Kiểm chứng trên herdr **0.8.0**, codex-cli **0.149.0**, Claude Code **2.1.238**.

---

## 1. Ba đường, chọn theo HÌNH DẠNG việc

| Hình dạng việc | Đường | Lệnh |
|---|---|---|
| ≥2 vai song song · >1 phút · cần theo dõi/tương tác · review nhiều concern | **pane herdr** | `run-role <role> --pane` |
| Một câu hỏi · đồng bộ · <1 phút · **hoặc không có fleet** | **exec** | `run-role <role> --exec` |
| Principal tự ngồi vào phiên đó | tương tác | `run-role <role>` |

Luật này là **code**, không phải lời khuyên: `scripts/lib/herdr-fleet.cjs:route()` là nơi
duy nhất quyết định, `scripts/test-delegation.cjs` giữ nó khỏi trôi. Vì sao phải cứng: luật
định tuyến sai **không gây lỗi** — nó chỉ khiến cùng một hình dạng việc đi hai đường khác
nhau giữa hai phiên, và đó đúng là lúc khó debug nhất.

```bash
scripts/run-role.sh search --project ~/code/api --pane -- "Tìm call-site của verifyToken"
scripts/run-role.sh read-thread --exec -- "Có decision nào về ACL của Bash chưa?"
scripts/run-role.sh oracle --project ~/code/api --pane --kind claude -- "Phản biện migration"
```

`--pane` in ra pane id, nhãn agent, lệnh theo dõi và lệnh trả quyền:

```
PANE      w5:p3
AGENT     search-8f2a (codex)
WATCH     herdr pane read w5:p3 --lines 30
RELEASE   node .../run-role.cjs search --release w5:p3
```

**Không có fleet ⇒ `--pane` tự rơi về `--exec`**, in `NOTE` kèm lý do. Phiên headless
không có pane để mở, và bắt principal xử lý khác biệt đó là bắt sai người. Ngược lại,
fleet **có** mà spawn hỏng thì launcher **dừng** — im lặng rơi về `--exec` khi pane có thể
đã tạo dở sẽ chạy việc hai lần.

---

## 2. Trả quyền — chỗ dễ hỏng nhất

```bash
scripts/run-role.sh <role> --release <pane>
```

Không gõ `herdr pane release-agent` trần. Ba sự thật đã đo, mỗi cái đều hỏng **im lặng**:

| # | Hành vi | Hậu quả |
|---|---|---|
| 1 | `release-agent` **thiếu `--seq`** → exit 0, state **không đổi** | tưởng đã trả quyền, panel kẹt `working` mãi |
| 2 | `--seq` phải **tăng nghiêm ngặt**; seq cũ hoặc **bằng** bị bỏ qua, exit 0 | báo cáo trạng thái biến mất không dấu vết |
| 3 | `report-agent` **không nhận** `done` — `done` là state herdr tự suy ra | giữ quyền bằng seq cao **đè mất** `done` |

Launcher sinh seq bằng `Date.now()` (chốt tăng dần trong process): đơn điệu qua nhiều
tiến trình, không cần file state, và model không có cửa để đếm sai.

Quên trả quyền thì `alp doctor` bắt được:

```
ORPHAN-PANE      pane w5:p3 (search-8f2a) còn báo `working` nhưng tiến trình đã chết
                 → fix: node scripts/run-role.cjs search --release w5:p3
```

Dấu hiệu "tiến trình đã chết": `foreground_process_group_id == shell_pid` — pane đã về dấu
nhắc shell trong khi panel vẫn báo `working`.

---

## 3. Bốn bẫy của herdr mà wrapper đã bịt

Đừng viết lại `pane split` + `agent start` bằng tay; bốn thứ này sẽ phải làm lại từ đầu.

**1 — `agent start` cần pane đã ở dấu nhắc shell.** Gọi ngay sau `pane split` thì dính
`agent_pane_busy: not an available shell`. Và `foreground_process_group_id == shell_pid`
mới là điều kiện **cần**: shell đang source `.zshrc` cũng thoả. Điều kiện đủ chỉ herdr
biết, nên wrapper chờ hai lớp — poll `process-info`, rồi **thử lại chính `agent start`**
khi nó vẫn kêu bận. Thực đo: lần thử thứ hai (~300ms sau) đã qua.

**2 — herdr từ chối arg có xuống dòng.**

```
invalid_agent_argument: agent arguments cannot be encoded safely for the target shell
```

Backtick, `#`, nháy thì qua được — chỉ newline bị chặn. Mà prompt delegation **luôn**
nhiều dòng (khuôn sáu mục + contract ủy nhiệm). Wrapper ghi prompt ra
`$TMPDIR/alp-delegation/<label>-<i>.md` rồi thay bằng một dòng trỏ tới file.

**Dòng thay thế phải mang NGUỒN ỦY NHIỆM**, không chỉ đường dẫn. Rút gọn thành "đọc file X
rồi làm" là vai phụ thấy một nhiệm vụ không rõ nguồn và từ chối theo luật main-only — đã
đo thật: Titling trả lời *"Mình là Titling, chỉ nhận nhiệm vụ từ Phở"* rồi ngồi im.

**3 — trust-gate của hook Codex.** Profile chưa duyệt thì Codex **chặn ở dialog "Hooks need
review"** (phiên có TUI) hoặc **bỏ qua hook im lặng** (headless). Cả hai đều là vai vào việc
mà không có danh tính. `--exec` và `--pane` đều kèm `--dangerously-bypass-hook-trust`; phiên
tương tác do principal mở thì **không** — họ trả lời được, và đó là một prompt bảo mật thật.

**4 — `--timeout` của `agent start`** phải `> 3000ms` và `≤ 300000ms`, ngoài khoảng là
`invalid_agent_timeout`.

Bản herdr đã kiểm chứng nằm ở `herdr-fleet.cjs:VERIFIED_VERSION`. Lệch bản thì
`alp doctor` báo `HERDR-VERSION` — CLI này đổi giữa các minor (0.7→0.8 xoá cả nhóm `wait`,
bỏ `agent send`, đổi hẳn `agent start`).

---

## 4. Chống đệ quy — vai phụ không spawn được vai khác

`delegates_to` rỗng ⇒ `acl-guard` chặn `herdr` và `run-role` ở **vị trí lệnh**:

```
[acl-guard] search không được spawn vai khác (`herdr`) — chống đệ quy delegation,
chỉ `main` giao việc
```

Không có phanh này thì Search spawn được Search: vòng lặp đốt quota không có ai ngồi giữa
để cắt.

**Khớp theo tên lệnh, không theo chuỗi con** — có bóc tiền tố `VAR=x` và wrapper
(`node …/run-role.cjs`). `grep herdr docs/` vẫn chạy được: chặn cả lệnh đọc chỉ dạy agent
tìm đường vòng.

Lớp thứ hai ở `settings.json` (`deny` cho vai phụ, `allow` cho main). Nó **không đủ một
mình**: luật `Bash(...)` khớp theo tiền tố chuỗi, không resolve lệnh — hook mới là lớp
enforce thật. Hai lớp phải nói cùng một điều; `test-isolation.cjs` kiểm cả hai.

Main được `allow` sẵn hai luật đó nên **không hỏi permission mỗi lần**. Hỏi từng lần thì
"tự delegate" chỉ là đổi chỗ cho principal gõ lệnh.

---

## 5. Phanh chi phí

Ba cái, ở `identity/main/PLAYBOOK.md` §3:

1. **Một dòng TRƯỚC khi chạy** — `→ giao Search: tìm call-site auth`. Principal thấy quota
   đi đâu ngay lúc nó đi, không phải sau khi đã tiêu.
2. **Trần 3–4 phiên đồng thời.** Hết trần thì Phở tự làm, không xếp hàng.
3. **Cuối lượt liệt kê vai đã gọi**, kèm kết quả dùng được hay không.

Và luật nền: **việc <5 phút thì tự làm.** Mỗi vai khởi động từ con số không và phải suy
luận lại bối cảnh Phở đã có sẵn — spawn cho việc nhỏ là lỗ ròng.

---

## 6. Chọn vai nào

`identity/main/RELATIONS.md`. Tóm tắt: nguồn câu trả lời ở **code local** → Search ·
**ngoài/cross-repo** → Librarian · **trong memory** → Read Thread · cần kiểm
security/correctness/performance → mỗi concern một phiên Review · bế tắc hoặc quyết định
rủi ro cao → Oracle · thread dài cần handoff → Compaction · cần title → Titling.

Chọn model/effort thì **không phải việc của người gọi**: cả hai nằm trong
`$CODEX_HOME/<role>.config.toml` do `compile-acl` sinh từ loadout. Xem
[`model-routing.md`](model-routing.md).

— Phở 🍜

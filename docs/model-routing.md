# MODEL ROUTING — Chọn model nào cho việc nào

> Phở dùng **hai runtime** song song: Claude Code (phiên này) và Codex CLI (`codex`, đã cài).
> File này trả lời: *việc này giao cho model nào, ở effort nào, qua đường nào.*
> Nạp khi sắp spawn agent hoặc khi principal hỏi "dùng model gì".
> Kiểm chứng 2026-08-14 — Claude: skill `claude-api`. Codex: docs OpenAI (giá, hướng dẫn chọn)
> + `~/.codex/models_cache.json` (slug, effort, bản đang cài). Nguồn ưu tiên: mục 7.

---

## 1. Hai provider, một cách giao việc

| | Claude Code | Codex CLI |
|---|---|---|
| Bản | phiên hiện tại, model mặc định `opus` | `codex-cli 0.149.0` |
| Giao role ALP | `alp delegate <role>` | `alp delegate <role>` |
| Chọn model | loadout của role | **profile** sinh từ loadout |
| Effort | ẩn (theo alias) | **profile** (`model_reasoning_effort`) |
| Kết quả | `DelegationResult` | `DelegationResult` |
| Chạy dài | backend execution | backend execution |

Backend được chọn bằng config và adapter có thể dùng Herdr hoặc Paseo. Business code không
gọi runtime trực tiếp; ALP policy/context luôn chạy trước backend.

**Vai đã có loadout thì KHÔNG truyền model/effort bằng tay.** Model — cộng sandbox,
approval, web search và hook boot — nằm trong `$CODEX_HOME/<role>.config.toml` do
`compile-acl` sinh từ `loadout.yaml`; launcher chỉ gọi `codex -p <role>`. Flag `-m`/`-c`
chỉ dùng cho thử nghiệm admin ad-hoc, không phải delegation của role (mục 6).

**Ràng buộc quan trọng:** `Agent` tool chỉ nhận `model` ∈ `opus` · `sonnet` · `haiku` · `fable`.
Không spawn được subagent trên Opus 4.8, Sonnet 4.6 hay bất kỳ ID cụ thể nào — muốn model khác
phải đi qua API/Codex.

---

## 2. Model Claude — bảng chọn

| Model | ID | Ctx | $ in/out /1M | Mạnh nhất ở | Yếu / cạm bẫy |
|---|---|---|---|---|---|
| **Fable 5** | `claude-fable-5` | 1M | 10 / 50 | Bài toán khó nhất, long-horizon nhiều giờ | Đắt gấp đôi Opus; **thinking luôn bật**, không tắt được; **cần data retention 30 ngày** (org ZDR → 400 mọi request); lượt chạy có thể dài nhiều phút |
| **Opus 5** | `claude-opus-5` | 1M | 5 / 25 | **Mặc định của Phở.** Agentic coding đa file, refactor lớn, code review (recall + precision cao), điều phối subagent | Viết dài (cả câu trả lời lẫn file trên đĩa); **tự mở rộng scope**; delegate subagent quá tay; tự verify sẵn → mọi lệnh "double-check" đều phản tác dụng |
| **Sonnet 5** | `claude-sonnet-5` | 1M | 3 / 15 | Gần Opus ở coding/agentic, rẻ hơn 40%. Khối lượng lớn, production | Tokenizer mới → ~30% token nhiều hơn Sonnet 4.6 (giá/token không đổi nhưng chi phí thực đổi); bám chữ nghĩa rất sát |
| **Haiku 4.5** | `claude-haiku-4-5` | 200K | 1 / 5 | Phân loại, trích xuất, đọc-và-tóm nhiều file, worker trong multi-agent | 200K context — chỉ 1/5 các model trên; không hợp reasoning nhiều bước |

Giá là rate first-party. Sonnet 5 có giá giới thiệu 2/10 đến 2026-08-31.

### Effort — cần lưu ý

Tất cả model hiện tại nhận `output_config.effort`: `low` · `medium` · `high` · `xhigh` · `max`.
Mặc định `high`.

- **Opus 5:** khởi điểm `xhigh` cho coding/agentic, `high` cho việc còn lại — rồi **quét xuống**.
  `low`/`medium` mạnh bất thường trên model này; default kế thừa từ model cũ hầu như luôn sai.
- **Effort KHÔNG rút ngắn output.** Muốn ngắn thì viết vào prompt, đừng hạ effort.
- `xhigh`/`max` → đặt `max_tokens` ≥ 64K, không thì cụt giữa chừng.

---

## 3. Model Codex — bảng chọn

> **Nguồn: docs OpenAI.** Giá lấy từ `developers.openai.com/api/docs/pricing`,
> hướng dẫn chọn model từ `learn.chatgpt.com/docs/models` (Codex → Models).
> Không dùng blog bên thứ ba cho phần này — chúng mâu thuẫn nhau và đã sai một lần.

Ba model GPT-5.6, cùng context ~1.05M, cùng thang effort `low`→`ultra`
(riêng Luna hết ở `max`). `ultra` = suy luận tối đa **kèm tự uỷ thác việc**.

| Model | slug | in / cached / out (short ctx) | Effort mặc định |
|---|---|---|---|
| **Sol** | `gpt-5.6-sol` | 5.00 / 0.50 / 30.00 | `low` |
| **Terra** | `gpt-5.6-terra` | 2.00 / 0.20 / 12.00 | `medium` |
| **Luna** | `gpt-5.6-luna` | 0.20 / 0.02 / 1.20 | `medium` |

USD trên 1M token. **Long context ≈ gấp đôi** mọi mức (Sol 10/1/45 · Terra 4/0.40/18 ·
Luna 0.40/0.04/1.80). Cached input rẻ hơn 10 lần — prompt lặp lại rất đáng cache.

Hướng dẫn chọn, theo lời OpenAI:

- **Sol** — việc mơ hồ, khó, hoặc giá trị cao, cần thêm phân tích/phán đoán/độ trau chuốt:
  thay đổi code phức tạp, **nghiên cứu sâu**, tài liệu cần bóng bẩy. Với việc hẹp thì
  nên định nghĩa rõ "thế nào là xong" để nó khỏi lan man.
- **Terra** — "pragmatic all-rounder". Điểm khởi đầu cho việc trước đây chạy GPT-5.5.
- **Luna** — trích xuất, phân loại, biến đổi, tóm tắt có cấu trúc. Dùng khi **đã biết
  trước kết quả tốt trông thế nào**.

Effort: `low` cho việc hẹp và rõ · `medium` khi cần lập kế hoạch · `high`/`xhigh` cho
việc nhiều bước hoặc có đánh đổi. OpenAI nói rõ **không có ánh xạ 1-1 từ effort của GPT-5.5**.

Đã deprecated, đừng dùng mới: `gpt-5.4` (→ Terra), `gpt-5.4-mini` (→ Luna).
`gpt-5.5` còn chạy nhưng thang effort dừng ở `xhigh`.

---

## 4. Ma trận định tuyến

**Luật phân chia (principal chốt 2026-08-14).** Hai runtime chạy **song song, độc lập**:

> **Codex** → nghiên cứu sâu, và khi cần phương án sáng tạo hơn.
> **Claude Code** → mọi việc còn lại.

Đây là ranh giới theo **loại việc**, không theo độ khó. Một bài khó thuộc loại thực thi
vẫn ở Claude Code; một câu hỏi dễ nhưng cần đào sâu vẫn sang Codex.

| Việc | Giao cho |
|---|---|
| **Nghiên cứu sâu** — đào một chủ đề tới đáy, nhiều nguồn | `codex exec -m gpt-5.6-sol` |
| **Cần phương án sáng tạo hơn** — bí hướng, muốn cách tiếp cận khác | `codex exec -m gpt-5.6-sol` |
| Context summarization cho thread dài | Compaction · `gpt-5.6-sol` · `medium` |
| Fast title generation cho thread | Titling · `gpt-5.6-luna` · `low` |
| Tìm code local | Search · `gpt-5.6-terra` · `low` |
| Code review theo một concern | Review · `gpt-5.5` · `medium` |
| Khảo sát rộng nhưng nông, chỉ cần kết luận | `codex exec -m gpt-5.6-terra` |
| — *ranh giới* — | |
| Điều phối, giữ bức tranh tổng thể | **Phở (Opus 5)** — tự làm |
| Quét file diện rộng trong repo | `Explore` |
| Triển khai feature đa file, refactor lớn | `Agent(model: "opus")` |
| Sản xuất số lượng lớn, việc lặp | `Agent(model: "sonnet")` |
| Phân loại / trích xuất / tóm tắt hàng loạt | `Agent(model: "haiku")` |
| Review, test, debug, docs, git | agent `alp:*` tương ứng |
| Bài toán bế tắc, cần năng lực tối đa | `Agent(model: "fable")` — ⚠️ **hỏi principal trước mỗi lần** |

**Ngân sách** _(principal chốt 2026-08-14)_: **Sol cứ dùng** theo luật trên, không hỏi lại
từng lần. **Fable 5 hỏi trước mỗi lần**, kèm lý do vì sao Opus 5 không đủ.

**Nguyên tắc trên hết:** việc <5 phút thì Phở tự làm. Mỗi subagent khởi động từ con số không
và phải suy luận lại bối cảnh Phở đã có sẵn — spawn cho việc nhỏ là lỗ ròng. Luật trên chia
việc **đã quyết là phải giao**, không phải cái cớ để giao nhiều hơn.

**Vì sao chia thế này:** Codex không mạnh hơn — nó **sai khác đi**. Prior khác nghĩa là
hướng khác, và đó đúng là thứ cần khi đào sâu hoặc khi đang bí. Ngược lại, việc thực thi
cần bối cảnh liên tục và công cụ tại chỗ — Claude Code giữ cả hai, Codex thì không.

**Codex là tiến trình rời.** Nó không thấy context phiên này. Prompt gửi sang phải **tự đủ**:
nêu mục tiêu, đường dẫn, cái đã thử, định dạng output mong muốn. Và Phở vẫn phải đọc lại
kết quả bằng mắt mình trước khi báo cáo lên — luật kiểm chứng không có ngoại lệ cho vendor.

---

## 5. Cạm bẫy Opus 5 — vì Phở đang chạy trên nó

Bốn thứ ảnh hưởng trực tiếp tới prompt Phở gửi subagent:

1. **Xoá mọi lệnh "hãy tự kiểm tra lại".** Opus 5 đã tự verify. Bảo nó verify → verify thừa,
   không tăng chất lượng. Đây là chỗ best-practice cũ bị **đảo ngược**.
2. **Nói rõ phạm vi.** Nó có xu hướng thêm bước không ai yêu cầu. Prompt phải chốt biên.
3. **Nói rõ độ dài.** Mặc định viết dài — cả câu trả lời lẫn file `.md` sinh ra.
4. **Đặt trần số subagent.** Nó delegate hăng hơn Opus 4.8. Ngược hẳn thế hệ trước —
   hướng dẫn "hãy delegate nhiều hơn" viết cho 4.8 nay phải gỡ.

Nếu subagent bị tắt thinking: nó có thể viết tool call thành **văn bản thường** — lệnh
không chạy, không báo lỗi, turn vẫn "thành công". Đừng tắt thinking; hạ effort thay vì tắt.

---

## 6. Lệnh mẫu

```bash
# Nghiên cứu sâu — Sol, effort cao
codex exec -m gpt-5.6-sol -c model_reasoning_effort="xhigh" "<prompt tự đủ bối cảnh>"

# Cần hướng khác khi đang bí
codex exec -m gpt-5.6-sol "Here is the approach I'm stuck on: <...>. \
Propose 3 fundamentally different approaches. Do not refine mine."

# Khảo sát rộng nhưng nông
codex exec -m gpt-5.6-terra "<prompt>"

# Vai đã có loadout — launcher tự lấy cả model lẫn effort từ profile
alp delegate compaction -- "<thread/context bundle>"
alp delegate titling -- "<thread/context bundle>"
alp delegate review --project ~/code/api --background -- "<concern>"
```

Việc dài hoặc chạy song song dùng `--background`, rồi theo dõi bằng
`alp delegation status|wait <execution-id>`. Việc đồng bộ bỏ `--background`.

**Profile thiếu thì `codex -p` KHÔNG báo lỗi** — nó im lặng chạy mặc định, mà mặc định của
`codex exec` là `workspace-write`. `run-role` chặn trước ở chỗ đó; `alp doctor` báo
`CODEX-PROFILE-MISSING`/`-DRIFT` khi profile lệch hoặc chưa sinh, kèm dòng `→ fix:`.
Sửa loadout xong luôn chạy `compile-acl.sh`.

**`main` cũng chạy được qua launcher** (`scripts/run-role.sh main -- "<việc>"`) — đường phụ
khi muốn tiết kiệm quota Claude. Hai chỗ khác vai phụ, nhớ khi đọc loadout của main:

- Model lấy từ **`codex_model:`** (`gpt-5.6-sol`), không phải `model:` — `model:` là
  `claude-opus-5`, model của runtime **chính**. Đưa nó cho `codex -m` là hỏng câm.
- Sandbox là `workspace-write`, nhưng **chỉ** ở repo alp-code hoặc trong `workspaces.write`.
  Ở cwd lạ main vẫn `read-only` như mọi vai khác.

Đổi lại, Codex không nạp được skill `alp:plan`/`alp:cook` (marketplace của Claude Code) —
việc cần hai skill đó thì phải chạy main trên Claude.

Trong phiên tương tác: `/model` để đổi model và effort.

Trong Claude Code: `Agent(subagent_type: ..., model: "sonnet"|"opus"|"haiku"|"fable")`.
Bỏ `model` → kế thừa model của Phở (`opus`).

---

## 7. Khi nào file này sai

Model đổi nhanh hơn tài liệu. Kiểm lại khi:

- `~/.codex/models_cache.json` có `fetched_at` mới hơn 2026-08-14 → đọc lại mục 3.
- Có model Claude mới → skill `claude-api` là nguồn thật, không phải file này.

**Nguồn ưu tiên khi cần tra lại:**

| Cần gì | Tra ở đâu |
|---|---|
| Model / giá Codex | `developers.openai.com/api/docs/pricing` · `learn.chatgpt.com/docs/models` |
| Model / giá Claude | skill `claude-api` (nạp trước, đừng trả lời từ trí nhớ) |
| Model Codex đang cài | `~/.codex/models_cache.json` |

**Không dùng blog bên thứ ba cho giá Codex.** Bản đầu của file này lấy giá Terra/Luna từ
blog và sai — docs OpenAI cho số khác hẳn (Terra 2/12 chứ không phải 2.50/15).

— Phở 🍜

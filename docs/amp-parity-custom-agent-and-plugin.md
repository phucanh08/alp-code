# Đối chiếu Amp: custom agent và plugin

> **Status:** Draft · **Ngày:** 2026-09-10 · **Owner:** anhlp
> **Quan hệ với doc khác:** `alp-design-philosophy-and-vision.md` §5 (custom agent) và §8 (hoãn
> plugin) được viết **trước** khi mô hình mở rộng của Amp được kiểm chứng bằng tài liệu. Doc này
> ghi lại những gì Amp thật sự làm, đối chiếu với ALP, và chốt phần quyết định. Khi hai doc mâu
> thuẫn về **sự thật của Amp**, doc này đúng; về **hướng của ALP**, vision doc đúng.

---

## 1. Vì sao cần doc này

Vision §5 đặt ra một giả định ngầm: custom agent là **file dữ liệu declarative**, và đó là con
đường tự nhiên mà một hệ agent đi khi muốn cho principal viết identity. §8 thì hoãn plugin với lý
do "plugin đóng gói hook và MCP config là arbitrary code execution".

Cả hai câu đều đứng vững, nhưng cả hai đều được viết mà không kiểm tra Amp — hệ mà ALP mượn ý
tưởng **nấc** (`src/agents/modes.ts`) và mượn cả cách chia vai specialist. Hoá ra Amp đi **ngược
lại** giả định của §5. Biết chính xác nó đi đường nào, và vì sao ALP không đi được đường đó, là
điều kiện để §5 không phải một lựa chọn mặc định mà là một lựa chọn có đối chứng.

---

## 2. Amp thật sự làm gì

### 2.1. Không có file agent declarative

Amp **không có** `agent.yaml`, cũng không có markdown + frontmatter cho agent definition. Thứ
duy nhất gần giống là `AGENTS.md` — nhưng đó là **instruction context của project**, không phải
identity: nó không khai tool, model, memory hay workflow.

Custom agent ở Amp chỉ tồn tại **bên trong plugin**, và plugin là **code TypeScript**.

### 2.2. Plugin là code, không có manifest

| Khía cạnh | Amp |
|---|---|
| Manifest | **Không có.** Entry point là một file `.ts`/`.js`, hoặc `<plugin-name>/index.ts` |
| Contract | `export default function (amp: PluginAPI): void \| Promise<void>` |
| Nguồn nạp | project `.amp/plugins/` · system `$XDG_CONFIG_HOME/amp/plugins/` (mặc định `~/.config/amp/plugins/`) · personal (Personal Settings) · workspace (Workspace Settings) |
| Thứ tự ưu tiên | project → system → personal → workspace |
| CLI | `amp plugins add <url>` · `list` · `repositories` · `import` · `update`; `amp clone user-plugins` / `workspace-plugins` |
| MCP | Plugin **không** chứa MCP server, chỉ tham chiếu tới server đã có |

### 2.3. `PluginAPI` đăng ký được những gì

| Nhóm | API |
|---|---|
| Tool | `registerTool({ name, description, inputSchema, execute(input, ctx) })` |
| Skill | `await registerSkill({ path })` — path tương đối tới thư mục có `SKILL.md` |
| Command | `registerCommand(id, { title, category?, description? }, handler)` |
| Agent mode | `registerAgentMode({ key, label, description?, color?, agent })` — plugin ngoài phải có comment metadata `// @amp-agent-mode` |
| Agent | `createAgent(config)` → `Agent` với `createThread()` / `run()`; `getBuiltinAgent(mode)` |
| Event | `on('session.start' \| 'agent.start' \| 'agent.end' \| 'tool.call' \| 'tool.result', handler)` — `tool.call` **chặn/sửa được**, `tool.result` sửa được |
| AI | `ai.ask(question)` → `{ result: yes\|no\|uncertain, probability, reason }`; `ai.generate(...)` |
| UI | `ctx.ui.notify / input / confirm / select` |
| Thread | `append`, `appendUserMessage`, `messages`, `waitForResponse`, `cancel`, `setVisibility`, `agent` |
| Khác | `$` (shell tagged template), `logger`, `system.*`, `attachments.upload`, `createWebhook`, `onDispose` |

### 2.4. `createAgent` — trường của nó

```ts
amp.createAgent({
  name?,                                    // identity đưa vào system prompt
  extends?,                                 // 'low' | 'medium' | 'high' | 'ultra'
  model?,                                   // vd 'anthropic/claude-sonnet-4-6'
  instructions?,                            // nối vào base prompt
  tools?,                                   // 'all' | string[] | { include?, add?, exclude? }
  reasoningEffort?,                         // 'none'…'max'
  oracle?, subagents?,                      // AgentSubagentPin: ghi đè model/effort
  features?,                                // thread feature bắt buộc
  display?,                                 // { label, color? }
})
```

Một agent tạo ra rồi được dùng theo hai cách, không loại trừ nhau:

- `registerTool(...)` bọc nó ⇒ nó là **subagent** mà main agent gọi khi cần.
- `registerAgentMode(...)` ⇒ nó là **mode** principal chọn được trong picker.

---

## 3. Ba điểm lệch cấu trúc với ALP

### 3.1. Amp vừa là surface vừa là runtime; ALP thì không

`registerTool` và `on('tool.call')` chạy được vì vòng lặp model sống **trong chính process Amp**.
ALP là launcher (§0): vòng lặp nằm trong process con `claude`/`codex` mà ALP không sở hữu. Một
`registerTool` kiểu Amp ở ALP sẽ không có host để chạy — trừ khi ALP tự dựng một runtime, tức là
trở thành đúng thứ §8 nói nó không phải.

Đường tương đương duy nhất ALP **đã có** là hook bridge: `src/hooks/execution-bridge.ts` và
`alp hook`. Nó chính là nơi `session.start` và `tool.call` của Amp ánh xạ tới. Nói cách khác,
ALP không thiếu "event surface" — nó thiếu **cách để principal khai một handler mà không phải
là arbitrary command**.

### 3.2. `createAgent` trả handle chạy được; ALP trả definition

Ở Amp, `createAgent` trả về vật thể gọi `run()` được ngay. Ở ALP, thứ tương đương là
`AgentDefinition` + `DelegationService` — cố ý tách, vì mỗi execution phải đi qua policy snapshot,
identity capsule và execution record. Đây **không** phải khoảng cách cần lấp: đó là chỗ ALP đắt
hơn một cách có chủ ý.

Điểm trùng đáng ghi nhận: `extends: 'low' | 'medium' | 'high' | 'ultra'` của Amp chính là **nấc**
ALP đã có, và ALP còn đi xa hơn một bước (nấc ghim model cho **mọi** vai, và model quyết định
runtime — §4.1 architecture).

### 3.3. Amp không có mô hình tin cậy cho plugin; ALP tự nhận fail-closed

Plugin Amp chạy full quyền trong process Amp: không signing, không sandbox, không capability
grant cho chính plugin. Với Amp đó là lựa chọn nhất quán — nó là một product, principal cài
plugin của chính mình hoặc của workspace mình.

Với ALP, sao chép mô hình đó là mâu thuẫn tự thân, đúng như §8 đã viết. Khác biệt không nằm ở
"ai cẩn thận hơn" mà ở chỗ ALP **bán** tính chất fail-closed: `definitionHash`, `policyHash`,
deny-first. Một plugin chạy code tuỳ ý làm ba thứ đó thành trang trí.

---

## 4. Bảng đối chiếu năng lực

| Năng lực Amp | ALP hôm nay | Khoảng cách thật |
|---|---|---|
| Custom agent | Không có | **Là §5** — đường A dưới đây |
| Agent mode picker | Nấc (`low`…`ultra`, `puck`) — nhưng là loadout **toàn team**, không phải một agent | Amp mở cho plugin đăng ký mode mới; ALP chưa. Không cấp thiết |
| Subagent qua tool | `SUBAGENT_CATALOG` rỗng (§5.5), Claude Code cấp qua `--agents <json>` | Đã có contract, chưa mở catalog. Chặn bởi tầng test 2–3 |
| Skill bundle | `skills/` built-in + `SKILL_CATALOG`; `.alp/skills/` là §5.7 | Cơ chế đã thiết kế, chưa có loader |
| Command palette | Không có (ALP không có UI thread) | Không áp dụng |
| Event hook | `alp hook session-boot`, execution bridge, PreCompact/PostCompact | **Có, nhưng không khai báo được từ ngoài** |
| MCP server | `MCP_SERVER_CATALOG` rỗng, khai theo tên + `egress` | Amp thậm chí không cho plugin chứa MCP — ALP chặt hơn nhưng cùng hướng |
| `ai.ask` / `ai.generate` | Không có | Cần một process gọi model ngoài execution — chưa có nhu cầu |
| UI prompt | Không có; approval là §6 chưa xây | Trùng một phần với §6 (`require_approval`) |
| Phân phối (registry, repo cá nhân/workspace) | Không có | Đường B dưới đây |

---

## 5. Ba đường đi, và điều kiện mở khoá

| | Nội dung | Chi phí | Điều kiện mở |
|---|---|---|---|
| **A. Custom agent declarative** | `.alp/agents/<id>/agent.yaml` theo §5.3, trust bằng hash (§5.6), tự vào `main.delegatesTo` | Vừa | `alp agent test` tầng 1–3 chạy được trên agent do principal viết (§11 quyết định 11) |
| **B. Plugin = bundle dữ liệu** | `alp plugin add <git-url>` cài một gói gồm nhiều `agent.yaml` + `skills/` + entry catalog khai **bằng tên**; lockfile hash; trust một lần cho cả gói | Vừa+ | A xong, **và** có ≥ 2 gói thật muốn dùng lại giữa các project |
| **C. Plugin có code như Amp** | PluginHost trong process ALP, event bus ánh xạ vào hook bridge, `registerTool` | Cao | §8: signing + provenance + sandbox, **và** ≥ 3 extension bên thứ ba thật |

A là tiền đề của cả B lẫn C: B chỉ là cách **phân phối** A, còn C cần A để có thứ mà đăng ký.
Thứ tự vì thế không phải sở thích, nó là phụ thuộc.

Một điều cần nói thẳng về C: phần đắt nhất **không** phải PluginHost. Chạy TS trong một worker
là việc một ngày. Phần đắt là trả lời "plugin này được đọc gì, ghi gì, gọi ra mạng chỗ nào" —
tức là dựng lại toàn bộ `AgentCapabilities` cho một chủ thể mới. Trước khi có câu trả lời đó,
C không phải tính năng chưa làm, nó là quyết định chưa được ra.

---

## 6. Quyết định

Tiếp số của §11 trong vision doc.

| # | Quyết định | Lý do |
|---|---|---|
| 12 | **Custom agent khai đầy đủ mọi trường (§5.3), không có `extends`** | File tự đọc được không cần tra vai gốc; diff của `alp agent add` in ra đúng thứ agent có, không phải delta trên một nền có thể đổi khi ALP nâng cấp built-in. Giá phải trả — trần §5.5 phải so từng trường trong loader, và file dài hơn — là giá của một nguồn sự thật duy nhất |
| 13 | **Plugin v1 (nếu làm) là bundle dữ liệu, không chứa code** | Giữ nguyên lập luận §8. Một gói chỉ gồm `agent.yaml` + `skills/` + tên catalog entry thì hash phủ được toàn bộ, và trust vẫn là một quyết định đọc được |
| 14 | **Hook bridge là event surface duy nhất; không sao chép `tool.call` interception của Amp** | Chặn/sửa tool call từ code bên thứ ba là đúng thứ policy snapshot sinh ra để loại bỏ. Cái ALP cần từ Amp ở chỗ này là *ý tưởng có event*, không phải *quyền sửa event* |
| 15 | **Không đưa `ai.ask` / UI prompt vào phạm vi custom agent** | `ai.ask` cần một đường gọi model ngoài execution — nó là primitive mới (§7), không phải tiện ích. UI prompt trùng với §6 và phải sinh ra từ `require_approval`, không từ một API riêng |

### Điều chỉnh với vision doc

- §5.8 ("YAML chứ không phải `AGENT.md`") vẫn đúng, và giờ có thêm đối chứng: hệ đi xa nhất về
  mở rộng (Amp) **cũng không** dùng markdown tự do cho identity — nó dùng code. Hai lựa chọn
  cùng loại bỏ "prompt tự do không ngân sách"; ALP chọn phía dữ liệu, Amp chọn phía code.
- §8 dòng "Plugin system / registry" nên tách làm hai, vì B và C có điều kiện mở khoá khác nhau.
- Quyết định 2 (chỉ project-scoped `.alp/agents/`) đối mặt với bằng chứng ngược: Amp có tới bốn
  scope, trong đó personal/workspace là **repo được clone về** chứ không phải file lẻ. Không đổi
  quyết định — nhưng đây chính là dấu hiệu cho thấy nhu cầu dùng lại giữa project là thật, và nó
  sẽ quay lại dưới dạng đường B chứ không phải `~/.alp/agents/`.

---

## 7. Việc sẽ làm khi bắt tay code

Theo thứ tự phụ thuộc, không phải theo giá trị:

1. `alp agent test <id>` — CLI cho tầng 1–3. Tầng 2–3 đã có dưới dạng vitest
   (`test/agents/agent-test-tiers.test.ts`, phủ 8 vai built-in), nhưng principal không chạy được
   trên agent của chính mình. Đây là điều kiện chặn theo §11 quyết định 11.
2. Loader `src/agents/loader/` — đọc `agent.yaml`, normalize, enforce trần §5.5, dựng
   `AgentDefinition` rồi đưa qua đúng `createAgentRegistry` hiện có.
3. `instructionSpec` lưu **thành dữ liệu** trên definition (§5.3), nếu không `canonicalize` hash
   hàm bằng `.toString()` và mọi custom agent sẽ ra cùng một hash.
4. Trust: `alp agent add <path>` in bảng Authority + egress + chi phí, ghi hash vào
   `~/.alp/trusted-agents.json`; load lệch hash ⇒ deny.
5. `.alp/skills/` + skill riêng của agent + `.skillref` (§5.7, quyết định 6).

Cố ý chưa làm, kể cả khi Amp có: plugin có code, `registerTool`, `tool.call` interception,
command palette, `ai.ask`, agent mode do bên thứ ba đăng ký.

---

## 8. Nguồn

- Amp — Plugins: <https://ampcode.com/docs/customize/plugins>
- Amp — Plugin API: <https://ampcode.com/docs/plugin-api>
- Amp — Custom Agents (announcement): <https://ampcode.com/news/custom-agents>
- Amp — Models and Subagents: <https://ampcode.com/docs/models-and-subagents>

Truy cập 2026-09-10. Amp không công bố schema versioning cho `PluginAPI`; các trường ở §2.3–2.4
là ảnh chụp tại ngày đó, không phải contract ổn định.

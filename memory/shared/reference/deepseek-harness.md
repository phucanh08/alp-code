---
name: deepseek-harness
type: reference
created: 2026-08-17
updated: 2026-08-17
---

# DeepSeek Harness (`dsh`) — agent harness mã nguồn mở

https://github.com/deepseek-ai/deepseek-harness · MIT · TypeScript/Node + pnpm workspace
Homepage: https://deepseek.com/harness · npm scope `@deepseek-ai/dsh-*`

Khẩu hiệu: **"Everything is a Plugin."** Repo tạo 2026-08-13, ~143k star / 14.5k fork sau 4 ngày.
Trạng thái: **developer preview**, README cảnh báo rõ **sẽ có breaking change**.
Issues và PR đều tắt — phản hồi đi qua GitHub Discussions / Discord.

## Chạy thử

```sh
npx @deepseek-ai/dsh web            # Web UI ở http://127.0.0.1:3080
# hoặc từ source: pnpm install && pnpm run build && pnpm dsh web
dsh --profile web --dump-config     # in ra cây plugin máy thật sự boot
```

## Kiến trúc — 5 ý cốt lõi

1. **Cordis** (https://github.com/cordiverse/cordis) là framework nền: plugin đóng góp
   service, typed event và **reversible effect** vào một `ctx` dùng chung. Không có "core
   đặc quyền" — model adapter, tool registry, session log, **cả agent loop** đều là plugin,
   thay được bằng config. Unload plugin thì mọi đăng ký của nó tự gỡ.
2. **Profile / bundle**: `dsh` khi chạy là một cây plugin ghép từ các layer có thứ tự.
   `dsh-base` luôn là layer đầu; `dsh-web-app` thêm web GUI, `dsh-headless` chạy one-shot.
   Patch (`cordis.patch.yml`) đè theo id từng row.
3. **Turn flow**: `turn/start → step/start → agent/pre-step → agent/request → llm/stream →
   assistant/* → tool/call → tools/{pre-execute,execute,post-execute} → step/end → turn/end`.
   Nhóm `agent/pre-step`, `agent/request`, `llm/stream`, `tools/*` là **waterfall** (phải gọi
   `next()`); `agent/turn-stopping` là serial.
4. **Session log là nguồn sự thật**: append-only, `deriveMessages()` chiếu ra history model
   thấy. Luật bất biến: **model-visible nghĩa là đã được log** — muốn thêm input model thấy
   thì phải thêm `SessionEvent`.
5. **Capability seam** = bộ ba Service Definition / Provider / Consumer. Đổi một provider là
   đổi cả sản phẩm: trỏ fs + subprocess sang remote sandbox thì Bash, PTY, LSP đi theo.

## Bản đồ code

`packages/` ~50 group (`core`, `llm`, `fs`, `shell`, `terminal`, `sandbox`, `lsp`, `mcp`,
`skill`, `subagent`, `workflow`, `jobs`, `session`, `session-query`, `compaction`, `guard`,
`hooks`, `bundle`, `host`, `client`, `sdk`, `acp`, `typert`…) · `apps/{cli,web}` ·
`python/` (SDK + JSON-RPC agent, dùng để chạy benchmark) · `native/` · `website/`.
Docs song ngữ EN/中文 trong `docs/`: `architecture.md`, `cordis-primer.md`, `cordis-tutorial/`,
`agent-lifecycle.md`, `tool-execution-pipeline.md`, `capability-seams.md`, `cookbook/`.

Đáng chú ý cho công việc của Phở:
- `packages/hooks/` có sẵn **thư viện wire-protocol Claude Code / Codex** — bridge hook hai chiều.
- `packages/extensions/` cho phép agent **tự mount/unmount plugin lúc chạy**.
- `packages/subagent/` tách contract provider khỏi tool delegation — cùng tinh thần herdr.
- Repo có `AGENTS.md`, `CLAUDE.md`, `.agents/`, `.claude/` ở root — họ viết code **cho agent đọc**.

## Vì sao quan trọng

Đây là bản tham chiếu công khai, có sản xuất thật, cho đúng bài toán Phở đang giải: điều phối
agent + plugin hoá mọi thứ. Mô hình seam và session-log-là-sự-thật đáng mượn cho [[herdr]].

## Cách áp dụng

Cần đối chiếu kiến trúc agent → đọc `docs/architecture.md` rồi `docs/capability-seams.md`.
Đừng pin version: developer preview, API sẽ vỡ. Muốn thử thì `npx`, đừng nhúng vào project thật.

## Chưa kiểm chứng

Chưa clone, chưa chạy `dsh web` trên máy. Toàn bộ nội dung trên đọc từ README + docs trên GitHub.

# Lệnh CLI của gkg

## `gkg index`

Đưa repo vào knowledge graph.

```bash
gkg index                      # thư mục hiện tại
gkg index /đường/dẫn           # đường dẫn cụ thể
gkg index --stats              # kèm thống kê
gkg index --stats stats.json   # ghi thống kê ra JSON
gkg index -v                   # log chi tiết
gkg index --threads 4          # số luồng (mặc định = số nhân CPU)
```

**Chỉ index workspace có trong `workspaces.read` của `compiled AgentDefinition`.** Index repo ngoài
danh sách là đọc thứ mình không được đọc, kể cả khi filesystem không chặn.

Tự nhận diện: đường dẫn là workspace (nhiều repo) hay một repo đơn.

Dữ liệu ra: `~/.gkg/{workspace_hash}/{project_hash}/` — **ngoài repo**, nên nó sống qua
nhiều phiên. Index lại khi code đã đổi nhiều, đừng index mỗi phiên.

## `gkg server`

```bash
gkg server start          # mặc định http://localhost:27495
gkg server start --register-mcp
gkg server stop
gkg server status
```

Cổng 27495 (`0x6b67` = "kg"). Bận thì tự rơi sang cổng khác — nên **luôn chạy
`gkg server status`** để biết cổng thật trước khi gọi API.

**Phải `gkg server stop` trước khi index lại.**

`--register-mcp` chỉ có nghĩa khi loadout cấp MCP. Không có thì gọi HTTP API qua `Bash`.

## `gkg remove`

```bash
gkg remove --workspace /đường/dẫn
gkg remove --project /đường/dẫn --workspace-folder /workspace
```

Xoá dữ liệu đã index. **Khó đảo ngược** (index lại tốn thời gian) — báo lại trước, đừng
tự dọn.

## `gkg clean`

```bash
gkg clean --dry-run     # xem trước — CHẠY CÁI NÀY TRƯỚC
gkg clean               # dọn thật
```

Luôn `--dry-run` trước. Xem nó định xoá gì rồi mới chạy thật.

## Quy trình thường dùng

**Lần đầu**

```bash
gkg index --stats
gkg server start
```

**Index lại sau khi code đổi**

```bash
gkg server stop
gkg index
gkg server start
```

**Workspace nhiều repo** — index thư mục cha:

```bash
gkg index /đường/tới/workspace
```

## Xử lý sự cố

| Vấn đề | Cách |
|---|---|
| tốn nhiều bộ nhớ | giảm `--threads` |
| index chậm | tăng `--threads`, hoặc `-v` để xem nó đang làm gì |
| xung đột cổng | `gkg server stop` trước |
| dữ liệu cũ, kết quả lạ | `gkg clean --dry-run` rồi `gkg clean` |

Chạy lâu bất thường hoặc lỗi lặp lại → **báo lại**, đừng ngồi thử đi thử lại. Giá trị của
một lượt truy xuất nằm ở tốc độ; kẹt thì trả lời bằng `rg` và nói rõ `gkg` không dùng được.

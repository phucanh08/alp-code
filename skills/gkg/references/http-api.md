# HTTP API của gkg

Base URL: `http://localhost:27495` — nhưng **kiểm cổng thật trước** bằng
`gkg server status`, vì cổng bận thì server tự rơi sang cổng khác.

Loadout không cấp MCP thì gọi API bằng `curl` qua `Bash`.

## Chỉ dùng endpoint ĐỌC

| Loại | Endpoint | Dùng |
|---|---|---|
| **Đọc** | `GET /api/info`, `/api/workspace/list`, `/api/graph/*`, `/api/events` | tự do |
| **Ghi / xoá** | `POST /api/workspace/index`, mọi `DELETE` | **không tự gọi** — báo lại |

Đây là việc truy xuất, không phải quản trị dữ liệu index. Cần index lại thì dùng
`gkg index` ở CLI (xem `cli-commands.md`), và chỉ với workspace có trong loadout.

## Thông tin server

```
GET /api/info
```

Trả về cổng và phiên bản.

## Workspace

```
GET /api/workspace/list
```

Liệt kê mọi workspace và project đã index. Chạy cái này trước khi query — nếu thứ bạn cần
chưa được index thì mọi truy vấn sau đều trả rỗng, và rỗng dễ bị đọc nhầm thành "không có
chỗ nào gọi".

## Truy vấn đồ thị — phần dùng nhiều nhất

**Tìm định nghĩa theo mẫu**

```
GET /api/graph/search?pattern=MyClass&project=/đường/dẫn
```

**Lấy node lân cận** — đi từ một định nghĩa ra các chỗ liên quan:

```
GET /api/graph/neighbors?node_id=xxx&project=/đường/dẫn
```

Đây là cặp dùng cho **phân tích ảnh hưởng**: `search` tìm symbol, `neighbors` cho biết
những gì nối vào nó.

**Dữ liệu đồ thị ban đầu**

```
GET /api/graph/initial?project=/đường/dẫn
```

**Thống kê**

```
GET /api/graph/stats?project=/đường/dẫn
```

Trả số file, số định nghĩa, số quan hệ. Dùng để kiểm nhanh xem index có đầy đủ không —
số file lệch hẳn so với `git ls-files | wc -l` nghĩa là index thiếu.

## Sự kiện thời gian thực

```
GET /api/events
```

Luồng Server-Sent Events: `gkg-connection` (trạng thái kết nối) · `gkg-event` (tiến độ
index).

Đây là luồng **không tự đóng**. Gọi bằng `curl` trong `Bash` sẽ treo phiên — thêm
`--max-time` nếu buộc phải dùng.

## Lỗi

| Mã | Nghĩa |
|---|---|
| 200 | thành công |
| 400 | request sai |
| 404 | không tìm thấy |
| 500 | lỗi server |

```json
{ "error": "…", "code": "ERROR_CODE" }
```

404 thường nghĩa là **project chưa được index**, không phải symbol không tồn tại. Kiểm
`/api/workspace/list` trước khi kết luận.

## CORS và xác thực

Chấp nhận origin localhost, không cần xác thực khi chạy cục bộ. Server này **không có lớp
bảo vệ nào** — đừng mở nó ra ngoài localhost.

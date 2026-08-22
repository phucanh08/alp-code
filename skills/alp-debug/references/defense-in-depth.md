# Phòng thủ nhiều lớp

Chốt chặn ở **mọi tầng** dữ liệu đi qua, để bug trở thành không thể xảy ra.

Nếu loadout không cấp `Edit` thì bạn không tự thêm được chốt. File này dùng để **viết
khuyến nghị**: chỉ ra nên chặn ở đâu, mỗi chỗ chặn cái gì, và vì sao một chỗ là không đủ.

## Nguyên lý

Sửa một bug do dữ liệu sai, thêm một chỗ kiểm là thấy đủ. Nhưng một chỗ kiểm bị vượt qua
bởi: đường code khác, refactor sau này, hoặc mock trong test.

```
Một chỗ kiểm    → "đã sửa bug"
Nhiều tầng chốt → "bug không thể xảy ra"
```

Mỗi tầng bắt được loại khác nhau — đó là lý do cần nhiều tầng, không phải vì thừa.

## Bốn tầng

### Tầng 1 — chặn ở cửa vào

Từ chối input sai rõ ràng, ngay ở ranh giới API.

```js
function createProject(name, workingDirectory) {
  if (!workingDirectory || workingDirectory.trim() === '')
    throw new Error('workingDirectory không được rỗng');
  if (!existsSync(workingDirectory))
    throw new Error(`workingDirectory không tồn tại: ${workingDirectory}`);
  if (!statSync(workingDirectory).isDirectory())
    throw new Error(`workingDirectory không phải thư mục: ${workingDirectory}`);
}
```

### Tầng 2 — chặn ở nghiệp vụ

Dữ liệu có hợp lý **với thao tác này** không.

```js
function initializeWorkspace(projectDir, sessionId) {
  if (!projectDir) throw new Error('initializeWorkspace cần projectDir');
}
```

### Tầng 3 — guard môi trường

Chặn thao tác nguy hiểm trong ngữ cảnh cụ thể.

```js
async function gitInit(directory) {
  if (process.env.NODE_ENV === 'test') {
    const normalized = normalize(resolve(directory));
    const tmp = normalize(resolve(tmpdir()));
    if (!normalized.startsWith(tmp))
      throw new Error(`Từ chối git init ngoài thư mục tạm khi chạy test: ${directory}`);
  }
}
```

### Tầng 4 — chỗ đặt log

Bắt bối cảnh để lần sau còn điều tra được.

```js
logger.debug('sắp git init', { directory, cwd: process.cwd(), stack: new Error().stack });
```

## Cách áp dụng

1. **Lần dòng dữ liệu** — giá trị sai sinh ra ở đâu, được dùng ở đâu.
2. **Liệt kê mọi trạm** dữ liệu đi qua.
3. **Đề xuất chốt ở từng tầng** — cửa vào, nghiệp vụ, môi trường, log.
4. **Đề xuất cách kiểm từng tầng** — thử vượt tầng 1, xác nhận tầng 2 bắt được.

Bước 4 hay bị bỏ. Chốt chưa từng được kiểm là chốt chưa biết có hoạt động không.

## Ví dụ thật

**Bug:** `projectDir` rỗng làm `git init` chạy trong thư mục source.

**Dòng dữ liệu:** test setup → chuỗi rỗng → `Project.create(name, '')` →
`WorkspaceManager.createWorkspace('')` → `git init` chạy ở `process.cwd()`.

| Tầng | Chốt |
|---|---|
| 1 | `Project.create()` kiểm không rỗng / tồn tại / ghi được |
| 2 | `WorkspaceManager` từ chối `projectDir` rỗng |
| 3 | `WorktreeManager` từ chối `git init` ngoài thư mục tạm khi chạy test |
| 4 | log stack trace trước `git init` |

**Kết quả:** 1847 test pass, bug không tái hiện được nữa.

**Cả bốn tầng đều cần.** Trong lúc kiểm, mỗi tầng bắt được thứ tầng khác bỏ lọt: đường code
khác vượt qua tầng 1 · mock vượt qua tầng 2 · ca biên trên nền tảng khác cần tầng 3 · log
tầng 4 lộ ra chỗ dùng sai về mặt cấu trúc.

## Với alp-code

Repo này chọn **fail đóng** làm mặc định — hỏng thì hỏng to và thấy ngay. Vài chỗ đã theo
đúng mẫu bốn tầng, dùng làm ví dụ khi viết khuyến nghị:

| Tầng | Trong alp-code |
|---|---|
| 1 | `L.validate()` — loadout sai thì `compile-acl` ném lỗi, không sinh settings hỏng |
| 2 | `denyRules()` — deny của mọi vai anh em, enumerate từng cái |
| 3 | `hooks/acl-guard.cjs` — chặn lúc chạy, kể cả khi settings hỏng |
| 4 | `doctor.cjs` — tín hiệu `ACL-DRIFT`, `SKILL-DRIFT` khi hai bên lệch nhau |

CHARTER §6 nói thẳng giới hạn: `acl-guard` là **guardrail, không phải sandbox**. Nhiều tầng
chặn nhầm lẫn và vượt quyền tình cờ — không chặn được kẻ cố tình lách. Khuyến nghị phòng
thủ nhiều lớp thì đừng hứa nhiều hơn mức nó làm được.

## Chốt

Đừng dừng ở một chỗ kiểm. Và khi viết khuyến nghị, nói rõ **mỗi tầng bắt được gì
mà tầng khác bỏ lọt** — không có phần đó thì nó chỉ giống như bảo đi thêm việc.

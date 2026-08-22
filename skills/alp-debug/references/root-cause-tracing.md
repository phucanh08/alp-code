# Lần ngược nguyên nhân gốc

Lần ngược call stack tới chỗ **phát sinh**, không dừng ở chỗ lỗi nổ ra.

## Nguyên lý

Bug thường nổ **sâu** trong call stack. Bản năng là sửa ngay chỗ báo lỗi — đó là chữa
triệu chứng. Giá trị sai đã đi qua nhiều tầng trước khi tới đó, và mỗi tầng đều là một cơ
hội bị bỏ lỡ để chặn nó.

## Khi nào dùng

- Lỗi xảy ra sâu trong luồng thực thi, không phải ở cửa vào.
- Stack trace dài.
- Chưa rõ dữ liệu sai sinh ra từ đâu.
- Cần biết test nào hoặc đường code nào kích hoạt.

## Quy trình

### 1. Quan sát triệu chứng

```
Error: git init failed in /Users/oaidq/project/packages/core
```

### 2. Tìm nguyên nhân trực tiếp

Dòng code nào gây ra nó?

```js
await execFileAsync('git', ['init'], { cwd: projectDir });
```

### 3. Hỏi: ai gọi dòng này?

```
WorktreeManager.createSessionWorktree(projectDir, sessionId)
  ← Session.initializeWorkspace()
  ← Session.create()
  ← test tại Project.create()
```

### 4. Lần tiếp lên trên — giá trị nào được truyền vào?

- `projectDir = ''` — chuỗi rỗng.
- Chuỗi rỗng làm `cwd` thì rơi về `process.cwd()`.
- Đó là thư mục source.

### 5. Tìm chỗ phát sinh

Chuỗi rỗng từ đâu ra?

```js
const context = setupCoreTest();       // trả { tempDir: '' }
Project.create('name', context.tempDir); // đọc TRƯỚC khi beforeEach chạy
```

**Nguyên nhân gốc:** biến ở tầng ngoài được khởi tạo khi giá trị chưa sẵn sàng.
**Không phải** `git init`, cũng không phải `WorktreeManager`.

## Chèn stack trace khi lần tay không nổi

```js
async function gitInit(directory) {
  console.error('DEBUG git init:', {
    directory,
    cwd: process.cwd(),
    stack: new Error().stack,
  });
  await execFileAsync('git', ['init'], { cwd: directory });
}
```

Dùng `console.error()`, **không** dùng logger — logger trong test hay bị nuốt.

```bash
npm test 2>&1 | grep 'DEBUG git init'
```

Đọc stack trace tìm: tên file test · số dòng kích hoạt · mẫu lặp (cùng một test? cùng một
tham số?).

**Lưu ý ACL:** `oracle` không có `Edit` — không tự chèn được đoạn debug này. Mô tả chính
xác chèn gì, vào file nào, dòng nào, rồi để main chèn và chạy. Đừng tìm đường vòng qua
`Bash` để sửa file (HOUSE-RULES §1.9).

## Tìm test nào gây nhiễm

Có thứ xuất hiện trong lúc chạy test mà không biết test nào tạo ra:

```bash
.claude/skills/alp-debug/scripts/find-polluter.sh '.git' 'src/**/*.test.ts'
```

Chạy từng test một, dừng ở test đầu tiên gây nhiễm. Đường dẫn tính từ CWD của phiên
(`identity/oracle/`), qua symlink skill.

## Luật

**Không bao giờ chỉ sửa ở chỗ lỗi nổ ra.**

Tìm được nguyên nhân trực tiếp rồi thì hỏi tiếp:

- Lần lên được một tầng nữa không? → lần tiếp.
- Đây đúng là chỗ phát sinh? → đề xuất sửa ở đây.
- Rồi đề xuất thêm chốt chặn ở từng tầng — `defense-in-depth.md`.

## Ví dụ thật, đủ chuỗi

**Triệu chứng:** `.git` được tạo trong `packages/core/` (thư mục source).

**Chuỗi lần ngược:**

1. `git init` chạy trong `process.cwd()` ← tham số `cwd` rỗng
2. `WorktreeManager` nhận `projectDir` rỗng
3. `Session.create()` truyền chuỗi rỗng
4. test đọc `context.tempDir` trước khi `beforeEach` chạy
5. `setupCoreTest()` ban đầu trả `{ tempDir: '' }`

**Nguyên nhân gốc:** khởi tạo biến ở tầng ngoài, đọc giá trị chưa sẵn sàng.

**Sửa:** biến `tempDir` thành getter, ném lỗi nếu bị đọc trước `beforeEach`.

**Chốt chặn thêm:**

| Tầng | Chốt |
|---|---|
| 1 | `Project.create()` kiểm thư mục |
| 2 | `WorkspaceManager` từ chối chuỗi rỗng |
| 3 | guard môi trường: từ chối `git init` ngoài thư mục tạm |
| 4 | log stack trace trước khi `git init` |

Chuỗi này là mẫu cho phần **Chuỗi bằng chứng** trong báo cáo — main phải đi lại được từng
bước và tới cùng kết luận.

# DELEGATION — giao việc cho agent khác

> **Không nằm trong boot set.** Nạp khi sắp giao việc, không nạp dự phòng.
> Giao cho ai: `identity/<role>/RELATIONS.md` và `delegates_to` trong loadout.

## Khi nào tự làm, khi nào giao

**Tự làm** khi: đã biết đường dẫn · trả lời được từ bối cảnh sẵn có · việc <5 phút ·
chỉ cần quét bằng `Glob`/`Grep`/`Read`.

**Giao** khi: nhiều nhánh độc lập chạy song song được · việc dài cần lifecycle riêng ·
cần chuyên môn hẹp mà vai khác có.

Mỗi execution khởi động từ con số không và phải suy luận lại context đã được ALP chuẩn bị.
Task “nhiều mặt” không tự động đồng nghĩa với phải giao đi.

Principal có thể tương tác trực tiếp với role/execution. Khi task delegated, lifecycle và
kết quả vẫn route về `reports_to`; kênh giao tiếp không mở thêm ACL hay quyền delegation.

## Luật cứng

Mọi delegation đi qua ALP Delegation API:

```bash
alp delegate search --project /path/to/app -- "<việc>"
alp delegate review --background --project /path/to/app -- "<việc>"
alp delegation wait <execution-id>
alp delegation cleanup <execution-id>
```

`scripts/run-role.cjs` là compatibility facade và gọi cùng `DelegationService`.

Không gọi trực tiếp:

```text
herdr
paseo
create_agent
spawn_agent
```

Flow bắt buộc:

```text
role → DelegationService → exact delegates_to/ACL → prepared context → backend
```

ALP quyết định role, identity, memory visibility, task ownership và authorization. Backend
chỉ quyết định cách execution chạy, báo status/result, cancel và cleanup.

## Lifecycle

```text
queued → running → completed | failed | cancelled
```

Lệnh lifecycle luôn dùng ALP `execution-id`, không dùng pane ID hay Paseo agent ID:

```bash
alp delegation status <execution-id>
alp delegation wait <execution-id>
alp delegation cancel <execution-id>
alp delegation cleanup <execution-id>
alp delegation health
```

Backend nền được chọn ở `alp.config.yaml` hoặc `ALP_DELEGATION_BACKEND`. Principal có thể
đổi effective backend cho các request tiếp theo bằng skill `delegation-switch` hoặc
`alp delegation switch herdr|paseo`; `switch default` quay lại default. Không tự fallback sau
khi spawn đã bắt đầu vì có thể chạy task hai lần; fallback chỉ hợp lệ trước spawn và phải
được khai rõ.

Không có `--project` thì workspace là cwd nơi gọi `alp`. ALP pin path canonical vào prompt,
state và env của execution; role không được đọc source từ workspace đăng ký khác trong cùng
lượt. Với task quan trọng, luôn truyền `--project <absolute-path>` để scope không mơ hồ.

## Khuôn prompt — sáu mục

```text
1. Mục tiêu   — một câu, kết quả mong muốn
2. Bối cảnh   — đường dẫn file liên quan, quyết định đã chốt, cái đã thử
3. Phạm vi    — file/thư mục được động vào; cái gì KHÔNG được động
4. Môi trường — CWD, OS, shell, timezone
5. Đầu ra     — định dạng mong muốn, ghi vào đâu
6. Ranh giới  — không commit, không deploy, không sửa ngoài phạm vi
```

Thiếu mục 3 hoặc 6 là nguyên nhân phổ biến nhất khiến execution làm vượt phạm vi.

## Sau khi có kết quả

Đọc lại output trước khi báo cáo. Kiểm tối thiểu: mở file được nhắc tới · chạy test được
tuyên bố đã chạy · kiểm một link. Trách nhiệm cuối vẫn thuộc role giao việc.

## Chạy song song an toàn

- Mỗi execution sở hữu một file set riêng, không giao nhau.
- Tối đa 3–4 execution đồng thời.
- Việc phụ thuộc nhau chạy tuần tự.
- Prompt chỉ mang context ALP đã cho phép; không dump memory/private của role khác.

## Memory và identity boundary

Execution nhận identity + task + memory index/context đã được ALP lọc theo target loadout.
Herdr/Paseo không phải source of truth của identity hay memory. Muốn mở thêm quyền phải sửa
target `loadout.yaml` rồi compile ACL; không cấu hình quyền ở backend để lách ALP.

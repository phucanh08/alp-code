# `orchestrator` — role built-in thứ 9

Tài liệu này mở rộng §5.9 của [triết lý thiết kế & tầm nhìn kiến trúc](./alp-design-philosophy-and-vision.md).
Mọi tham chiếu `§x.y` dưới đây trỏ về doc đó.

Trạng thái: **đề xuất**. Chưa có code. Điều kiện mở khoá nằm ở cuối.

---

## 1. Việc mà 8 role hiện tại không làm được

Trần ở §5.5 (`delegatesTo: []`) tồn tại để custom agent không đẻ ra cây quan hệ mà principal không
viết ra. Nhưng có đúng một loại việc cần cây đó: **điều phối nhiều execution dài, chạy song song,
trên các workspace tách biệt** — mô hình orchestration của Paseo.

Vì nó bắt buộc `delegatesTo` khác rỗng, nó không thể là custom agent. Nó là role **built-in thứ 9**,
`src/agents/orchestrator.ts`, nơi trần capability và mọi ngoại lệ do repo viết chứ không phải
principal tự cấp cho mình.

## 2. Nó không phải `main` đổi tên

`main` đồng bộ, một workspace, một hội thoại, và sở hữu câu trả lời cuối cùng cho principal.
`orchestrator` sở hữu thứ khác: vòng đời của một *đội* execution.

| Quan tâm | `main` | `orchestrator` |
|---|---|---|
| Workspace | working tree đang mở | tạo/thu hồi worktree: branch-off, checkout-branch, checkout-PR |
| Nhịp | đồng bộ trong một lượt | dài phút–giờ, kết quả về qua notify, **không** poll |
| Bố cục | một chuỗi delegation | fan-out song song, gom kết quả, huỷ cả cụm |
| Thời gian | chỉ "bây giờ" | cron: schedule sinh execution mới, heartbeat gọi ngược về hội thoại |
| Sở hữu kết quả | trả lời principal | giao lại cho `main` hoặc principal, kèm trace của cả cụm |

Hai vai này cùng tồn tại. `main` gọi `orchestrator` khi việc vượt quá một lượt hội thoại; nó không
thay `main` ở vị trí đối thoại với principal.

## 3. Bề mặt cần có, lấy từ mô hình Paseo

| Nhóm | Việc |
|---|---|
| Workspace lifecycle | tạo worktree (`branch-off` / `checkout-branch` / `checkout-pr`), đặt tên, archive khi xong |
| Execution lifecycle | tạo, gửi follow-up, huỷ, archive |
| Định kỳ | *schedule* sinh execution mới theo cron; *heartbeat* gửi prompt ngược về hội thoại đang mở |
| Thu kết quả | notify khi xong/lỗi/cần approval — **không** polling |

Phân biệt schedule và heartbeat quan trọng hơn vẻ ngoài của nó: schedule đẻ ra execution mới (tốn
budget mới, có trace riêng), heartbeat chỉ đánh thức một execution đã có. Gộp hai thứ này làm một là
cách nhanh nhất để mất kiểm soát budget.

## 4. Ba ràng buộc — đây là chỗ ý tưởng dễ hỏng nhất

### 4.1. Không miễn trừ invariant

`src/policy/invariants.ts` cấm **mọi** role gọi `create_agent`, `spawn_agent`, `paseo`, `herdr`:

```ts
const RAW_RUNTIME_TOOL = /(?:^|__)(?:herdr|paseo|create_agent|spawn_agent)(?:__|$)/i;
```

`orchestrator` **không** được thêm vào danh sách ngoại lệ. Nó điều phối qua `DelegationService` như
mọi role khác. Cái phải lớn lên là *service* — thêm bề mặt workspace lifecycle và schedule ở §3 —
chứ không phải danh sách ngoại lệ. Một invariant có ngoại lệ cho đúng cái role hay dùng nó nhất thì
không còn là invariant.

`paseo` không còn là backend của ALP (gỡ 2026-09-03), nhưng vị trí của nó trong invariant thì
không đổi: nó là một binary ở tầng dưới, không phải một tool mà agent gọi được.

### 4.2. §4.10 phải xong trước, không phải song song

Budget, cancellation, và trace ghép được `parent → child → tool` là điều kiện tiên quyết. Một
orchestrator không có cancellation và không có budget là fork bomb kèm một file policy.

Cụ thể phải đo được trước khi có dòng code `orchestrator` đầu tiên:

- huỷ execution cha thì mọi execution con dừng, kể cả con đang chạy ở worktree khác;
- budget của cả cụm là một con số, không phải tổng cộng dồn sau khi đã tiêu;
- một trace duy nhất ghép được toàn bộ cây, không phải N log rời.

### 4.3. Đây là phép thử của "không phải swarm tự do"

§8 tuyên bố ALP **không phải swarm tự do**: delegation phải có hierarchy, budget, cancellation,
structured result. `orchestrator` là đường ngắn nhất để biến ALP thành swarm nếu bốn thứ đó không
cưỡng chế được. Nếu phải chọn giữa "orchestrator mạnh" và "câu tuyên bố đó còn đúng", chọn câu
tuyên bố.

## 5. Không phải primitive mới

Theo bài kiểm tra ở đầu §7: một feature không rõ thuộc primitive nào thì phải hỏi nó có thật sự là
primitive mới hay chỉ là implementation của primitive đã có. `orchestrator` là **Delegation +
Workflow + Execution ghép lại**. Không thêm dòng nào vào bảng primitive.

## 6. Điều kiện mở khoá

| Cần | Vì sao |
|---|---|
| §4.10 xong: budget, cancellation, trace parent→child | §4.2 ở trên |
| `DelegationService` có bề mặt workspace + schedule | §4.1 — không mở đường vòng qua raw tool |
| Có use case thật cần chạy song song trên worktree tách biệt | §8: không xây trước nhu cầu |

## 7. Còn mở

- `reportsTo` là `principal` hay `main`? Nếu là `main`, mọi việc dài đều phải đi qua một hội thoại
  đồng bộ — đúng thứ role này sinh ra để tránh. Nếu là `principal`, ALP có hai vai cùng nói chuyện
  trực tiếp với người dùng, và §4.6 phải nói rõ ai sở hữu câu trả lời cuối.
- `delegatesTo` gồm những role nào? Cho phép `orchestrator → orchestrator` là mở lại đúng cái cây
  sâu vô hạn mà §5.5 chặn.
- Heartbeat gọi ngược vào một hội thoại đang mở có phải một loại hook (§7) không, hay là một
  primitive khác đang giả dạng?

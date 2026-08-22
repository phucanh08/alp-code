# DELEGATION — giao việc cho agent khác

> **Không nằm trong boot set.** Nạp khi sắp giao việc, không nạp dự phòng.
> Giao cho ai: `identity/<role>/RELATIONS.md`.

## Khi nào tự làm, khi nào giao

**Tự làm** khi: đã biết đường dẫn · trả lời được từ bối cảnh sẵn có · việc <5 phút ·
chỉ cần quét bằng `Glob`/`Grep`/`Read`.

**Giao** khi: nhiều nhánh độc lập chạy song song được · việc dài cần theo dõi và can thiệp ·
cần chuyên môn hẹp mà vai khác có.

Mỗi agent khởi động từ con số không và phải suy luận lại bối cảnh bạn đã có sẵn. Task
"nhiều mặt", "kỹ lưỡng", "nhiều phần" **không** đồng nghĩa với phải giao đi.

**Luật cứng:** không spawn subagent in-process, không dùng `Agent` tool — mọi việc giao đi
qua **herdr**. Giao cho ai: bảng RELATIONS đã nạp sẵn ở boot.

## Cách chạy — chọn đường theo HÌNH DẠNG việc, không theo cảm giác

| Hình dạng việc | Đường |
|---|---|
| ≥2 vai song song · >1 phút · cần theo dõi/tương tác · review nhiều concern | **pane herdr** |
| Một câu hỏi · đồng bộ · <1 phút · **hoặc không có fleet** | **`--exec`** |

```bash
# pane: chạy nền, theo dõi được, không chiếm terminal
node scripts/run-role.cjs search --project /path/to/app --pane -- "<việc>"
#   → PANE w5:p3 · AGENT search-8f2a · kèm sẵn lệnh WATCH và RELEASE

# exec: một câu hỏi, chờ ngay tại chỗ
node scripts/run-role.cjs read-thread --exec -- "<câu hỏi>"
```

Ba điều launcher đã lo, đừng làm lại bằng tay:

- **Không có fleet ⇒ `--pane` tự rơi về `--exec`.** Phiên headless không có pane để mở.
- **`--seq` và `release-agent`.** `release-agent` thiếu `--seq` bị bỏ qua IM LẶNG (exit 0,
  panel không đổi) — nên trả quyền bằng `run-role.cjs <role> --release <pane>`,
  không gõ `herdr pane release-agent` trần.
- **Prompt nhiều dòng.** herdr từ chối arg có xuống dòng; launcher tự đưa ra file và thay
  bằng một dòng có mang nguồn ủy nhiệm.

Xong việc thì **release**, đừng để pane kẹt `working`:

```bash
node scripts/run-role.cjs <role> --release <pane>
```

`alp doctor` báo `ORPHAN-PANE` cho pane đã quên trả quyền.

**Vai phụ không được chạy hai lệnh trên.** `delegates_to` rỗng = không spawn được ai;
acl-guard chặn `herdr` và `run-role` ở vị trí lệnh. Cần thêm tay thì báo `main`.

## Khuôn prompt — sáu mục, không thiếu mục nào

```
1. Mục tiêu   — một câu, kết quả mong muốn
2. Bối cảnh   — đường dẫn file liên quan, quyết định đã chốt, cái đã thử
3. Phạm vi    — file/thư mục được động vào; cái gì KHÔNG được động
4. Môi trường — CWD, OS darwin, shell zsh, timezone Asia/Saigon
5. Đầu ra     — định dạng mong muốn, ghi vào đâu
6. Ranh giới  — không commit, không deploy, không sửa ngoài phạm vi
```

Thiếu mục 3 hoặc 6 là nguyên nhân phổ biến nhất khiến agent làm vượt phạm vi.

## Sau khi agent trả kết quả

**Đọc lại bằng mắt mình trước khi báo cáo lên.** Agent có thể sai, phóng đại, hoặc
tuyên bố hoàn thành việc chưa làm. Kết quả sai là lỗi của người giao, không phải người nhận.

Kiểm tối thiểu: mở file agent nói đã ghi · chạy lệnh agent nói đã chạy · kiểm một link.

## Chạy song song an toàn

- Mỗi agent sở hữu một tập file riêng, **không giao nhau**. Hai agent ghi cùng file = hỏng.
- Tối đa 3–4 agent đồng thời, cân theo tài nguyên máy.
- Việc phụ thuộc nhau thì chạy tuần tự, không song song.
- Mỗi agent chỉ có ~200K context — giao task hẹp, kèm đúng bối cảnh cần, không dump cả repo.

## Ngân sách & cách ly

Mỗi agent khởi động từ con số không và phải suy luận lại bối cảnh bạn đã có sẵn.
Task "nhiều mặt", "kỹ lưỡng", "nhiều phần" **không** đồng nghĩa với phải giao đi.

Agent được giao chạy trong phiên riêng, với `loadout.yaml` riêng — nó **không** thấy
`memory/private/` của bạn và không ghi được ngoài `memory.write` của nó. Muốn nó ghi
được chỗ mới → xin principal sửa loadout của **nó**, không phải của bạn.

# Hỗ trợ ngôn ngữ của gkg

## Bảng

| Ngôn ngữ | Định nghĩa | Import | Tham chiếu trong file | Tham chiếu chéo file |
|---|---|---|---|---|
| Ruby | ✅ | ✅ | ✅ | ✅ |
| Java | ✅ | ✅ | ✅ | ✅ |
| Kotlin | ✅ | ✅ | ✅ | ✅ |
| Python | ✅ | ✅ | ✅ | **chưa xong** |
| TypeScript | ✅ | ✅ | ✅ | **chưa xong** |
| JavaScript | ✅ | ✅ | ✅ | **chưa xong** |

## Bốn năng lực nghĩa là gì

| Năng lực | Nội dung |
|---|---|
| **Định nghĩa** | class, hàm, method, hằng, interface — rút từ AST |
| **Import** | theo dõi import module/package để dựng đồ thị phụ thuộc |
| **Tham chiếu trong file** | chỗ dùng symbol nằm cùng file |
| **Tham chiếu chéo file** | chỗ dùng symbol định nghĩa ở file khác — **đây là cái quyết định phân tích ảnh hưởng** |

Cột cuối là cột duy nhất thật sự quan trọng khi truy xuất code. Ba cột đầu `rg` cũng làm
gần được.

## Ruby / Java / Kotlin — dùng tự tin

Phân tích ngữ nghĩa đầy đủ: tìm định nghĩa chéo file · tìm mọi chỗ gọi · đồ thị phụ thuộc
đầy đủ · phân tích ảnh hưởng trước refactor.

## Python / TS / JS — dùng có điều kiện

Chạy được: rút định nghĩa, theo dõi import, tham chiếu trong cùng file.

**Không đầy đủ:**

- `get_references` chéo file **có thể bỏ sót** chỗ dùng.
- `get_definition` có thể không giải được symbol từ bên ngoài.

Đây là điểm quan trọng nhất của cả file này. Với TS/JS/Python:

1. **Luôn đối chiếu thêm bằng `rg`.** `gkg` cho quan hệ, `rg` cho độ phủ — cần cả hai.
2. **Ghi rõ trong báo cáo là kết quả chưa chắc đầy đủ.**
3. Việc quan trọng (ai đó sắp refactor) thì kiểm tay thêm những chỗ then chốt.

Trả lời "có 3 chỗ gọi" khi thật ra có 11 là kiểu sai đắt nhất một lượt truy xuất có thể
gây ra — người ta sẽ refactor dựa trên con số đó.

## Đây là beta công khai

Không phải công cụ đã chín. Hỗ trợ tham chiếu chéo file cho Python/TS/JS đang được làm —
xem https://gitlab.com/gitlab-org/rust/knowledge-graph để biết trạng thái mới.

Đến khi nào cột cuối của TS/JS chuyển thành ✅ thì luật đối chiếu bằng `rg` vẫn còn hiệu lực.

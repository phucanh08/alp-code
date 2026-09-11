---
title: Cài đặt
description: Cài ALP qua binary hoặc npm, kiểm môi trường và cập nhật an toàn.
---

Direct binary là channel mặc định. Máy người dùng không cần Node, Bun, npm hay Git; installer tải archive đúng OS/CPU, kiểm checksum và manifest trước khi đổi version hiện hành.

## Cài direct binary

macOS hoặc Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/phucanh08/alp-code/main/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/phucanh08/alp-code/main/install.ps1 | iex
```

:::caution[Đây là remote script]
Hai lệnh trên tải code rồi chạy ngay với quyền của tài khoản hiện tại. Nếu cần kiểm soát supply chain chặt hơn, hãy tải script về để đọc trước hoặc pin release cụ thể thay vì lấy mặc định.
:::

Ví dụ pin version đang được bộ docs này mô tả (`v0.14.0`):

```bash
curl -fsSL https://raw.githubusercontent.com/phucanh08/alp-code/main/install.sh | bash -s -- --version v0.14.0
```

```powershell
$env:ALP_VERSION = "v0.14.0"
irm https://raw.githubusercontent.com/phucanh08/alp-code/main/install.ps1 | iex
```

Binary channel hiện phát hành cho macOS arm64/x64, Linux glibc x64/arm64 và Windows x64. Linux musl, Windows arm64 và notarization chưa thuộc phạm vi `v0.13.x`.

## Cài qua npm

Nếu máy đã có Node.js 18 trở lên:

```bash
npm install --global alp-code
```

Package npm là wrapper nhỏ; nó tải payload trùng version của package vào cache của người dùng. `--ignore-scripts` vẫn dùng được vì launcher tự bảo đảm payload ở lần chạy đầu.

## Kiểm tra cài đặt

```bash
alp --version
alp doctor
```

Kỳ vọng `alp --version` in version hiện hành. `alp doctor` trả exit code `0` khi healthy, `1` khi có finding cần xử lý và `2` nếu chính doctor gặp lỗi.

ALP chỉ là launcher; mode bạn chọn có thể cần Claude Code, Codex CLI hoặc cả hai. `alp doctor` cho biết runtime nào còn thiếu.

## Cập nhật

```bash
alp update
```

ALP cập nhật theo channel đã cài. User state nằm trong `~/.alp`, tách khỏi versioned installation dưới `~/.alp-code`, nên update không thay thế memory hay project registry.

## Gỡ cài đặt

```bash
alp uninstall
```

Mặc định ALP chuyển memory sang một thư mục backup cạnh `~/.alp`, rồi gỡ phần state và installation do ALP sở hữu.

:::danger[Không thể hoàn tác bằng ALP]
`alp uninstall --purge-memory` xoá memory thay vì tạo backup. Chỉ dùng sau khi đã tự sao lưu và xác nhận đúng machine state cần xoá.
:::

Tiếp theo: [khởi tạo project và mở phiên đầu tiên](../quickstart/).

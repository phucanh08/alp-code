---
title: Skill của project
description: Cấp skill dùng chung hoặc riêng cho agent mà không thoát khỏi project roots.
---

:::caution[Preview, chưa có trong stable `v0.10.4`]
Project skill binding và built-in overlay ở trang này thuộc checkout sau tag `v0.10.4` (commit `7833490`).
:::

Skill là knowledge/workflow package có `SKILL.md`, không phải agent và không tự chạy. Directory của agent là danh sách grant: đặt hoặc trỏ skill vào đúng `<agent>/skills/` để role đó thấy.

## Layout

```text
<project>/.alp/
├── skills/
│   ├── house-conventions/
│   │   └── SKILL.md
│   └── release-drill/
│       └── SKILL.md
└── agents/
    └── migrator/
        ├── agent.yaml
        └── skills/
            ├── framework-migration/
            │   └── SKILL.md
            ├── house-conventions -> ../../../skills/house-conventions
            └── release-drill.skillref
```

- Directory thật trong `migrator/skills/` là skill riêng của agent.
- Symlink có thể trỏ tới `.alp/skills/` dùng chung hoặc built-in skill root.
- `.skillref` là lựa chọn cho Windows/checkout không giữ symlink; file chứa đúng một relative path.

Nội dung `release-drill.skillref` ví dụ:

```text
../../../skills/release-drill
```

## Skill built-in và skill project

Custom agent khai built-in skill bằng tên trong `capabilities.skills` và phải có tool `Skill`. Project skill không khai lại trong field đó; entry trong `<agent>/skills/` chính là grant.

```yaml
capabilities:
  tools: [Read, Glob, Grep, Skill]
  skills: [git]
```

Nếu cùng một custom agent vừa khai built-in skill theo tên vừa có project binding trùng tên, loader từ chối vì grant bị lặp.

## Overlay cho built-in role

Thêm skill cho role có sẵn bằng directory overlay, không tạo `agent.yaml` cạnh built-in ID:

```text
.alp/agents/review/skills/house-conventions.skillref
```

Overlay chỉ thêm skill; nó không thêm tool `Skill` cho role chưa có tool đó. Dùng `alp agent show review` để xem thứ tự và target được resolve thực tế.

## Ranh giới an toàn

- Đích phải nằm trong `.alp/skills/` hoặc built-in skill tree.
- Symlink chỉ được đi đúng một hop; link chain bị từ chối.
- `.skillref` phải chứa đúng một relative path.
- Mỗi skill target phải có `SKILL.md`.
- Tối đa 20 skill cho một agent.
- Một binding thoát root làm cả agent bị deny; ALP không chạy agent với authority chỉ được cấp một phần.

:::caution[Skill root là quyền đọc]
Không trỏ skill tới home directory, credential store hoặc source ngoài sanctioned roots. Một link như vậy sẽ biến quyền đọc skill thành quyền đọc dữ liệu không được khai báo.
:::

## Kiểm chứng

```bash
alp agent show migrator
alp agent test migrator --tier 1
```

`show` phải liệt kê từng binding, kind và resolved path. Tier 1 phải xanh trước khi trust hoặc delegate.

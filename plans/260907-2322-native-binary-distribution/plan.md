---
title: "ALP Native Binary Distribution"
description: "Phát hành ALP dưới dạng native executable theo platform, không cần Node ở binary channel, với migration và rollback an toàn."
status: pending
priority: P1
effort: 12-15d
branch: feat/native-binary
tags: [feature, infra, distribution, packaging, release, critical]
created: 2026-09-07
updated: 2026-09-08
---

# ALP Native Binary Distribution — Master Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** `alp` chạy trên máy không có Node/npm/toolchain, từ một platform archive đã verify, trong khi giữ nguyên `~/.alp`, CLI behavior và khả năng rollback.

**Architecture:** Entry bootstrap cực nhẹ phân luồng fast-path và internal subcommand trước khi lazy-load full CLI. Một `InstallLayout` phân biệt executable thật, stable command, install root, asset root và channel. Binary, skills, scaffold nằm trong versioned archive; Bun là compiler ưu tiên nhưng chỉ được chốt sau compatibility gate.

**Tech stack:** TypeScript 5.9, Bun phiên bản pin chính xác sau NB-0, Zod 4, Vitest 3, Node built-ins qua Bun node-compat; Node chỉ còn ở dev/npm-wrapper channel.

## Quyết định đã chốt

- Bun là candidate chính; SEA là fallback. NB-0 đo runtime primitives, không cố chạy full ALP nguyên trạng.
- Runtime artifact có một executable, nhưng distribution artifact là archive: `bin/alp[.exe]`, `skills/`, `scaffold/`, `LICENSE`, `install-manifest.json`.
- `skills/` và `scaffold/` ở trên đĩa. Không dùng Bun-only asset embedding, để SEA fallback còn mở.
- Mọi runtime code của binary phải nằm trong static dependency closure. Không runtime require file dưới `scripts/`/`dist/`.
- Long-lived hook config dùng `stableCommand`; respawn nội bộ dùng `selfExecutable`.
- Five-target v0.10 scope: darwin arm64/x64, Linux glibc x64/arm64, Windows x64. Musl và Windows arm64 là non-goal cho v0.10.
- Target chỉ được gọi là supported khi artifact chạy smoke trên OS/libc/arch tương ứng.
- v0.10 giữ legacy hooks; xóa sớm nhất ở v0.11 sau một chu kỳ migration.

## Phases

| # | Phase | Status | Effort | Gate |
|---|---|---|---:|---|
| NB-0 | [Bun compatibility probes](./phase-00-bun-compatibility-probes.md) | Pending | 1-1.5d | Bun primitives pass hoặc chuyển SEA |
| NB-1 | [Install layout + static runtime boundary](./phase-01-install-layout-static-boundary.md) | Pending | 2d | Không còn runtime path/require mơ hồ |
| NB-2 | [Lightweight entry + internal subcommands](./phase-02-lightweight-entry-internal-subcommands.md) | Pending | 1.5d | Binary skeleton chạy fast-path và full CLI |
| NB-3 | [Hook migration](./phase-03-hook-migration.md) | Pending | 2d | Old projects nạp identity ở turn 1 |
| NB-4 | [Assets + build pipeline](./phase-04-assets-build-pipeline.md) | Pending | 1.5d | Five archives reproducible, đúng manifest |
| NB-5 | [Install, update, uninstall](./phase-05-install-update-uninstall.md) | Pending | 2-2.5d | Failure không làm mất current/state |
| NB-6 | [npm wrapper](./phase-06-npm-wrapper.md) | Pending | 1-1.5d | Exact-version archive, ignore-scripts safe |
| NB-7 | [Cross-platform validation + rollout](./phase-07-cross-platform-validation-rollout.md) | Pending | 1.5-2d | Release matrix và migration xanh |

## Invariants

1. `~/.alp` là user state; installer/update không thay hoặc xóa ngoài contract hiện có.
2. Install directories là immutable versioned artifacts.
3. Cùng command cho cùng output/exit code giữa Node dev CLI và native CLI.
4. Thiếu/sai asset, checksum, target hoặc architecture phải fail rõ trước cutover.
5. Không có Node child process trong binary channel.
6. Hook fast-path không dựng full CLI dependency graph.
7. Update chỉ đổi `current` sau checksum, structure validation, version smoke và executable smoke.
8. Migration idempotent; chỉ sửa config mang ownership marker của ALP.
9. Rollback không phụ thuộc network và luôn giữ ít nhất previous known-good version.

## Release gates

- Node dev suites xanh: typecheck, build, Vitest, `scripts/test-*.cjs`.
- Five target archives build trong một lệnh; mỗi target chạy trên môi trường đích thật.
- Clean binary-channel install chạy không có Node trên PATH.
- v0.9.0 npm và tarball migration giữ memory, identity, preferences, execution/delegation state và project settings.
- `alp --version` p95 dưới 40 ms trên reference darwin-arm64, không network/update side effect.
- Broken/wrong-arch/tampered archive không thay `current`.

## Non-goals v0.10

- Rust/Go rewrite; Homebrew formula; auto-update; musl; Windows arm64; macOS notarization; binary size optimization.
- Xóa legacy hooks trong v0.10.
- Thay đổi semantics của agents, policy, memory, delegation, context hoặc execution.

## Research

- [Bun vs Node SEA spike](./research/spike-bun-vs-sea.md)
- NB-0 output: `research/bun-compat.md`


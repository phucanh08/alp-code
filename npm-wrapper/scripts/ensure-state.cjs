#!/usr/bin/env node
"use strict";

// scripts/ensure-state.cjs — shim tương thích ngược, KHÔNG phải một phần kiến trúc wrapper mỏng.
//
// Trước v0.10.0, package npm chính là cây file repo và có sẵn `scripts/ensure-state.cjs` thật.
// `alp update` của những bản đó (đã publish, không sửa lại được nữa) chạy xong
// `npm install -g alp-code@<mới>` rồi mở một tiến trình node MỚI nhắm thẳng đường dẫn này để
// dựng lại `~/.alp` trên bản vừa cài — bắt buộc phải là tiến trình mới vì tiến trình đang chạy
// đã nạp code cũ vào bộ nhớ trong khi thư mục dưới chân nó vừa bị `npm install` thay ruột.
//
// Từ v0.10.0 npm package chỉ còn là wrapper mỏng tải native binary về, không còn cây `scripts/`
// thật nào — thiếu đúng file này khiến MỌI lượt `alp update` từ bản cũ crash MODULE_NOT_FOUND
// ngay sau khi `npm install -g` đã thành công (gói mới đã nằm trên đĩa, chỉ bước ensure-state
// sau đó vỡ). File này tồn tại chỉ để bản cũ gọi trúng; nó không tự dựng state, chỉ định vị
// native payload của phiên bản vừa cài rồi nhờ chính payload đó dựng state qua
// `__internal ensure-state` — con đường mà bản thân wrapper mỏng cũng dùng.
//
// Xoá được khi không còn ai chạy `alp update` từ npm package cũ hơn 0.10.0 nữa.

const { spawnSync } = require("child_process");
const { ensurePayload } = require("../lib/install-payload.cjs");

const quiet = process.argv.includes("--quiet");

ensurePayload()
  .then((payload) => {
    const result = spawnSync(payload.executable, ["__internal", "ensure-state"], {
      stdio: quiet ? "ignore" : "inherit",
    });
    if (result.error) throw result.error;
    process.exit(result.status ?? 1);
  })
  .catch((error) => {
    console.error(`ERROR    không dựng được state qua native payload: ${error.message}`);
    process.exit(1);
  });

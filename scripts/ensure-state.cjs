#!/usr/bin/env node
// ensure-state.cjs — dựng `~/.alp` cho thư mục cài đang chứa file này.
//
// Installer gọi sau khi giải nén, và `alp update` gọi lại bằng CODE MỚI sau khi thay xong thư
// mục cài: tiến trình `alp` đang chạy đã nạp bản cũ vào bộ nhớ và thư mục dưới chân nó vừa bị
// thay, nên mọi thứ cần chạy sau đó phải là một tiến trình mới đọc file mới.

"use strict";

const path = require("path");
const { ensureState } = require("./lib/state.cjs");

const root = path.resolve(__dirname, "..");
const quiet = process.argv.includes("--quiet");

try {
  const result = ensureState({ root });
  if (!quiet) for (const entry of result.log) console.log(`${entry.level.padEnd(9)}${entry.text}`);
} catch (error) {
  console.error(`ERROR    không dựng được state tại ~/.alp: ${error.message}`);
  process.exit(1);
}

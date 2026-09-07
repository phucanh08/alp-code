// release-manifest.cjs — hợp đồng nội dung của artifact phát hành.
//
// `files` trong package.json chỉ là CÁCH thực hiện hợp đồng này, và nó im lặng khi sai: một
// dấu `!` đặt lệch chỗ cắt mất nguyên một thư mục mà `npm pack` vẫn chạy xanh. Danh sách ở đây
// là thứ được kiểm lại — bởi `pack-release.cjs` lúc dựng artifact, và bởi
// `test-pack-release.cjs` ở mỗi lần chạy test, để phát hiện trước khi tới ngày phát hành.

"use strict";

/** Không có đủ những file này thì bản cài không chạy được mà không build lại. */
const REQUIRED = [
  "package.json",
  "LICENSE",
  "dist/src/cli/alp.js",
  "dist/src/agents/registry.js",
  "dist/src/runtime/claude-adapter.js",
  "dist/src/runtime/codex-adapter.js",
  "scripts/alp.cjs",
  "scripts/doctor.cjs",
  "scripts/ensure-state.cjs",
  "scripts/lib/install-paths.cjs",
  "scripts/lib/state.cjs",
  "scripts/lib/update.cjs",
  "scripts/lib/uninstall.cjs",
  "hooks/session-boot.cjs",
  "scaffold/memory/INDEX.md",
  "alp.config.yaml",
];

/** Nguồn, test và memory của maintainer không được đi theo artifact ra ngoài. */
const FORBIDDEN = [/^src\//, /^test\//, /^dist\/test\//, /^memory\//, /^\.git\//, /^scripts\/test-/];

/** @returns {{missing: string[], leaked: string[]}} */
function verifyEntries(entries) {
  const present = new Set(entries);
  return {
    missing: REQUIRED.filter((file) => !present.has(file)),
    leaked: entries.filter((entry) => FORBIDDEN.some((pattern) => pattern.test(entry))),
  };
}

module.exports = { REQUIRED, FORBIDDEN, verifyEntries };

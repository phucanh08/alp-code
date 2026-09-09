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

const NPM_WRAPPER_REQUIRED = [
  "package.json",
  "LICENSE",
  "install.cjs",
  "bin/alp.cjs",
  "lib/resolve-target.cjs",
  "lib/install-payload.cjs",
  "lib/binary-targets.json",
];
const NPM_WRAPPER_FORBIDDEN = [/^dist\//, /^src\//, /^scripts\//, /^hooks\//, /^skills\//, /^scaffold\//, /^node_modules\//];

/** @returns {{missing: string[], leaked: string[]}} */
function verifyEntries(entries) {
  const present = new Set(entries);
  return {
    missing: REQUIRED.filter((file) => !present.has(file)),
    leaked: entries.filter((entry) => FORBIDDEN.some((pattern) => pattern.test(entry))),
  };
}

function createInstallManifest({ version, target, compilerVersion, sourceCommit = null }) {
  return {
    schemaVersion: 1,
    app: "alp-code",
    version,
    target,
    compiler: { name: "bun", version: compilerVersion },
    ...(sourceCommit ? { sourceCommit } : {}),
  };
}

function validateInstallManifest(value, expected = {}) {
  if (!value || value.schemaVersion !== 1 || value.app !== "alp-code" || typeof value.version !== "string" ||
      typeof value.target !== "string" || value.compiler?.name !== "bun" || typeof value.compiler?.version !== "string") {
    throw new Error("invalid install manifest");
  }
  if (expected.version && value.version !== expected.version)
    throw new Error(`install manifest version mismatch: expected ${expected.version}, got ${value.version}`);
  if (expected.target && value.target !== expected.target)
    throw new Error(`install manifest target mismatch: expected ${expected.target}, got ${value.target}`);
  return value;
}

function validateArchiveEntries(entries) {
  for (const raw of entries) {
    const entry = String(raw).replace(/^\.\//, "").replace(/\/$/, "");
    if (!entry || entry === ".") continue;
    if (entry.startsWith("/") || entry.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(entry) || entry.includes("\\"))
      throw new Error(`unsafe archive entry: ${raw}`);
    const parts = entry.split("/");
    if (parts.includes("..") || parts.includes("")) throw new Error(`unsafe archive entry: ${raw}`);
  }
  return entries;
}

module.exports = {
  REQUIRED,
  FORBIDDEN,
  verifyEntries,
  createInstallManifest,
  validateInstallManifest,
  validateArchiveEntries,
  NPM_WRAPPER_REQUIRED,
  NPM_WRAPPER_FORBIDDEN,
};

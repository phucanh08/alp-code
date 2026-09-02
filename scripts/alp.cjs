#!/usr/bin/env node
// Stable CommonJS bootstrap. All parsing, policy, identity, and runtime selection live
// in the compiled TypeScript CLI; this file only ensures that entrypoint exists.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { spawnSyncCommand } = require("./lib/delegation/backends/command-runner.cjs");

const repoRoot = path.resolve(__dirname, "..");
const maintenance = process.argv[2];

// Ba lệnh dưới đây cố ý chạy thẳng, không qua dist/: chúng phải dùng được cả khi build hỏng
// — doctor để chẩn đoán, update để sửa, uninstall để gỡ một bản cài đã hỏng. Đánh đổi: chúng
// không đi qua main() nên không hiện thông báo có bản mới. `help` thì không có lý do đó, nên
// nó đi qua CLI đã compile để chỉ có một nguồn help duy nhất (helpText() trong cli/alp.ts).

if (maintenance === "doctor") {
  const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "doctor.cjs"), ...process.argv.slice(3)], { cwd: repoRoot, stdio: "inherit" });
  process.exit(result.status ?? 2);
}

if (maintenance === "update") {
  const { updateInstallation } = require("./lib/update.cjs");
  // updateInstallation là async (resolve tag release cần gọi mạng). Gọi đồng bộ rồi đọc
  // `result.ok` trên một Promise sẽ luôn ra undefined — v0.1.0/v0.1.1 in "ERROR undefined"
  // và không update gì cả.
  updateInstallation(repoRoot).then(
    (result) => {
      if (!result.ok) console.error(`ERROR     ${result.message}`);
      else console.log(`READY     alp-code updated to ${result.tag}; memory/runtime/backend preferences preserved`);
      process.exit(result.ok ? 0 : 1);
    },
    (error) => {
      console.error(`ERROR     ${error && error.message ? error.message : String(error)}`);
      process.exit(1);
    },
  );
  return;
}

if (maintenance === "uninstall") {
  const args = new Set(process.argv.slice(3));
  for (const arg of args) if (!["--purge-memory", "--force"].includes(arg)) {
    console.error(`ERROR     unknown uninstall option \`${arg}\``);
    process.exit(2);
  }
  const { uninstall } = require("./lib/uninstall.cjs");
  try {
    const result = uninstall(repoRoot, { purgeMemory: args.has("--purge-memory"), force: args.has("--force") });
    for (const item of result.log) console.log(`${item.level.padEnd(9)} ${item.text}`);
    process.exit(0);
  } catch (error) {
    console.error(`ERROR     ${error.message}`);
    process.exit(1);
  }
}
const entry = path.join(repoRoot, "dist", "src", "cli", "alp.js");
if (!fs.existsSync(entry)) {
  const built = spawnSyncCommand("npm", ["run", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (built.error || built.status !== 0) {
    console.error(`ERROR     cannot build ALP TypeScript CLI${built.error ? `: ${built.error.message}` : ""}`);
    process.exit(built.status || 2);
  }
}

process.env.ALP_REPO_ROOT = repoRoot;
require(entry).main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (error) => {
    console.error(`ERROR     ${error && error.message ? error.message : String(error)}`);
    process.exitCode = 2;
  },
);

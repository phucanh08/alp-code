#!/usr/bin/env node
// test-pack-release.cjs — kiểm hợp đồng nội dung artifact NGAY TRONG repo, không cần phát hành.
//
// Từ v0.9.0 máy người dùng không build gì nữa, nên mọi thứ họ cần phải nằm sẵn trong tarball.
// Thiếu một file chỉ lộ ra ở máy người dùng, sau khi đã publish — muộn nhất có thể. `npm pack
// --dry-run` cho đúng danh sách file mà `npm publish` sẽ gửi đi, chạy offline và trong một
// giây, nên chỗ để phát hiện là ở đây.

"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { REQUIRED, FORBIDDEN, verifyEntries } = require("./lib/release-manifest.cjs");

const repoRoot = path.resolve(__dirname, "..");
let failed = 0;

// `--ignore-scripts` để test không kéo theo một lần tsc: danh sách file thì không đổi, nhưng
// `dist/` phải có sẵn mới liệt kê được.
if (!fs.existsSync(path.join(repoRoot, "dist", "src", "cli", "alp.js"))) {
  console.log("SKIP             pack-release: chưa có dist/ — chạy `npm run build` trước");
  process.exit(0);
}

const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: repoRoot,
  encoding: "utf8",
});
if (packed.status !== 0) {
  console.log(`FAIL             npm pack --dry-run thất bại: ${(packed.stderr || "").trim().split("\n").slice(-3).join(" · ")}`);
  process.exit(1);
}
const entries = parseEntries(packed.stdout);

check("`files` của package.json gói đủ mọi thứ bản cài cần để chạy không build", () => {
  const { missing } = verifyEntries(entries);
  assert.deepStrictEqual(missing, [], `thiếu: ${missing.join(", ")}`);
});

check("artifact không mang theo src/, test/ hay memory của maintainer", () => {
  const { leaked } = verifyEntries(entries);
  assert.deepStrictEqual(leaked.slice(0, 10), [], `lọt: ${leaked.slice(0, 10).join(", ")}`);
});

// `bin` sai đường dẫn thì `npm i -g` vẫn xanh, và lệnh `alp` chỉ hỏng khi người dùng gõ nó.
check("bin.alp trỏ vào một file thật và file đó nằm trong artifact", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const bin = pkg.bin?.alp;
  assert(bin, "package.json phải khai báo bin.alp");
  assert(fs.existsSync(path.join(repoRoot, bin)), `${bin} không tồn tại`);
  assert(entries.includes(bin.replace(/\\/g, "/")), `${bin} không nằm trong artifact`);
});

// Cả hai channel đều giải nén ra chạy thẳng, nên dependency runtime phải là dependency thật —
// nằm trong devDependencies thì bản npm thiếu, bản bundle cũng thiếu vì `npm ci --omit=dev`.
check("dependency runtime nằm ở `dependencies`, không phải devDependencies", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const runtime = new Set(Object.keys(pkg.dependencies || {}));
  const imported = new Set();
  for (const file of walk(path.join(repoRoot, "dist", "src"))) {
    for (const match of fs.readFileSync(file, "utf8").matchAll(/require\("([^".][^"]*)"\)/g)) {
      const name = match[1].startsWith("@") ? match[1].split("/").slice(0, 2).join("/") : match[1].split("/")[0];
      if (!name.startsWith("node:") && !require("node:module").builtinModules.includes(name)) imported.add(name);
    }
  }
  const undeclared = [...imported].filter((name) => !runtime.has(name));
  assert.deepStrictEqual(undeclared, [], `dist/ require nhưng không khai báo: ${undeclared.join(", ")}`);
});

if (failed) process.exit(1);
console.log(`OK               pack-release: ${entries.length} file, đủ ${REQUIRED.length} file bắt buộc, không lọt ${FORBIDDEN.length} nhóm cấm`);

function parseEntries(stdout) {
  const parsed = JSON.parse(stdout);
  const files = (Array.isArray(parsed) ? parsed[0] : parsed).files || [];
  return files.map((file) => (typeof file === "string" ? file : file.path));
}

function* walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith(".js")) yield full;
  }
}

function check(name, fn) {
  try {
    fn();
    console.log(`PASS             ${name}`);
  } catch (e) {
    console.log(`FAIL             ${name}\n                 ${e.message.split("\n").join("\n                 ")}`);
    failed++;
  }
}

#!/usr/bin/env node
// test-installer.cjs — install.sh chạy thật, ngoại tuyến.
//
// `curl` và `npm` bị thay bằng script giả đặt trước PATH, còn `node` và `tar` là thật. Nhờ
// vậy test đi qua đúng những dòng chạy trên máy người dùng — tải, giải nén, trỏ `current` —
// mà không cần mạng và không đụng vào máy đang chạy test.
//
// Ba điều đáng khoá lại ở đây: bản mới chỉ được thay khi đã tải xong, `--channel auto` phải
// tự rơi sang tarball khi npm hỏng (lý do tồn tại của channel thứ hai), và không có bước
// build nào trên máy người dùng.

"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

if (process.platform === "win32") {
  console.log("SKIP             install.sh: cần POSIX shell (Windows dùng test-windows-installer.cjs)");
  process.exit(0);
}

const repoRoot = path.resolve(__dirname, "..");
const installer = path.join(repoRoot, "install.sh");
const sandbox = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "alp-installer-"));

try {
  const bundle = makeBundle(path.join(sandbox, "bundle.tar.gz"));
  const fakeBin = makeFakeBin(path.join(sandbox, "bin"), bundle);

  testTarball(fakeBin);
  testNpmFallback(fakeBin);
  testCurrentIsNotADirectory(fakeBin);
  console.log("OK               install.sh: tarball, fallback npm→tarball, và không build gì");
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

function testTarball(fakeBin) {
  const home = path.join(sandbox, "home-tarball");
  const first = install(fakeBin, home, ["--channel", "tarball", "--version", "v9.9.9"]);
  assert.strictEqual(first.status, 0, first.output);
  assert(first.output.includes("BOOTSTRAP_RAN"), `bootstrap phải được gọi: ${first.output}`);

  const installed = path.join(home, "alp-code", "versions", "v9.9.9");
  const link = path.join(home, "alp-code", "current");
  assert(fs.existsSync(path.join(installed, "scripts", "alp.cjs")), "bundle chưa được giải nén");
  assert.strictEqual(fs.realpathSync(link), fs.realpathSync(installed));
  assert(fs.lstatSync(link).isSymbolicLink(), "current phải là symlink, không phải bản sao");

  // Không để lại rác tải dở: người dùng chạy installer nhiều lần là chuyện bình thường.
  const leftovers = fs.readdirSync(path.join(home, "alp-code", "versions")).filter((e) => e.startsWith("."));
  assert.deepStrictEqual(leftovers, [], `còn file tạm: ${leftovers}`);

  const again = install(fakeBin, home, ["--channel", "tarball", "--version", "v9.9.9"]);
  assert.strictEqual(again.status, 0, again.output);
}

function testNpmFallback(fakeBin) {
  const home = path.join(sandbox, "home-auto");
  const result = install(fakeBin, home, ["--version", "v9.9.9"]);
  assert.strictEqual(result.status, 0, result.output);
  assert(result.output.includes("FALLBACK"), `npm hỏng phải rơi sang tarball: ${result.output}`);
  assert(fs.existsSync(path.join(home, "alp-code", "versions", "v9.9.9", "scripts", "alp.cjs")));
}

function testCurrentIsNotADirectory(fakeBin) {
  const home = path.join(sandbox, "home-legacy");
  const link = path.join(home, "alp-code", "current");
  fs.mkdirSync(link, { recursive: true });
  fs.writeFileSync(path.join(link, "keep.txt"), "dữ liệu của người dùng\n");

  const result = install(fakeBin, home, ["--channel", "tarball", "--version", "v9.9.9"]);
  assert.notStrictEqual(result.status, 0, "thư mục thật ở chỗ current phải làm installer dừng");
  assert.match(result.output, /thư mục thật/);
  assert(fs.existsSync(path.join(link, "keep.txt")), "installer không được xoá thư mục có sẵn");
}

function install(fakeBin, home, args) {
  fs.mkdirSync(home, { recursive: true });
  const run = spawnSync("bash", [installer, "--home", path.join(home, "alp-code"), "--no-path", ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      ALP_STATE_HOME: path.join(home, ".alp"),
    },
  });
  return { status: run.status, output: `${run.stdout || ""}${run.stderr || ""}` };
}

/** Bundle giả: đủ hình dạng mà install.sh kiểm, với bootstrap in ra một dấu để test nhận. */
function makeBundle(file) {
  const staging = path.join(sandbox, "bundle-src", "scripts");
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, "alp.cjs"), "#!/usr/bin/env node\n");
  fs.writeFileSync(path.join(staging, "bootstrap.cjs"), 'console.log("BOOTSTRAP_RAN " + __dirname);\n');
  fs.writeFileSync(path.join(sandbox, "bundle-src", "package.json"), '{"name":"alp-code","version":"9.9.9"}\n');
  execFileSync("tar", ["-czf", file, "-C", path.join(sandbox, "bundle-src"), "."]);
  return file;
}

/**
 * `curl` giả trả file cục bộ, `npm` giả luôn hỏng.
 *
 * npm hỏng là trạng thái đáng test nhất của `--channel auto`: registry bị chặn hoặc thư mục
 * global không ghi được là chuyện thường ở máy công ty, và đó đúng là lúc người dùng cần
 * installer tự đi tiếp thay vì dừng lại.
 */
function makeFakeBin(dir, bundle) {
  fs.mkdirSync(dir, { recursive: true });
  write(path.join(dir, "curl"), `#!/usr/bin/env bash
out=""
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift; out="$1" ;;
    -*) ;;
    *) url="$1" ;;
  esac
  shift
done
case "$url" in
  *releases/latest) printf '{"tag_name":"v9.9.9"}\\n' ;;
  *bundle.tar.gz)
    if [ -n "$out" ]; then cp ${JSON.stringify(bundle)} "$out"; else cat ${JSON.stringify(bundle)}; fi ;;
  *) echo "fake curl: url lạ $url" >&2; exit 22 ;;
esac
`);
  write(path.join(dir, "npm"), `#!/usr/bin/env bash
echo "npm ERR! EACCES (fake)" >&2
exit 243
`);
  return dir;
}

function write(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

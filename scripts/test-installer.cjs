#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

if (process.platform === "win32") {
  console.log("SKIP             install.sh: POSIX only");
  process.exit(0);
}

const repoRoot = path.resolve(__dirname, "..");
const installer = path.join(repoRoot, "install.sh");
const sandbox = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "alp-native-installer-"));
const target = process.platform === "darwin"
  ? `${process.platform}-${execFileSync("uname", ["-m"], { encoding: "utf8" }).trim() === "arm64" ? "arm64" : "x64"}`
  : `linux-${process.arch === "arm64" ? "arm64" : "x64"}-gnu`;

try {
  const release = makeRelease();
  const fakeBin = makeFakeBin(path.join(sandbox, "fake-bin"), release);
  testFreshAndRepeat(fakeBin);
  testForeignCurrent(fakeBin);
  testChecksumPreservesCurrent(fakeBin, release);
  console.log("PASS             install.sh native no-Node lifecycle");
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

function testFreshAndRepeat(fakeBin) {
  const home = path.join(sandbox, "fresh");
  const first = install(fakeBin, home, ["--version", "v9.9.9"]);
  assert.equal(first.status, 0, first.output);
  assert(!first.output.includes("NODE_CALLED"), first.output);
  const installHome = path.join(home, "alp-code");
  const version = path.join(installHome, "versions", "v9.9.9");
  assert.equal(fs.realpathSync(path.join(installHome, "current")), fs.realpathSync(version));
  assert.equal(fs.realpathSync(path.join(installHome, "bin", "alp")), path.join(version, "bin", "alp"));
  assert(fs.existsSync(path.join(home, ".alp", "ensured")), "native ensure-state was not called");
  assert.equal(install(fakeBin, home, ["--version", "v9.9.9"]).status, 0);
  assert.deepEqual(fs.readdirSync(installHome).filter((name) => name.startsWith(".staging")), []);
}

function testForeignCurrent(fakeBin) {
  const home = path.join(sandbox, "foreign-current");
  const current = path.join(home, "alp-code", "current");
  fs.mkdirSync(current, { recursive: true });
  fs.writeFileSync(path.join(current, "keep"), "user\n");
  const result = install(fakeBin, home, ["--version", "v9.9.9"]);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /not a symlink|không phải symlink/);
  assert(fs.existsSync(path.join(current, "keep")));
}

function testChecksumPreservesCurrent(fakeBin, release) {
  const home = path.join(sandbox, "bad-checksum");
  assert.equal(install(fakeBin, home, ["--version", "v9.9.9"]).status, 0);
  const before = fs.realpathSync(path.join(home, "alp-code", "current"));
  fs.writeFileSync(release.checksums, `${"0".repeat(64)}  ${path.basename(release.archive)}\n`);
  const result = install(fakeBin, home, ["--version", "v9.9.10"]);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /checksum/i);
  assert.equal(fs.realpathSync(path.join(home, "alp-code", "current")), before);
}

function install(fakeBin, home, args) {
  fs.mkdirSync(home, { recursive: true });
  const result = spawnSync("bash", [installer, "--home", path.join(home, "alp-code"), "--no-path", ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      ALP_STATE_HOME: path.join(home, ".alp"),
      ALP_REPO_SLUG: "example/alp-code",
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    },
  });
  return { status: result.status, output: `${result.stdout || ""}${result.stderr || ""}` };
}

function makeRelease() {
  const source = path.join(sandbox, "payload");
  fs.mkdirSync(path.join(source, "bin"), { recursive: true });
  fs.mkdirSync(path.join(source, "skills", "search"), { recursive: true });
  fs.mkdirSync(path.join(source, "scaffold", "memory"), { recursive: true });
  const binary = path.join(source, "bin", "alp");
  fs.writeFileSync(binary, `#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo "alp 9.9.9"; exit 0; fi
if [ "\${1:-}" = "__internal" ] && [ "\${2:-}" = "ensure-state" ]; then mkdir -p "\${ALP_STATE_HOME}"; touch "\${ALP_STATE_HOME}/ensured"; exit 0; fi
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(source, "skills", "search", "SKILL.md"), "# Search\n");
  fs.writeFileSync(path.join(source, "scaffold", "memory", "INDEX.md"), "# Memory\n");
  fs.writeFileSync(path.join(source, "LICENSE"), "MIT\n");
  fs.writeFileSync(path.join(source, "install-manifest.json"), `${JSON.stringify({
    schemaVersion: 1, app: "alp-code", version: "9.9.9", target,
    compiler: { name: "bun", version: "1.4.2" },
  })}\n`);
  const filename = `alp-code-v9.9.9-${target}.tar.gz`;
  const archive = path.join(sandbox, filename);
  execFileSync("tar", ["-czf", archive, "-C", source, "."]);
  const checksums = path.join(sandbox, "SHA256SUMS");
  fs.writeFileSync(checksums, `${crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex")}  ${filename}\n`);
  return { archive, checksums };
}

function makeFakeBin(directory, release) {
  fs.mkdirSync(directory, { recursive: true });
  writeExecutable(path.join(directory, "node"), "#!/bin/sh\necho NODE_CALLED >&2\nexit 99\n");
  writeExecutable(path.join(directory, "npm"), "#!/bin/sh\necho NPM_CALLED >&2\nexit 99\n");
  writeExecutable(path.join(directory, "curl"), `#!/usr/bin/env bash
out=""
url=""
while [ $# -gt 0 ]; do
  case "$1" in -o) shift; out="$1" ;; -*) ;; *) url="$1" ;; esac
  shift
done
case "$url" in
  *releases/latest) printf '{"tag_name":"v9.9.9"}\\n' ;;
  *SHA256SUMS) cp ${JSON.stringify(release.checksums)} "$out" ;;
  *alp-code-v9.9.*-${target}.tar.gz) cp ${JSON.stringify(release.archive)} "$out" ;;
  *) echo "unexpected URL: $url" >&2; exit 22 ;;
esac
`);
  return directory;
}

function writeExecutable(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

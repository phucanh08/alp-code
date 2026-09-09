#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { ensurePayload, safeName } = require("../npm-wrapper/lib/install-payload.cjs");
const { definitions, resolveTarget } = require("../npm-wrapper/lib/resolve-target.cjs");

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "alp-npm-wrapper-"));

main().finally(() => fs.rmSync(root, { recursive: true, force: true }));

async function main() {
  assert.deepEqual(definitions().map((target) => target.id), [
    "darwin-arm64", "darwin-x64", "linux-x64-gnu", "linux-arm64-gnu", "windows-x64",
  ]);
  assert.throws(() => safeName("../escape"), /unsafe/);
  assert.throws(() => safeName("skill/link", "../../escape"), /unsafe/);

  const target = resolveTarget();
  const version = "9.9.9";
  const payload = path.join(root, "payload");
  fs.mkdirSync(path.join(payload, "bin"), { recursive: true });
  fs.mkdirSync(path.join(payload, "skills"));
  fs.mkdirSync(path.join(payload, "scaffold"));
  const executable = path.join(payload, "bin", target.executable);
  fs.writeFileSync(executable, process.platform === "win32"
    ? "@echo off\r\necho alp 9.9.9\r\n"
    : "#!/bin/sh\necho 'alp 9.9.9'\n", { mode: 0o755 });
  fs.writeFileSync(path.join(payload, "install-manifest.json"), `${JSON.stringify({
    schemaVersion: 1, app: "alp-code", version, target: target.id, compiler: { name: "bun", version: "1.4.2" },
  })}\n`);
  const filename = `alp-code-v${version}-${target.id}.tar.gz`;
  const archiveFile = path.join(root, filename);
  execFileSync("tar", ["-czf", archiveFile, "-C", payload, "."]);
  const archive = fs.readFileSync(archiveFile);
  const sums = Buffer.from(`${crypto.createHash("sha256").update(archive).digest("hex")}  ${filename}\n`);
  let fetched = 0;
  const fetcher = async (url) => {
    fetched += 1;
    return new Response(url.endsWith("SHA256SUMS") ? sums : archive, { status: 200 });
  };
  const options = {
    packageDocument: { version }, target, home: root, cache: path.join(root, "cache"), fetcher,
    baseUrl: "https://release.invalid/v9.9.9",
  };
  const first = await ensurePayload(options);
  assert.equal(first.root, path.join(root, "cache", "versions", version, target.id));
  assert.equal(fetched, 2);
  const second = await ensurePayload({ ...options, fetcher: async () => { throw new Error("offline"); } });
  assert.equal(second.executable, first.executable);
  assert.equal(fetched, 2);
  assert.deepEqual(fs.readdirSync(path.join(root, "cache")).filter((name) => name.startsWith(".staging")), []);

  const wrapperVersion = require("../npm-wrapper/package.json").version;
  const launcherCache = path.join(root, "launcher-cache");
  const launcherRoot = path.join(launcherCache, "versions", wrapperVersion, target.id);
  fs.mkdirSync(path.join(launcherRoot, "bin"), { recursive: true });
  fs.mkdirSync(path.join(launcherRoot, "skills"));
  fs.mkdirSync(path.join(launcherRoot, "scaffold"));
  const launcherExecutable = path.join(launcherRoot, "bin", target.executable);
  fs.writeFileSync(launcherExecutable, process.platform === "win32"
    ? `@echo off\r\nif "%1"=="--version" (echo alp ${wrapperVersion}& exit /b 0)\r\necho %ALP_LAYOUT_CHANNEL%^|%ALP_WRAPPER_VERSION%\r\nexit /b 17\r\n`
    : `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'alp ${wrapperVersion}'; exit 0; fi\nprintf '%s|%s\\n' "$ALP_LAYOUT_CHANNEL" "$ALP_WRAPPER_VERSION"\nexit 17\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(launcherRoot, "install-manifest.json"), JSON.stringify({
    schemaVersion: 1, app: "alp-code", version: wrapperVersion, target: target.id,
    compiler: { name: "bun", version: "1.4.2" },
  }));
  const launched = spawnSync(process.execPath, [path.join(__dirname, "..", "npm-wrapper", "bin", "alp.cjs"), "probe"], {
    encoding: "utf8", env: { ...process.env, HOME: root, ALP_NPM_CACHE: launcherCache },
  });
  assert.equal(launched.status, 17, launched.stderr);
  assert.match(launched.stdout, new RegExp(`npm\\|${wrapperVersion}`));
  assert(fs.existsSync(path.join(launcherCache, "bin", process.platform === "win32" ? "alp.cmd" : "alp")));
  console.log("PASS             npm wrapper exact-version cached payload");
}

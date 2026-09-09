#!/usr/bin/env node
"use strict";

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const packageDocument = require("../package.json");
const { ensurePayload } = require("../lib/install-payload.cjs");

async function main() {
  const payload = await ensurePayload({ packageDocument });
  const stableCommand = ensureStableCommand(payload.root);
  const child = spawn(payload.executable, process.argv.slice(2), {
    stdio: "inherit",
    env: {
      ...process.env,
      ALP_LAYOUT_CHANNEL: "npm",
      ALP_INSTALL_ROOT: payload.root,
      ALP_STABLE_COMMAND: stableCommand,
      ALP_WRAPPER_VERSION: packageDocument.version,
    },
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => { try { child.kill(signal); } catch {} });
  }
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      process.exitCode = code ?? (signal ? 128 + (os.constants.signals[signal] || 0) : 1);
      resolve();
    });
  });
}

function ensureStableCommand(payloadRoot) {
  if (process.env.ALP_NPM_STABLE_COMMAND) return path.resolve(process.env.ALP_NPM_STABLE_COMMAND);
  const cache = path.dirname(path.dirname(path.dirname(payloadRoot)));
  const directory = path.join(cache, "bin");
  const target = path.join(directory, process.platform === "win32" ? "alp.cmd" : "alp");
  const marker = process.platform === "win32" ? "@rem alp-code npm wrapper" : "# alp-code npm wrapper";
  const body = process.platform === "win32"
    ? `${marker}\r\n@echo off\r\n\"${process.execPath}\" \"${__filename}\" %*\r\n`
    : `#!/bin/sh\n${marker}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(__filename)} \"$@\"\n`;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.existsSync(target) && !fs.readFileSync(target, "utf8").includes(marker)) {
    throw new Error(`refusing to replace foreign npm stable command: ${target}`);
  }
  fs.writeFileSync(target, body, { mode: 0o755 });
  return target;
}

main().catch((error) => {
  console.error(`ERROR     ${error.message}`);
  console.error("          Reconnect and retry, or install the direct binary from https://github.com/phucanh08/alp-code/releases");
  process.exitCode = 1;
});

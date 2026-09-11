import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

declare const __ALP_BUILD_VERSION__: string | undefined;
declare const __ALP_COMPILER_NAME__: string | undefined;
declare const __ALP_COMPILER_VERSION__: string | undefined;

function injected(name: string, value: string | undefined, fallback: () => string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback();
}

// Chỉ bản binary mới được inject `__ALP_BUILD_VERSION__` qua `--define`. Dev clone và npm chạy
// qua dist/ của tsc thì không có gì được inject, nên phải đọc package.json — hardcode một chuỗi
// ở đây sẽ đóng băng `alp --version` ở bản đó mãi mãi dù `alp update` đã checkout tag mới.
function packageVersion(): string {
  let directory = __dirname;
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
      if (manifest.name === "alp-code" && typeof manifest.version === "string") return manifest.version;
    } catch { /* continue */ }
    const parent = dirname(directory);
    if (parent === directory) return "0.0.0";
    directory = parent;
  }
}

export const BUILD_VERSION = injected(
  "__ALP_BUILD_VERSION__",
  typeof __ALP_BUILD_VERSION__ === "undefined" ? undefined : __ALP_BUILD_VERSION__,
  packageVersion,
);
export const BUILD_COMPILER = injected(
  "__ALP_COMPILER_NAME__",
  typeof __ALP_COMPILER_NAME__ === "undefined" ? undefined : __ALP_COMPILER_NAME__,
  () => "node-dev",
);
export const BUILD_COMPILER_VERSION = injected(
  "__ALP_COMPILER_VERSION__",
  typeof __ALP_COMPILER_VERSION__ === "undefined" ? undefined : __ALP_COMPILER_VERSION__,
  () => process.version,
);

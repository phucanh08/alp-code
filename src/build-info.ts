declare const __ALP_BUILD_VERSION__: string | undefined;
declare const __ALP_COMPILER_NAME__: string | undefined;
declare const __ALP_COMPILER_VERSION__: string | undefined;

function injected(name: string, value: string | undefined, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export const BUILD_VERSION = injected(
  "__ALP_BUILD_VERSION__",
  typeof __ALP_BUILD_VERSION__ === "undefined" ? undefined : __ALP_BUILD_VERSION__,
  "0.10.0",
);
export const BUILD_COMPILER = injected(
  "__ALP_COMPILER_NAME__",
  typeof __ALP_COMPILER_NAME__ === "undefined" ? undefined : __ALP_COMPILER_NAME__,
  "node-dev",
);
export const BUILD_COMPILER_VERSION = injected(
  "__ALP_COMPILER_VERSION__",
  typeof __ALP_COMPILER_VERSION__ === "undefined" ? undefined : __ALP_COMPILER_VERSION__,
  process.version,
);

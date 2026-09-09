import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { InstallChannel } from "../install-layout";
import { defaultDelegationDirectory } from "./paths";

export class InvalidConfiguration extends Error {
  readonly code = "InvalidConfiguration";
  constructor(message: string) { super(message); this.name = "InvalidConfiguration"; }
}

export function parseConfig(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; value: Record<string, unknown> }> = [{ indent: -1, value: root }];
  for (const raw of String(text).split(/\r?\n/)) {
    const clean = raw.replace(/^\s*#.*$/, "").replace(/\s+#.*$/, "");
    if (!clean.trim()) continue;
    const match = clean.match(/^(\s*)([a-zA-Z_][\w-]*):(?:\s*(.*))?$/);
    if (!match) throw new InvalidConfiguration(`Dòng config không hợp lệ: ${raw.trim()}`);
    const indent = match[1].length;
    while (stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].value;
    const key = match[2];
    const source = (match[3] || "").trim();
    if (!source) {
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ indent, value: child });
    } else if (/^(?:true|false)$/i.test(source)) parent[key] = source.toLowerCase() === "true";
    else parent[key] = source.replace(/^(["'])(.*)\1$/, "$2");
  }
  return root;
}

export function loadDelegationConfig(
  installRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  channel: InstallChannel = "dev",
): { file: string; stateDir: string } {
  const file = env.ALP_CONFIG || join(installRoot, "alp.config.yaml");
  const document = existsSync(file) ? parseConfig(readFileSync(file, "utf8")) : {};
  const delegation = (document.delegation ?? {}) as Record<string, unknown>;
  const configured = delegation.state_dir;
  if (configured !== undefined && typeof configured !== "string") {
    throw new InvalidConfiguration("delegation.state_dir phải là đường dẫn");
  }
  const stateDir = env.ALP_DELEGATION_STATE_DIR || configured || defaultDelegationDirectory(installRoot, env, channel);
  return { file, stateDir: resolve(stateDir) };
}

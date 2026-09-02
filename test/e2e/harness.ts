import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { agentRegistry } from "../../src/agents/registry";
import type { RuntimeId } from "../../src/agents/types";
import { LocalProcessBackend } from "../../src/backend/local-process-backend";
import { ExecutionService } from "../../src/execution/execution-service";
import { FileExecutionStore } from "../../src/execution/execution-store";
import { MarkdownFileStore } from "../../src/memory/adapters/markdown-file-store";
import { MemoryService } from "../../src/memory/memory-service";
import { PolicyEngine } from "../../src/policy/policy-engine";
import { ClaudeRuntimeAdapter } from "../../src/runtime/claude-adapter";
import { CodexRuntimeAdapter } from "../../src/runtime/codex-adapter";
import type { RuntimeAdapter } from "../../src/runtime/runtime-adapter";
import { WorkflowRunner } from "../../src/workflow/workflow-runner";
import { removeTemporary } from "../support/temporary-root";

/**
 * Fake runtime binaries stand in for `claude` and `codex` so end-to-end tests never
 * reach a paid model. Each one records the launch contract it was given and then
 * finalizes its own execution state the way a real runtime would.
 */
const FAKE_RUNTIME = (runtime: RuntimeId) => `"use strict";
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const argv = process.argv.slice(2);
const promptMatch = /input is in (.+); read it before continuing\\.$/.exec(argv[argv.length - 1] || "");
const capsuleFile = process.env.ALP_IDENTITY_CAPSULE;
const record = {
  runtime: ${JSON.stringify(runtime)},
  command: process.env.ALP_E2E_COMMAND,
  argv,
  cwd: process.cwd(),
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("ALP_"))),
  capsule: capsuleFile ? JSON.parse(readFileSync(capsuleFile, "utf8")) : null,
  prompt: promptMatch ? readFileSync(promptMatch[1], "utf8") : null,
  runtimeConfig: process.env.ALP_RUNTIME_CONFIG ? readFileSync(process.env.ALP_RUNTIME_CONFIG, "utf8") : null,
};
writeFileSync(join(process.env.ALP_E2E_CAPTURE, ${JSON.stringify(runtime)} + ".json"), JSON.stringify(record, null, 2));

if (process.env.ALP_E2E_OUTPUT) {
  const stateFile = join(process.env.ALP_EXECUTION_ROOT, process.env.ALP_DELEGATION_EXECUTION_ID, "state.json");
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  writeFileSync(stateFile, JSON.stringify({ ...state, status: "completed", output: process.env.ALP_E2E_OUTPUT }));
}
process.exit(Number(process.env.ALP_E2E_EXIT || 0));
`;

export interface E2eEnvironment {
  readonly root: string;
  readonly project: string;
  readonly executionsRoot: string;
  readonly memoryRoot: string;
  readonly captureDirectory: string;
  readonly binDirectory: string;
  readonly policy: PolicyEngine;
  readonly memory: MemoryService;
  readonly executionService: ExecutionService;
  readonly adapters: ReadonlyMap<RuntimeId, RuntimeAdapter>;
  readonly backend: LocalProcessBackend;
  readonly runtimeEnv: NodeJS.ProcessEnv;
  readonly canonicalizePath: (value: string) => string;
  capture(runtime: RuntimeId): Promise<RuntimeCapture>;
}

export interface RuntimeCapture {
  readonly runtime: RuntimeId;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly capsule: {
    readonly executionId: string;
    readonly role: string;
    readonly displayName: string;
    readonly instructions: string;
    readonly activeWorkspace: string;
    readonly allowedTools: readonly string[];
    readonly outputContract: { readonly name: string };
  };
  readonly prompt: string;
  readonly runtimeConfig: string;
}

const roots: string[] = [];

export async function cleanupEnvironments(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => removeTemporary(root)));
}

/**
 * Builds the real composition — registry, policy, memory, execution service, runtime
 * adapters, local process backend — around a throwaway filesystem and fake binaries.
 */
export async function createE2eEnvironment(options: {
  /** Prose the fake runtime writes back as the execution's answer. */
  readonly output?: string;
  readonly exitCode?: number;
} = {}): Promise<E2eEnvironment> {
  // Canonical from the start: the execution service realpaths every workspace it prepares.
  const root = await realpath(await mkdtemp(join(tmpdir(), "alp-e2e-")));
  roots.push(root);
  const project = join(root, "project");
  const executionsRoot = join(root, "executions");
  const memoryRoot = join(root, "memory");
  const captureDirectory = join(root, "capture");
  const binDirectory = join(root, "bin");
  const hooksDirectory = join(process.cwd(), "hooks");
  await Promise.all([project, executionsRoot, memoryRoot, captureDirectory, binDirectory]
    .map((directory) => mkdir(directory, { recursive: true })));
  await writeFile(join(project, "index.ts"), "export const entrypoint = true;\n");

  // The adapters emit a bare command name (`claude`), so the fake has to be findable on
  // PATH the way the platform finds executables. A `#!` script is not executable on
  // Windows at all, so there the launcher is a `.cmd` that libuv resolves via PATHEXT.
  for (const runtime of ["claude", "codex"] as const) {
    const script = join(binDirectory, `${runtime}.js`);
    await writeFile(script, FAKE_RUNTIME(runtime));
    if (process.platform === "win32") {
      // Shaped like an npm-generated shim so the spawn path exercises the real unwrapper.
      await writeFile(
        join(binDirectory, `${runtime}.cmd`),
        `@ECHO off\r\nSETLOCAL\r\nSET "_prog=${process.execPath}"\r\n"%_prog%" "%~dp0\\${runtime}.js" %*\r\n`,
      );
      continue;
    }
    const executable = join(binDirectory, runtime);
    await writeFile(executable, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
    await chmod(executable, 0o755);
  }

  // `alp` always runs from the project, so relative workspace grants (".") resolve there.
  const canonicalizePath = (value: string): string => {
    const absolute = isAbsolute(value) ? value : resolve(project, value);
    try { return realpathSync(absolute); } catch { return absolute; }
  };
  const policy = new PolicyEngine({ registry: agentRegistry, canonicalizePath });
  const memory = new MemoryService({
    store: new MarkdownFileStore({ root: memoryRoot }),
    policy,
    audit: { record() {} },
  });
  const executionService = new ExecutionService({
    registry: agentRegistry,
    policy,
    memory,
    workflowRunner: new WorkflowRunner(),
    store: new FileExecutionStore({ root: executionsRoot }),
  });
  // Adapters probe PATH, so the fake bin directory is the only runtime they can find.
  const adapterEnv = { HOME: root, PATH: binDirectory, ALP_REPO_ROOT: root, ALP_MEMORY_ROOT: memoryRoot };
  const adapters = new Map<RuntimeId, RuntimeAdapter>([
    // No pinned platform: these adapters really spawn, so they must resolve the command
    // the way the host does. Pinning "linux" on Windows yields a name nothing can launch.
    ["claude", new ClaudeRuntimeAdapter({ env: adapterEnv, hooksDirectory })],
    ["codex", new CodexRuntimeAdapter({ env: adapterEnv, hooksDirectory })],
  ]);
  const runtimeEnv: NodeJS.ProcessEnv = {
    PATH: binDirectory,
    HOME: root,
    ALP_E2E_CAPTURE: captureDirectory,
    ...(options.output === undefined ? {} : { ALP_E2E_OUTPUT: options.output }),
    ...(options.exitCode === undefined ? {} : { ALP_E2E_EXIT: String(options.exitCode) }),
  };

  return {
    root,
    project,
    executionsRoot,
    memoryRoot,
    captureDirectory,
    binDirectory,
    policy,
    memory,
    executionService,
    adapters,
    backend: new LocalProcessBackend({ env: runtimeEnv, stdio: "pipe" }),
    runtimeEnv,
    canonicalizePath,
    async capture(runtime) {
      return JSON.parse(await readFile(join(captureDirectory, `${runtime}.json`), "utf8")) as RuntimeCapture;
    },
  };
}

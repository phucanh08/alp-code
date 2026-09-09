import * as fs from "node:fs";

export const STDOUT_BYTES = Buffer.from("alp-stdout\0\u2603\n", "utf8");
export const STDERR_BYTES = Buffer.from("alp-stderr\0\u26a0\n", "utf8");

function signalExitCode(signal: NodeJS.Signals): number {
  return signal === "SIGINT" ? 130 : 143;
}

export async function runChildMode(mode: string, args: string[]): Promise<boolean> {
  if (mode === "child-output") {
    process.stdout.write(STDOUT_BYTES);
    process.stderr.write(STDERR_BYTES);
    return true;
  }

  if (mode === "exit-code") {
    process.exit(23);
  }

  if (mode === "echo-stdin") {
    for await (const chunk of process.stdin) process.stdout.write(chunk);
    return true;
  }

  if (mode === "mark") {
    fs.writeFileSync(args[0], "complete\n");
    return true;
  }

  if (mode === "delayed-marker") {
    await new Promise((resolve) => setTimeout(resolve, 250));
    fs.writeFileSync(args[0], `${process.pid}\n`);
    return true;
  }

  if (mode === "signal-child") {
    const signal = args[0] as NodeJS.Signals;
    const readyPath = args[1];
    const markerPath = args[2];
    process.on(signal, () => {
      fs.writeFileSync(markerPath, `${signal}\n`);
      process.exit(signalExitCode(signal));
    });
    fs.writeFileSync(readyPath, `${process.pid}\n`);
    setInterval(() => {}, 1000);
    await new Promise(() => {});
    return true;
  }

  if (mode === "path-report") {
    process.stdout.write(
      JSON.stringify({
        execPath: process.execPath,
        argv: process.argv,
        resolvedExecPath: fs.realpathSync(process.execPath),
      }),
    );
    return true;
  }

  return false;
}

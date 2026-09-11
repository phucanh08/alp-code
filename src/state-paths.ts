import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Nơi ALP giữ state cục bộ, phía TypeScript.
 *
 * Từ v0.9.0 thư mục cài là artifact dùng một lần — `npm i -g` xoá sạch package dir cũ, bản
 * tarball giải nén sang `versions/<tag>` mới — nên không thứ gì của người dùng được nằm trong
 * đó. Mọi thứ sống lâu hơn một version đều ở `~/.alp`.
 *
 * Cùng bộ luật này có một bản CommonJS ở `scripts/lib/install-paths.cjs` cho installer và các
 * script bảo trì, vì chúng phải chạy được khi `dist/` chưa tồn tại hoặc đã hỏng.
 * `test/cli/state-paths.test.ts` so hai bản với nhau để chúng không trôi khỏi nhau.
 */
export function stateHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ALP_STATE_HOME) return resolve(env.ALP_STATE_HOME);
  const home = env.HOME || env.USERPROFILE || homedir();
  if (!home) throw new Error("không xác định được HOME/USERPROFILE");
  return join(home, ".alp");
}

/** `ALP_MEMORY_ROOT` vẫn thắng: đó là đường duy nhất chạy được một ALP cô lập hoàn toàn. */
export function memoryRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.ALP_MEMORY_ROOT ? resolve(env.ALP_MEMORY_ROOT) : join(stateHome(env), "memory");
}

/** `~/.alp/agents/<role>.md` — cache identity phẳng mà SessionStart hook đọc. */
export function agentsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateHome(env), "agents");
}

/**
 * Đường dẫn hook ổn định để ghi vào cấu hình project.
 *
 * File nhận đường dẫn này nằm trong repo của người dùng và sống lâu hơn mọi bản cài ALP.
 * Trỏ thẳng vào thư mục cài là hẹn ngày hỏng câm: lên version, đổi channel, hay gỡ rồi cài
 * lại chỗ khác đều làm nó chết mà phiên `claude` chỉ im lặng mất identity.
 */
export function hookForwarder(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(stateHome(env), "hooks", `${name}.cjs`);
}

export function executionsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateHome(env), "executions");
}

/**
 * `~/.alp/execution-graphs/` — một file JSON cho mỗi cây execution.
 *
 * Tách khỏi `executions/` vì hai thứ có vòng đời khác nhau: `executions/<id>/` là artifact
 * của một execution đơn lẻ và dọn được từng cái, còn graph là quyền lực logic của cả cây —
 * dọn nhầm nó là gỡ trần của những execution vẫn đang chạy.
 */
export function executionGraphsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateHome(env), "execution-graphs");
}

/**
 * `~/.alp/threads/<threadId>/` — một thư mục cho mỗi Thread: index `thread.json` cạnh
 * payload context/message/compaction bất biến.
 *
 * Tách khỏi `execution-graphs/` vì Thread sống lâu hơn mọi graph của nó: dọn một graph là
 * dọn một lần chạy, dọn một Thread là xoá cả công việc.
 */
export function threadsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateHome(env), "threads");
}

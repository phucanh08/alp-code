import { rm } from "node:fs/promises";

/**
 * Windows releases file handles lazily — the indexer, antivirus, or a child process that
 * has only just exited can all still hold one — so deleting a fresh temporary tree fails
 * with ENOTEMPTY often enough to make the suite flaky for reasons that say nothing about
 * the code under test. `rm` retries exactly that class of error when asked; nothing else
 * about the delete changes.
 */
export function removeTemporary(path: string): Promise<void> {
  return rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

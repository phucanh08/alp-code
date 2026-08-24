const fs = require("fs");
const path = require("path");
const { InvalidConfiguration } = require("./errors.cjs");

class FileExecutionStore {
  constructor(file) { this.file = file; }

  get(executionId) {
    return this.read().executions[executionId] || null;
  }

  put(record) {
    return this.mutate((state) => {
      state.executions[record.executionId] = { ...record };
      return state.executions[record.executionId];
    });
  }

  update(executionId, patch) {
    return this.mutate((state) => {
      const current = state.executions[executionId];
      if (!current) return null;
      state.executions[executionId] = {
        ...current,
        ...patch,
        executionId,
        updatedAt: new Date().toISOString(),
      };
      return state.executions[executionId];
    });
  }

  list() { return Object.values(this.read().executions); }

  read() {
    if (!fs.existsSync(this.file)) return { version: 1, executions: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return { version: 1, executions: parsed.executions || {} };
    } catch (error) {
      throw new InvalidConfiguration(`Delegation state hỏng tại ${this.file}: ${error.message}`, {
        cause: error,
      });
    }
  }

  mutate(change) {
    const unlock = this.lock();
    try {
      const state = this.read();
      const value = change(state);
      this.write(state);
      return value;
    } finally {
      unlock();
    }
  }

  lock(timeoutMs = 5000) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const lockDir = `${this.file}.lock`;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        fs.mkdirSync(lockDir);
        return () => fs.rmSync(lockDir, { recursive: true, force: true });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          if (Date.now() - fs.statSync(lockDir).mtimeMs > 30000) {
            fs.rmSync(lockDir, { recursive: true, force: true });
            continue;
          }
        } catch {}
        if (Date.now() >= deadline)
          throw new InvalidConfiguration(`Timeout khi lock delegation state ${this.file}`);
        sleep(20);
      }
    }
  }

  write(state) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

module.exports = { FileExecutionStore };

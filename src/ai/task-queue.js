/**
 * 共享异步任务队列与有界并发控制器 (src/ai/task-queue.js)
 *
 * 遵循 AGENTS.md 契约：
 * 提供有界并发、错误重试、进度报告与 AbortController 取消原语。
 * 纯算法与流程控制，不依赖任何特定业务模型。
 */

class TaskQueue {
  constructor({ concurrency = 3, retryCount = 1, onProgress = null, signal = null } = {}) {
    this.concurrency = Math.max(1, Math.min(32, Number(concurrency) || 3));
    this.retryCount = Math.max(0, Math.min(5, Number(retryCount) || 0));
    this.onProgress = typeof onProgress === "function" ? onProgress : null;
    this.signal = signal;
    this.cancelled = Boolean(signal?.aborted);

    if (signal) {
      signal.addEventListener("abort", () => {
        this.cancelled = true;
      }, { once: true });
    }
  }

  cancel() {
    this.cancelled = true;
  }

  async runAll(items, taskFn) {
    const list = Array.isArray(items) ? [...items] : [];
    const total = list.length;
    let completed = 0;
    let failed = 0;
    let active = 0;
    let index = 0;
    const results = new Array(total);

    const report = (itemIndex, result, error = null) => {
      if (this.onProgress) {
        this.onProgress({
          total,
          completed,
          failed,
          active,
          index: itemIndex,
          result,
          error,
        });
      }
    };

    const runWorker = async () => {
      while (index < total) {
        if (this.cancelled) break;
        const currentIndex = index++;
        const item = list[currentIndex];
        active += 1;

        let lastError = null;
        let success = false;
        for (let attempt = 0; attempt <= this.retryCount; attempt += 1) {
          if (this.cancelled) break;
          try {
            const res = await taskFn(item, currentIndex);
            results[currentIndex] = res;
            success = true;
            completed += 1;
            report(currentIndex, res, null);
            break;
          } catch (err) {
            lastError = err;
            if (err?.name === "AbortError" || this.cancelled) break;
          }
        }

        active -= 1;
        if (!success && !this.cancelled) {
          failed += 1;
          results[currentIndex] = null;
          report(currentIndex, null, lastError);
        }
      }
    };

    const workerCount = Math.min(this.concurrency, total);
    const workers = [];
    for (let i = 0; i < workerCount; i += 1) {
      workers.push(runWorker());
    }

    await Promise.all(workers);
    return results;
  }
}

module.exports = {
  TaskQueue,
};

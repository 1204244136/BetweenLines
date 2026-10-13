const { readResults, removeResultIndexes, removeResults, writeResults } = require("./result-store");

// 结果的集合、修订和落盘时机只有一个 owner；任务指标与阶段规则留在调用方。
const PERSIST_DIRTY_LIMIT = 200;
const PERSIST_MAX_DELAY_MS = 30000;

function emptyMetadata() {
  return { projectKey: "", rowsSignature: "", runId: "", kind: "proofread", total: 0, finishedAt: null };
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
}

function createProofreadResults({ dataDir, timers = { setTimeout, clearTimeout }, onPersistError = () => {} } = {}) {
  const storageOptions = { dataDir };
  let metadata = emptyMetadata();
  let results = new Map();
  let changes = [];
  let revision = 0;
  let dirty = 0;
  let timer = null;

  function sameScope(scope) {
    return metadata.projectKey === scope.projectKey && metadata.rowsSignature === scope.rowsSignature;
  }

  function cancelPersist() {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    dirty = 0;
  }

  function reindex(items) {
    results = new Map();
    changes = [];
    revision = 0;
    for (const item of items) {
      const result = { ...item, resultRevision: ++revision };
      results.set(Number(result.index), result);
      changes.push(result);
    }
  }

  function persist() {
    cancelPersist();
    if (!metadata.projectKey || !metadata.rowsSignature || !results.size) return false;
    const merged = new Map();
    const stored = readResults(metadata.projectKey, metadata.rowsSignature, storageOptions);
    for (const item of stored?.results || []) merged.set(Number(item.index), item);
    for (const [index, item] of results) merged.set(Number(index), item);
    writeResults(metadata.projectKey, metadata.rowsSignature, {
      runId: metadata.runId,
      kind: metadata.kind,
      total: metadata.total,
      finishedAt: metadata.finishedAt || "",
      results: [...merged.values()],
    }, storageOptions);
    return true;
  }

  function persistSafely() {
    try {
      return persist();
    } catch (error) {
      onPersistError(error);
      return false;
    }
  }

  function schedulePersist() {
    dirty += 1;
    if (dirty >= PERSIST_DIRTY_LIMIT) {
      persistSafely();
      return;
    }
    if (timer !== null) return;
    timer = timers.setTimeout(() => {
      timer = null;
      persistSafely();
    }, PERSIST_MAX_DELAY_MS);
    if (typeof timer?.unref === "function") timer.unref();
  }

  function reset({ clearPersisted = false } = {}) {
    cancelPersist();
    if (clearPersisted && metadata.projectKey && metadata.rowsSignature) {
      removeResults(metadata.projectKey, metadata.rowsSignature, storageOptions);
    }
    metadata = emptyMetadata();
    results = new Map();
    changes = [];
    revision = 0;
  }

  return {
    begin(nextMetadata, { reusePrevious = false } = {}) {
      // 快照必须先于 reset；返回独立集合，不把内部 Map 交给任务调度。
      const previous = reusePrevious && metadata.projectKey && metadata.rowsSignature && sameScope(nextMetadata)
        ? new Map(results) : new Map();
      reset();
      metadata = {
        projectKey: nextMetadata.projectKey,
        rowsSignature: nextMetadata.rowsSignature,
        runId: nextMetadata.runId,
        kind: nextMetadata.kind,
        total: nextMetadata.total,
        finishedAt: nextMetadata.finishedAt,
      };
      return previous;
    },
    record(result) {
      const stored = { ...result, resultRevision: ++revision };
      results.set(result.index, stored);
      changes.push(stored);
      schedulePersist();
      return stored;
    },
    get(index) {
      return results.get(index);
    },
    restore(scope, { running = false } = {}) {
      const projectKey = String(scope.projectKey || "");
      const rowsSignature = String(scope.rowsSignature || "");
      if (!projectKey || !rowsSignature || running) return { resetTask: false, metadata: null };
      const resetTask = Boolean((results.size || changes.length) && !sameScope({ projectKey, rowsSignature }));
      if (resetTask) reset();
      if (results.size || changes.length) return { resetTask, metadata: null };
      const stored = readResults(projectKey, rowsSignature, storageOptions);
      if (!stored || !stored.results.length) return { resetTask, metadata: null };
      metadata = {
        projectKey,
        rowsSignature,
        kind: stored.kind || "proofread",
        runId: stored.runId || metadata.runId,
        finishedAt: stored.finishedAt || metadata.finishedAt,
        total: stored.total || stored.results.length,
      };
      reindex(stored.results);
      return { resetTask, metadata: { ...metadata } };
    },
    read(options = {}) {
      const sameRun = Boolean(options.runId) && options.runId === metadata.runId;
      const afterRevision = sameRun ? clampInteger(options.afterRevision, 0, Number.MAX_SAFE_INTEGER, 0) : 0;
      const limit = clampInteger(options.resultLimit, 0, 500, 0);
      const requestedProjectKey = String(options.projectKey || "");
      const requestedRowsSignature = String(options.rowsSignature || "");
      const scopeMatches = (!requestedProjectKey && !requestedRowsSignature)
        || (requestedProjectKey === String(metadata.projectKey || "")
          && requestedRowsSignature === String(metadata.rowsSignature || ""));
      const selected = options.includeResults === false ? []
        : (limit || afterRevision ? changes.slice(afterRevision, limit ? afterRevision + limit : undefined)
          : [...results.values()].sort((a, b) => a.index - b.index));
      const visible = scopeMatches ? selected : [];
      const delivered = options.includeResults === false ? afterRevision
        : (limit || afterRevision ? (visible.length ? visible.at(-1).resultRevision : afterRevision) : revision);
      return {
        results: visible,
        resultRevision: delivered,
        latestResultRevision: revision,
        hasMoreResults: delivered < revision,
      };
    },
    forget(scope, indexes, { memory = true } = {}) {
      const cleared = removeResultIndexes(scope.projectKey, scope.rowsSignature, indexes, storageOptions);
      // 启动兜底只删磁盘，旧内存仍按现有续跑条件取快照；显式清除同步删内存并重编号。
      if (memory && sameScope(scope)) {
        const toRemove = new Set(indexes);
        const remaining = [...results].filter(([index]) => !toRemove.has(Number(index)))
          .map(([, item]) => item).sort((a, b) => Number(a.resultRevision) - Number(b.resultRevision));
        reindex(remaining);
      }
      return cleared;
    },
    reset,
    finish(finishedAt) {
      metadata.finishedAt = finishedAt;
      return persistSafely();
    },
  };
}

module.exports = { createProofreadResults };

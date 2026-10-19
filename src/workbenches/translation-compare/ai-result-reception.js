// 浏览器与 Node 测试使用同一接收实现；整个 factory 可由渲染器注入页面。
// 备注写入与 DOM 留在调用方，接收状态不依赖它们的可变对象。
function createAiResultReception({
  projectKey = "", rowsSignature = "", signatureFor = () => "", ignoredRunIds = [],
  getProfileId = () => null, requestStatus, clearResults,
  onStatus = () => {}, onUnavailable = () => {}, timers = { setTimeout },
} = {}) {
  const received = new Set();
  const clearedRuns = new Set();
  const forgottenIndexes = new Set();
  const deliveries = new WeakMap();
  let runId = "";
  let revision = 0;
  let refreshInFlight = false;
  let statusGeneration = 0;
  let catchupTimer = 0;

  function acknowledgeForgotten(indexes) {
    for (const index of indexes) forgottenIndexes.delete(index);
  }

  function begin(ai) {
    const aiRunId = ai.runId || "";
    const runChanged = Boolean(aiRunId && runId && aiRunId !== runId);
    if (runChanged) {
      received.clear();
      revision = 0;
    }
    if (aiRunId) runId = aiRunId;
    // 换轮观察先于身份检查；已清除运行只拦静止回包，保留原接收时序。
    const receipt = Object.freeze({
      runId: aiRunId, runChanged,
      sameScope: Boolean(ai.projectKey && ai.rowsSignature
        && ai.projectKey === projectKey && ai.rowsSignature === rowsSignature),
      cleared: Boolean(aiRunId && clearedRuns.has(aiRunId) && !ai.running),
    });
    deliveries.set(receipt, ai);
    return receipt;
  }

  function commit(receipt, applyBatch) {
    const ai = deliveries.get(receipt);
    if (!ai) throw new Error("结果交付不属于此接收实例或已处理。");
    deliveries.delete(receipt);
    if (receipt.cleared) return { applied: 0, skippedStale: 0, ignoredForeign: false };
    const accepted = [];
    let skippedStale = 0;
    if (receipt.sameScope) {
      for (const result of ai.results || []) {
        if (forgottenIndexes.has(Number(result.index))) continue;
        if (ignoredRunIds.includes(result.runId || ai.runId)) continue;
        // 兼容旧结果：去重键仍取结果自己的 runId，版本缺失时回落到 status。
        const key = result.runId + ":" + result.index + ":" + (result.resultRevision || result.status);
        if (received.has(key)) continue;
        received.add(key);
        const signature = signatureFor(String(result.index));
        if (signature && result.signature !== signature) {
          skippedStale += 1;
          continue;
        }
        accepted.push(result);
      }
    }
    const delivery = {
      applied: accepted.length, skippedStale,
      ignoredForeign: !receipt.sameScope && Boolean((ai.results || []).length && !ai.running),
    };
    // 写入或提示抛错时不推进游标；保存返回失败仍保留内存成果，并照常消费交付。
    applyBatch(accepted, delivery);
    revision = Math.max(revision, Number(ai.resultRevision) || 0);
    return delivery;
  }

  async function refresh() {
    if (refreshInFlight) return;
    refreshInFlight = true;
    const requestedGeneration = statusGeneration;
    let hasMoreResults = false;
    try {
      const params = new URLSearchParams({ compact: "1", resultLimit: "64" });
      const profileId = getProfileId();
      if (profileId != null) params.set("profileId", profileId);
      if (projectKey) params.set("projectKey", projectKey);
      if (rowsSignature) params.set("rowsSignature", rowsSignature);
      if (runId) {
        params.set("runId", runId);
        params.set("afterRevision", String(revision));
      }
      const data = await requestStatus(params);
      // 启停请求改变运行状态后，先前发出的轮询不能覆盖新状态。
      // 不消费旧页结果或游标；收尾后重取，仍由服务端从原游标交付完整结果。
      if (requestedGeneration !== statusGeneration) {
        hasMoreResults = true;
        return;
      }
      // status 原本只检查 data.ok；HTTP 状态由各请求 adapter 按原口径处理。
      if (data.ok) {
        onStatus(data.ai);
        hasMoreResults = Boolean(data.ai?.hasMoreResults);
      }
    } catch {
      if (requestedGeneration === statusGeneration) onUnavailable();
      else hasMoreResults = true;
    } finally {
      refreshInFlight = false;
      if (hasMoreResults && !catchupTimer) {
        catchupTimer = timers.setTimeout(() => {
          catchupTimer = 0;
          refresh();
        }, 16);
      }
    }
  }

  async function forgetRows(indexes) {
    const normalized = [...new Set((indexes || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
    if (!normalized.length) return;
    normalized.forEach((id) => forgottenIndexes.add(id));
    if (!projectKey || !rowsSignature) return;
    try {
      await clearResults({ projectKey, rowsSignature, forgetResultIndexes: normalized });
      acknowledgeForgotten(normalized);
    } catch {
      // 下次启动继续携带这些行；瞬时请求失败不允许旧结果复活。
    }
  }

  return {
    begin, commit, refresh, forgetRows, acknowledgeForgotten,
    invalidateStatusRequests() { statusGeneration += 1; },
    resetReception() {
      received.clear();
      runId = "";
      revision = 0;
      // 保留运行/行拦截、在途请求和追赶 timer，与原页面清缓存一致。
    },
    discardCurrentRun() {
      if (runId) clearedRuns.add(runId);
      received.clear();
    },
    ignoreRun(id) {
      if (id) clearedRuns.add(id);
    },
    snapshot() {
      return Object.freeze({ runId, resultRevision: revision, forgottenIndexes: Object.freeze([...forgottenIndexes]) });
    },
  };
}

module.exports = { createAiResultReception };

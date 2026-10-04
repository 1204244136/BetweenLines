const { AI_CONCURRENCY_LIMITS } = require("./concurrency-limits");

function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}

function normalizePresetPool(value, fallback = null) {
  const source = Array.isArray(value) ? value : (value && typeof value === "object" ? [value] : []);
  const items = source.map((item, index) => {
    if (!item || typeof item !== "object") return null;
    const id = String(item.presetId || item.id || item.name || `preset-${index + 1}`).trim();
    if (!id) return null;
    return {
      ...item,
      presetId: id,
      name: String(item.name || item.presetName || id).trim(),
      concurrency: clamp(item.concurrency, 1, AI_CONCURRENCY_LIMITS.max, 3),
    };
  }).filter(Boolean);
  if (items.length) return items;
  return fallback ? [fallback] : [];
}

function createPresetPool(value, fallback = null) {
  const presets = normalizePresetPool(value, fallback);
  const state = new Map(presets.map((preset) => [preset.presetId, {
    presetId: preset.presetId,
    name: preset.name,
    configuredConcurrency: preset.concurrency,
    quota: Math.max(1, Math.min(preset.concurrency, 3)),
    inFlight: 0,
    pending: 0,
    completed: 0,
    successes: 0,
    failures: 0,
    activeRows: [],
    latencyMs: 0,
  }]));
  return {
    presets,
    state,
    next() {
      const available = [...state.values()].filter((item) => item.pending > 0 && item.inFlight < item.quota);
      if (!available.length) return null;
      available.sort((a, b) => (a.inFlight / a.quota) - (b.inFlight / b.quota) || a.completed - b.completed);
      return available[0];
    },
    setPending(counts = {}) {
      for (const item of state.values()) item.pending = Math.max(0, Number(counts[item.presetId]) || 0);
    },
    begin(presetId, rowIndex) {
      const item = state.get(presetId);
      if (!item) return;
      item.pending = Math.max(0, item.pending - 1);
      item.inFlight += 1;
      if (!item.activeRows.includes(rowIndex)) item.activeRows.push(rowIndex);
    },
    finish(presetId, rowIndex, { ok = true, latencyMs = 0 } = {}) {
      const item = state.get(presetId);
      if (!item) return;
      item.inFlight = Math.max(0, item.inFlight - 1);
      item.completed += 1;
      item.successes += ok ? 1 : 0;
      item.failures += ok ? 0 : 1;
      item.latencyMs += Math.max(0, Number(latencyMs) || 0);
      item.activeRows = item.activeRows.filter((index) => index !== rowIndex);
      const total = item.successes + item.failures;
      const failureRate = total ? item.failures / total : 0;
      if (!ok || failureRate > 0.35) item.quota = Math.max(1, item.quota - 1);
      else if (item.successes >= item.quota * 2 && item.quota < item.configuredConcurrency) item.quota += 1;
    },
    snapshot() {
      return [...state.values()].map((item) => ({
        ...item,
        averageLatencyMs: item.completed ? Math.round(item.latencyMs / item.completed) : 0,
      }));
    },
  };
}

// 将尚未绑定预设的队列项分配给当前积压最少的预设。阶段队列在运行中会不断
// 追加新项，不能只在初始化时轮转，否则后续进入的行会再次全部落到第一个预设。
function assignPendingPresetIds(pool, items = []) {
  const ids = pool?.presets?.map((item) => item.presetId) || [];
  const knownIds = new Set(ids);
  const counts = Object.fromEntries(ids.map((id) => [id, 0]));
  let tieCursor = 0;
  for (const item of items) {
    let id = item?.presetId;
    if (!knownIds.has(id)) {
      if (!ids.length) continue;
      const minPending = Math.min(...ids.map((candidate) => counts[candidate]));
      for (let offset = 0; offset < ids.length; offset += 1) {
        const candidateIndex = (tieCursor + offset) % ids.length;
        const candidate = ids[candidateIndex];
        if (counts[candidate] === minPending) {
          id = candidate;
          tieCursor = (candidateIndex + 1) % ids.length;
          break;
        }
      }
      item.presetId = id;
    }
    counts[id] = (counts[id] || 0) + 1;
  }
  pool?.setPending(counts);
  return counts;
}

module.exports = { normalizePresetPool, createPresetPool, assignPendingPresetIds };

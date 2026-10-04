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

// 没有并发通道时的兜底起步配额；与 concurrency-controller 的 CONCURRENCY_POLICY.startAt 同值
// （那边不能反向 require 本模块，两处行为由 ai-preset-pool.test.js 锁死）。
const FALLBACK_START_QUOTA = 3;

// 预设池负责「这一轮派给谁」与「谁还有余量」，配额本身由每个预设自己的并发通道决定。
//
// options.createChannel(preset, index, total) 注入一条独立通道（通常是 concurrency-controller
// 的 createStageController）。挂了通道的预设，配额就是通道当前允许并发：每个预设各按各的
// 上限慢启动/上探/下调，阶段总并发是各通道之和。只用一个阶段控制器时，多预设会被
// 「第一个预设（或主配置）的上限」卡住——界面选了 3 个预设、每个 3 并发，实际只有 3 个请求在飞。
function createPresetPool(value, fallback = null, options = {}) {
  const presets = normalizePresetPool(value, fallback);
  const createChannel = typeof options.createChannel === "function" ? options.createChannel : null;
  const state = new Map(presets.map((preset, index) => [preset.presetId, {
    presetId: preset.presetId,
    name: preset.name,
    configuredConcurrency: preset.concurrency,
    channel: createChannel ? createChannel(preset, index, presets.length) : null,
    quota: Math.max(1, Math.min(preset.concurrency, FALLBACK_START_QUOTA)),
    inFlight: 0,
    pending: 0,
    completed: 0,
    successes: 0,
    failures: 0,
    activeRows: [],
    latencyMs: 0,
  }]));

  const items = () => [...state.values()];
  const quotaOf = (item) => (item?.channel ? item.channel.currentConcurrency : (Number(item?.quota) || 0));
  const initialQuotaOf = (item) => (item?.channel ? item.channel.initialConcurrency : (Number(item?.quota) || 0));
  const maxQuotaOf = (item) => (item?.channel ? item.channel.maxConcurrency : (Number(item?.configuredConcurrency) || 0));
  const sumOf = (pick) => items().reduce((total, item) => total + Math.max(0, Number(pick(item)) || 0), 0);

  return {
    presets,
    state,
    quotaOf,
    // 阶段总并发 = 各预设当前允许并发之和；起步值与上限同理。
    totalQuota: () => sumOf(quotaOf),
    totalInitialQuota: () => sumOf(initialQuotaOf),
    totalMaxQuota: () => sumOf(maxQuotaOf),
    channelOf(presetId) {
      return state.get(presetId)?.channel || null;
    },
    channels() {
      return items().map((item) => item.channel).filter(Boolean);
    },
    next() {
      const available = items().filter((item) => item.pending > 0 && item.inFlight < quotaOf(item));
      if (!available.length) return null;
      const load = (item) => item.inFlight / Math.max(1, quotaOf(item));
      available.sort((a, b) => load(a) - load(b) || a.completed - b.completed);
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
      // 挂了通道的预设，配额升降由通道按 concurrency-controller 的慢启动/上探/下调策略决定；
      // 这里再算一套 ±1 会和通道打架，把「预设配了 32 却长期停在 3」那种退化重新带回来。
      if (item.channel) return;
      const total = item.successes + item.failures;
      const failureRate = total ? item.failures / total : 0;
      if (!ok || failureRate > 0.35) item.quota = Math.max(1, item.quota - 1);
      else if (item.successes >= item.quota * 2 && item.quota < item.configuredConcurrency) item.quota += 1;
    },
    // 只输出可序列化的运行数据：通道是活对象（含定时器与 Map），绝不能进状态接口。
    snapshot() {
      return items().map((item) => ({
        presetId: item.presetId,
        name: item.name,
        configuredConcurrency: item.configuredConcurrency,
        quota: quotaOf(item),
        inFlight: item.inFlight,
        pending: item.pending,
        completed: item.completed,
        successes: item.successes,
        failures: item.failures,
        activeRows: [...item.activeRows],
        latencyMs: item.latencyMs,
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

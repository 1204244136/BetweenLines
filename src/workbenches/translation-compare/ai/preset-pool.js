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
  const createChannel = typeof options.createChannel === "function" ? options.createChannel : null;
  const state = new Map();
  // 预设池可以在运行中被改动（运行中增删预设）：version 每次变化 +1，调用方据此决定
  // 要不要整队重新分配绑定——新预设要立刻抢活，被删预设的待派发行要立刻让给其余预设。
  let version = 0;

  const items = () => [...state.values()];
  const quotaOf = (item) => (item?.channel ? item.channel.currentConcurrency : (Number(item?.quota) || 0));
  const initialQuotaOf = (item) => (item?.channel ? item.channel.initialConcurrency : (Number(item?.quota) || 0));
  const maxQuotaOf = (item) => (item?.channel ? item.channel.maxConcurrency : (Number(item?.configuredConcurrency) || 0));
  const sumOf = (pick) => items().reduce((total, item) => total + Math.max(0, Number(pick(item)) || 0), 0);
  const isTopped = (item) => Boolean(item && item.configuredConcurrency > 0 && item.inFlight >= item.configuredConcurrency);

  // 多预设时并发日志要能区分是哪条连接。每次增删都重算一次：新加入的预设不能没有名字，
  // 删到只剩一个时也要把预设名前缀去掉，与单预设的日志格式保持一致。
  function refreshPresetLabels() {
    const total = state.size;
    let index = 0;
    for (const item of state.values()) {
      if (item.channel) {
        item.channel.presetLabel = total > 1 ? String(item.name || item.presetId || `预设 ${index + 1}`) : "";
      }
      index += 1;
    }
  }

  function addPreset(preset) {
    const normalized = normalizePresetPool([preset])[0];
    if (!normalized) return null;
    const existing = state.get(normalized.presetId);
    if (existing) {
      // 同 id 的预设只刷新连接参数（下一次派发就用新的地址/Key/模型）与展示名：
      // 通道已经按原来的并发上限跑起来了，运行中改上限要等下一次启动才生效。
      existing.preset = normalized;
      existing.name = normalized.name;
      refreshPresetLabels();
      return existing;
    }
    const item = {
      preset: normalized,
      presetId: normalized.presetId,
      name: normalized.name,
      configuredConcurrency: normalized.concurrency,
      channel: createChannel ? createChannel(normalized, state.size, state.size + 1) : null,
      quota: Math.max(1, Math.min(normalized.concurrency, FALLBACK_START_QUOTA)),
      inFlight: 0,
      pending: 0,
      completed: 0,
      successes: 0,
      failures: 0,
      activeRows: [],
      latencyMs: 0,
    };
    state.set(item.presetId, item);
    version += 1;
    refreshPresetLabels();
    return item;
  }

  // 移除预设：已经在飞的那几行不打断（请求已经发出去，结果照常写回），
  // 但池里不再保留这条通道，它也就再也拿不到新活。
  function removePreset(presetId) {
    if (!state.delete(String(presetId))) return false;
    version += 1;
    refreshPresetLabels();
    return true;
  }

  for (const preset of normalizePresetPool(value, fallback)) addPreset(preset);

  return {
    // 当前预设列表（含完整连接参数）：派发时按 presetId 取出这一项的配置发给模型。
    get presets() {
      return items().map((item) => item.preset);
    },
    state,
    // 池的改动代数：调用方记住上一次分配时的值，就能知道「预设集合刚变过」。
    get version() {
      return version;
    },
    addPreset,
    removePreset,
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
        // 触顶 = 这条通道已经顶到它自己配置的并发上限。它与「配额用满」（inFlight >= quota）
        // 不是一回事：配额还会继续上探，只有到配置上限才真的加不动了。口径在这里定一次，
        // 页面只做计数与展示，不再自己重算一遍。
        topped: isTopped(item),
        activeRows: [...item.activeRows],
        latencyMs: item.latencyMs,
        averageLatencyMs: item.completed ? Math.round(item.latencyMs / item.completed) : 0,
      }));
    },
    // 已经顶到配置上限的预设数：阶段整体「全部触顶」才代表这个阶段真的加不动了。
    toppedCount() {
      return items().filter(isTopped).length;
    },
  };
}

// 将尚未绑定预设的队列项分配给当前积压最少的预设。阶段队列在运行中会不断
// 追加新项，不能只在初始化时轮转，否则后续进入的行会再次全部落到第一个预设。
//
// options.reassign=true 时忽略已有绑定、整队重算：预设集合刚被改动过（运行中增删预设），
// 新预设要立刻分到活，被删预设的待派发行也要立刻让给其余预设。
function assignPendingPresetIds(pool, items = [], options = {}) {
  const reassign = options.reassign === true;
  const ids = pool?.presets?.map((item) => item.presetId) || [];
  const knownIds = new Set(ids);
  const counts = Object.fromEntries(ids.map((id) => [id, 0]));
  let tieCursor = 0;
  for (const item of items) {
    let id = reassign ? "" : item?.presetId;
    if (!knownIds.has(id)) {
      if (!ids.length) {
        // 池里没有可用预设：把残留绑定清掉，避免下一轮拿旧 id 去找一条不存在的通道。
        if (item && typeof item === "object") delete item.presetId;
        continue;
      }
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

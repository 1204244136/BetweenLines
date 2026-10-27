const { createPresetPool, normalizePresetPool, assignPendingPresetIds } = require("./preset-pool");
const { createStageBreaker, formatDuration } = require("./circuit-breaker");
const {
  CONCURRENCY_POLICY, createStageController, stepUpOnSuccess, stepDownOnLimit,
  stepDownOnOverload, collapseForBreaker, backoffDelayMs, shouldRetryRow,
} = require("./concurrency-controller");
const { classifyAiError, AI_ERROR_KIND_LABELS } = require("./error-kinds");
const MAX_ROW_RETRIES = 3;

// 每个阶段独占待办、通道与请求句柄。反馈和 finally 收尾分开，保持领域处理的时序。
function createStageDispatch({
  stageKey, label, presets, fallbackConfig, fallbackConcurrency = 3,
  policy = CONCURRENCY_POLICY, now = Date.now, timers = { setTimeout, clearTimeout }, wake = () => {},
} = {}) {
  const pending = [];
  const requests = new Map();
  const current = new Map();
  const owned = new Set();
  const fallback = createStageController({ stageKey, label, config: fallbackConfig, fallbackConcurrency, now });
  let activeRows = [];
  let assignedVersion = -1;
  let pendingDirty = true;
  let disposed = false;
  const maxRetries = MAX_ROW_RETRIES;
  const overloadKinds = new Set(["timeout", "server_error", "network"]);

  const pool = createPresetPool(presets, fallbackConfig, {
    createChannel(preset, index, total) {
      const channel = createStageController({ stageKey, label, config: preset, fallbackConcurrency, now });
      channel.presetId = String(preset.presetId || "");
      channel.presetLabel = total > 1 ? String(preset.name || preset.presetId || `预设 ${index + 1}`) : "";
      const generation = {
        presetId: channel.presetId, channel, item: null, retired: false, trip: null,
        breaker: createStageBreaker({ now, timeScale: Number(process.env.TRANSCOMPARATOR_BREAKER_TIME_SCALE) || 1 }),
      };
      current.set(generation.presetId, generation);
      owned.add(generation);
      return channel;
    },
  });
  for (const item of pool.state.values()) current.get(item.presetId).item = item;

  const quota = () => pool.totalQuota() || fallback.currentConcurrency;
  const quotaMax = () => pool.totalMaxQuota() || fallback.maxConcurrency;
  const rowIndexOf = (item) => item.row?.index ?? item.index;
  const tag = (channel) => channel.presetLabel ? `${label}·${channel.presetLabel}：` : (stageKey === "stage1" ? "" : `${label}：`);
  const breakerLabel = (generation) => pool.presets.length <= 1 ? label
    : `${label}·${generation.item?.name || generation.presetId}`;

  function cancelTimer(channel) {
    if (channel.backoffTimer != null) timers.clearTimeout(channel.backoffTimer);
    channel.backoffTimer = null;
  }

  function cleanup(generation) {
    if (generation.retired && generation.item.inFlight === 0) {
      cancelTimer(generation.channel);
      owned.delete(generation);
    }
  }

  function syncPending() {
    if (!pendingDirty && assignedVersion === pool.version) return;
    const reassign = assignedVersion !== pool.version;
    assignedVersion = pool.version;
    assignPendingPresetIds(pool, pending, {
      reassign,
      isEligible: (preset) => !current.get(preset.presetId)?.trip,
    });
    pendingDirty = false;
  }

  function scheduleWake(generation) {
    const channel = generation.channel;
    if (disposed || generation.retired || channel.backoffTimer != null) return;
    const waitMs = Math.max(10, channel.backoffUntil - now());
    channel.backoffTimer = timers.setTimeout(() => {
      channel.backoffTimer = null;
      if (!disposed && !generation.retired) wake();
    }, waitMs);
  }

  function canDispatch(item) {
    const generation = current.get(item.presetId);
    if (!generation || generation.trip) return false;
    const { channel, breaker } = generation;
    if (now() < channel.backoffUntil || breaker.state === "open") {
      scheduleWake(generation);
      return false;
    }
    return breaker.state !== "half-open" || item.inFlight < 1;
  }

  function markTrip(generation, trip, events, stopped) {
    if (!trip || stopped || generation.trip) return;
    generation.trip = trip;
    if (!generation.retired) {
      events.push({ type: "trip", trip, presetId: generation.presetId });
      pendingDirty = true;
      syncPending();
    }
  }

  function recover(generation, recovered) {
    if (!recovered) return;
    const channel = generation.channel;
    channel.backoffUntil = Math.min(channel.backoffUntil, now());
    channel.consecutiveLimits = 0;
    cancelTimer(channel);
  }

  function recordOutcome(generation, kind, events, stopped) {
    if (generation.trip) return;
    const verdict = kind === "success" ? generation.breaker.recordSuccess()
      : (kind === "failure" ? generation.breaker.recordFailure() : generation.breaker.recordNotLimited());
    recover(generation, verdict.recovered);
    if (verdict.recovered) events.push({ type: "log", message: kind === "success"
      ? `[熔断] ${breakerLabel(generation)}：请求重新通过，限流冷却解除，恢复正常派发。`
      : `[熔断] ${breakerLabel(generation)}：请求已拿到非限流的答复，限流冷却解除。` });
    markTrip(generation, verdict.trip, events, stopped);
  }

  function noteSuccess(generation, events, stopped) {
    recordOutcome(generation, "success", events, stopped);
    const channel = generation.channel;
    const wasPaused = channel.rampPaused;
    const step = stepUpOnSuccess(channel, { now: now(), pressure: generation.breaker.pressure, policy });
    if (channel.rampPaused !== wasPaused) events.push({ type: "log", message: channel.rampPaused
      ? `[并发调度] ${tag(channel)}失败率已逼近熔断线，暂停上调，并发维持 ${channel.currentConcurrency}。`
      : `[并发调度] ${tag(channel)}失败率回落，恢复上调。` });
    if (!step) return;
    events.push({ type: "concurrency", direction: "up" });
    events.push({ type: "log", message: step.mode === "slow-start"
      ? `[并发调度] ${tag(channel)}一整轮请求全部正常，并发从 ${step.from} 翻倍至 ${step.to}（上限 ${channel.maxConcurrency}）。`
      : `[并发调度] ${tag(channel)}连续 ${step.successes} 次请求正常，并发从 ${step.from} 上调至 ${step.to}（上限 ${channel.maxConcurrency}）。` });
  }

  function noteFailure(generation, request, error, events, stopped) {
    const kind = classifyAiError(error);
    if (overloadKinds.has(kind)) {
      const step = stepDownOnOverload(generation.channel, { now: now(), startedAt: request.startedAt, minConcurrency: 1, policy });
      if (step) {
        events.push({ type: "concurrency", direction: "down" });
        events.push({ type: "log", message: `[并发调度] ${tag(generation.channel)}第 ${request.rowIndex} 行遭遇${AI_ERROR_KIND_LABELS[kind]}，并发从 ${step.from} 下调至 ${step.to}，先缓解上游压力。` });
      }
    }
    recordOutcome(generation, "failure", events, stopped);
  }

  function noteRateLimit(generation, request, error, reason, events, stopped) {
    const channel = generation.channel;
    events.push({ type: "limit" });
    channel.consecutiveLimits += 1;
    const step = stepDownOnLimit(channel, { now: now(), startedAt: request.startedAt, minConcurrency: 1, policy });
    if (step) events.push({ type: "concurrency", direction: "down" });
    const retries = (channel.rowRetryCounts.get(request.rowIndex) || 0) + 1;
    channel.rowRetryCounts.set(request.rowIndex, retries);
    const jitterLimit = Number(process.env.TRANSCOMPARATOR_RETRY_JITTER_MS);
    const jitterMs = Number.isFinite(jitterLimit) && jitterLimit >= 0 ? jitterLimit : 500;
    const delayMs = backoffDelayMs(channel.consecutiveLimits, error.retryAfter)
      + (jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0);
    channel.backoffUntil = Math.max(channel.backoffUntil, now() + delayMs);
    scheduleWake(generation);
    if (shouldRetryRow(retries, maxRetries, stopped)) {
      events.push({ type: "log", message: `[频控退避] 第 ${request.rowIndex} 行${stageKey === "stage1" ? "" : label}遭遇${reason}，并发下调至 ${quota()}，退避 ${(delayMs / 1000).toFixed(1)} 秒后进行第 ${retries}/${maxRetries} 次重试。` });
      pending.unshift(request.item);
      pendingDirty = true;
      return true;
    }
    if (stopped) return false;
    const verdict = generation.breaker.recordLimitExhausted();
    if (verdict.action === "fail") return false;
    if (verdict.action === "trip") {
      markTrip(generation, verdict, events, stopped);
      return false;
    }
    channel.rowRetryCounts.set(request.rowIndex, maxRetries);
    channel.backoffUntil = Math.max(channel.backoffUntil, verdict.until);
    scheduleWake(generation);
    pending.unshift(request.item);
    pendingDirty = true;
    if (verdict.opened) {
      const from = channel.currentConcurrency;
      const to = collapseForBreaker(channel, { now: now(), minConcurrency: 1, policy }).to;
      if (from > to) events.push({ type: "concurrency", direction: "down" });
      const attempt = `第 ${verdict.cycle}/${verdict.cycles} 档`;
      events.push({ type: "log", message: verdict.cycle === 1
        ? `[熔断] ${breakerLabel(generation)}：连续多行限流重试用尽，暂停派发 ${formatDuration(verdict.cooldownMs)}（${attempt}冷却），冷却后单发探测；已完成的行不受影响。`
        : `[熔断] ${breakerLabel(generation)}：探测仍被限流，继续冷却 ${formatDuration(verdict.cooldownMs)}（${attempt}冷却）。` });
      if (verdict.cycle === 1) events.push({ type: "log", message: `[并发调度] ${breakerLabel(generation)}：熔断冷却，并发降到 ${to}（冷却前 ${from}）；恢复后从 ${to} 起步慢启动，先增加至 ${Math.max(0, Number(channel.slowStartThreshold) || 0)}，再逐步上调（上限 ${channel.maxConcurrency}）。` });
    }
    return true;
  }

  function cancelWakeups() {
    cancelTimer(fallback);
    for (const generation of owned) cancelTimer(generation.channel);
  }

  return {
    enqueue(itemOrItems, { front = false } = {}) {
      if (disposed) return;
      const items = Array.isArray(itemOrItems) ? itemOrItems : [itemOrItems];
      if (front) {
        for (let index = items.length - 1; index >= 0; index -= 1) pending.unshift(items[index]);
      } else {
        for (const item of items) pending.push(item);
      }
      pendingDirty = true;
      syncPending();
    },
    take() {
      if (disposed || !pending.length) return null;
      syncPending();
      const preset = pool.next(canDispatch);
      if (!preset) return null;
      const item = pending.shift();
      item.presetId = preset.presetId;
      item.presetConfig = preset.preset;
      const generation = current.get(preset.presetId);
      const rowIndex = rowIndexOf(item);
      const handle = Object.freeze({});
      requests.set(handle, { generation, item, rowIndex, startedAt: now() });
      pool.begin(preset.presetId, rowIndex);
      activeRows.push(rowIndex);
      pendingDirty = true;
      syncPending();
      return { item, request: handle };
    },
    feedback(handle, { kind, error, rateLimitReason = "", stopped = false } = {}) {
      const request = requests.get(handle);
      const events = [];
      if (!request || disposed) return { retry: false, events };
      const generation = request.generation;
      let retry = false;
      if (kind === "success") noteSuccess(generation, events, stopped);
      else if (kind === "failure") noteFailure(generation, request, error, events, stopped);
      else if (kind === "not-limited") recordOutcome(generation, "not-limited", events, stopped);
      else if (kind === "rate-limit") retry = noteRateLimit(generation, request, error, rateLimitReason, events, stopped);
      syncPending();
      return { retry, events };
    },
    release(handle, options = {}) {
      const request = requests.get(handle);
      if (!request) return false;
      requests.delete(handle);
      pool.finish(request.generation.item, request.rowIndex, options);
      activeRows = activeRows.filter((index) => index !== request.rowIndex);
      cleanup(request.generation);
      syncPending();
      return true;
    },
    updatePresets(incomingPresets) {
      if (disposed) return { added: [], removed: [], fallback: false, rejected: true };
      const incoming = normalizePresetPool(incomingPresets);
      const target = incoming.length ? incoming : normalizePresetPool([fallbackConfig].filter(Boolean));
      if (!target.length) return { added: [], removed: [], fallback: false, rejected: true };
      const ids = new Set(target.map((preset) => preset.presetId));
      const removed = [];
      for (const [id, generation] of current) {
        if (ids.has(id)) continue;
        generation.retired = true;
        current.delete(id);
        pool.removePreset(id);
        removed.push(id);
        cleanup(generation);
      }
      const added = [];
      for (const preset of target) {
        // 真实热更新原本只增删；已有 id 的连接和上限保持到下次启动。
        if (current.has(preset.presetId)) continue;
        const item = pool.addPreset(preset);
        current.get(item.presetId).item = item;
        added.push(item.presetId);
      }
      syncPending();
      return { added, removed, fallback: !incoming.length && target.length > 0 };
    },
    snapshot() {
      syncPending();
      const timestamp = now();
      const presets = pool.snapshot().map((item) => {
        const generation = current.get(item.presetId);
        const breakerState = generation.trip ? "tripped" : generation.breaker.state;
        const waiting = !disposed && pending.length > 0 && !generation.trip && generation.channel.backoffUntil > timestamp;
        return {
          ...item,
          breakerState,
          breakerTripped: Boolean(generation.trip),
          waitReason: waiting ? (breakerState === "open" ? "cooldown" : "rate_limit") : "",
          retryAt: waiting ? generation.channel.backoffUntil : 0,
        };
      });
      const breakerTrippedCount = presets.filter((item) => item.breakerTripped).length;
      const healthy = presets.filter((item) => !item.breakerTripped);
      const waiting = healthy.length > 0 && healthy.every((item) => item.waitReason);
      const next = waiting ? healthy.reduce((earliest, item) => item.retryAt < earliest.retryAt ? item : earliest) : null;
      return {
        pending: pending.length, pendingRows: pending.map(rowIndexOf), inFlight: requests.size, activeRows: [...activeRows],
        concurrency: quota(), concurrencyMax: quotaMax(),
        initialConcurrency: pool.totalInitialQuota() || fallback.initialConcurrency,
        presetCount: presets.length, toppedCount: pool.toppedCount(), breakerTrippedCount,
        breakerBroken: presets.length > 0 && breakerTrippedCount === presets.length,
        waitReason: next?.waitReason || "", retryAt: next?.retryAt || 0,
        presets,
      };
    },
    drainPending() {
      const items = pending.splice(0);
      pendingDirty = true;
      syncPending();
      return items;
    },
    cancelWakeups,
    dispose() {
      disposed = true;
      cancelWakeups();
    },
  };
}

module.exports = { createStageDispatch, MAX_ROW_RETRIES };

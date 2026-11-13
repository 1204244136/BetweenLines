const { createStageDispatch } = require("./stage-dispatch");
const { normalizePresetPool } = require("./preset-pool");
const { classifyAiError } = require("./error-kinds");

const POOL_STAGES = Object.freeze(["stage1", "stage2", "stage3"]);
const MAX_POOL_ROW_ATTEMPTS = 3;

function normalizePoolPreset(preset) {
  const stages = Array.isArray(preset.stages)
    ? POOL_STAGES.filter((stage) => preset.stages.includes(stage)) : [...POOL_STAGES];
  const stagePriorities = Object.fromEntries(POOL_STAGES.map((stage) => {
    const value = Number(preset.stagePriorities?.[stage]);
    return [stage, Number.isFinite(value) ? Math.max(0, Math.min(9, Math.round(value))) : 0];
  }));
  return { ...preset, stages, stagePriorities };
}

function createPoolDispatch({
  presets = [], priorityEnabled = false, policy, now = Date.now,
  timers = { setTimeout, clearTimeout }, wake = () => {},
} = {}) {
  const current = new Map();
  const owned = new Set();
  const pending = [];
  const requests = new Map();
  const refusals = new Map();
  const stageTurns = Object.fromEntries(POOL_STAGES.map((stage) => [stage, 0]));
  let turn = 0;
  let presetCursor = 0;
  let sequence = 0;
  let disposed = false;
  let wakeTimer = null;
  let wakeAt = 0;

  const indexOf = (item) => item?.row?.index ?? item?.index;
  const keyOf = (stage, item) => `${stage}:${indexOf(item)}`;
  const sizeOf = (item) => {
    const row = item.row || item;
    return [row.jp, row.cn, row.tw, item.targetText, item.counterpartText]
      .reduce((sum, value) => sum + String(value || "").length, 0);
  };
  const statsOf = (generation) => generation.dispatch.snapshot({ includeIdleWait: true });
  const attemptOf = (generation, entry) => {
    const key = keyOf(entry.stageKey, entry.item);
    return { count: generation.attempts.get(key) || 0, refused: refusals.get(generation.preset.presetId)?.has(key) || false };
  };

  function eligible(generation, entry, state = statsOf(generation)) {
    if (generation.retired || !generation.preset.stages.includes(entry.stageKey)) return false;
    const attempt = attemptOf(generation, entry);
    return !state.breakerBroken && !attempt?.refused && (attempt?.count || 0) < MAX_POOL_ROW_ATTEMPTS;
  }

  function add(preset) {
    const generation = {
      preset, retired: false, attempts: new Map(),
      profile: { timeouts: 0, rateLimits: 0, refusals: 0, successes: 0, failures: 0, latencyMs: 0, characters: 0 },
      dispatch: createStageDispatch({
        stageKey: "pool", label: `预设池·${preset.name}`, presets: [preset], fallbackConfig: preset,
        policy, now, timers, wake, retryKeyOf: (entry) => keyOf(entry.stageKey, entry.item),
      }),
    };
    current.set(preset.presetId, generation);
    owned.add(generation);
  }

  function cleanup(generation) {
    if (!generation.retired || statsOf(generation).inFlight) return;
    generation.dispatch.dispose();
    owned.delete(generation);
  }

  function cancelWakeups() {
    if (wakeTimer != null) timers.clearTimeout(wakeTimer);
    wakeTimer = null;
    wakeAt = 0;
    for (const generation of owned) generation.dispatch.cancelWakeups();
  }

  function scheduleWake(timestamp) {
    if (disposed || !timestamp || (wakeTimer != null && wakeAt <= timestamp)) return;
    if (wakeTimer != null) timers.clearTimeout(wakeTimer);
    wakeAt = timestamp;
    wakeTimer = timers.setTimeout(() => {
      wakeTimer = null;
      wakeAt = 0;
      if (!disposed) wake();
    }, Math.max(10, timestamp - now()));
  }

  function enqueue(stageKey, itemOrItems, { front = false } = {}) {
    if (disposed) return;
    const items = Array.isArray(itemOrItems) ? itemOrItems : [itemOrItems];
    const entries = items.filter(Boolean).map((item) => ({ stageKey, item, index: indexOf(item), sequence: sequence++ }));
    if (front) pending.unshift(...entries);
    else pending.push(...entries);
  }

  function candidateFor(generation, isStageEnabled, state) {
    const candidates = pending.filter((entry) => isStageEnabled(entry.stageKey) && eligible(generation, entry, state));
    const counts = Object.fromEntries(POOL_STAGES.map((stage) => [stage, candidates.filter((entry) => entry.stageKey === stage).length]));
    const compare = (a, b) => {
      const priority = priorityEnabled ? generation.preset.stagePriorities[b.stageKey] - generation.preset.stagePriorities[a.stageKey] : 0;
      if (priority) return priority;
      const attempts = (attemptOf(generation, a)?.count || 0) - (attemptOf(generation, b)?.count || 0);
      if (attempts) return attempts;
      if (generation.profile.rateLimits && counts[a.stageKey] !== counts[b.stageKey]) return counts[a.stageKey] - counts[b.stageKey];
      const fair = stageTurns[a.stageKey] - stageTurns[b.stageKey];
      if (fair) return fair;
      if (generation.profile.timeouts) {
        const length = sizeOf(a.item) - sizeOf(b.item);
        if (length) return length;
      }
      return a.sequence - b.sequence;
    };
    return candidates.reduce((best, entry) => !best || compare(entry, best) < 0 ? entry : best, null);
  }

  function take({ isStageEnabled = () => true } = {}) {
    if (disposed || !pending.length) return null;
    const generations = [...current.values()];
    for (let offset = 0; offset < generations.length; offset += 1) {
      const position = (presetCursor + offset) % generations.length;
      const generation = generations[position];
      const state = statsOf(generation);
      if (state.breakerBroken || state.inFlight >= state.concurrency) continue;
      const entry = candidateFor(generation, isStageEnabled, state);
      if (!entry) continue;
      if (state.retryAt > now()) {
        scheduleWake(state.retryAt);
        continue;
      }
      if (state.presets[0]?.breakerState === "half-open" && state.inFlight) continue;
      generation.dispatch.enqueue(entry);
      const next = generation.dispatch.take();
      if (!next) {
        generation.dispatch.drainPending();
        continue;
      }
      pending.splice(pending.indexOf(entry), 1);
      entry.item.presetId = generation.preset.presetId;
      entry.item.presetConfig = next.item.presetConfig;
      requests.set(next.request, { generation, entry, startedAt: now(), recordedKinds: new Set() });
      stageTurns[entry.stageKey] = ++turn;
      presetCursor = (position + 1) % generations.length;
      return { stageKey: entry.stageKey, item: entry.item, request: next.request };
    }
    return null;
  }

  function feedback(request, options = {}) {
    const record = requests.get(request);
    if (!record || disposed) return { retry: false, events: [] };
    const { generation, entry } = record;
    const result = generation.dispatch.feedback(request, options);
    const returned = generation.dispatch.drainPending();
    for (const retry of returned) {
      if (!pending.includes(retry)) pending.unshift(retry);
    }
    if (generation.retired) result.events = result.events.filter((event) => event.type !== "trip");
    const kind = options.error ? classifyAiError(options.error) : "";
    if (!options.stopped && !record.recordedKinds.has(options.kind)) {
      record.recordedKinds.add(options.kind);
      const isRefusal = kind === "refusal" || options.kind === "refusal";
      const failed = options.kind === "failure" || options.kind === "fatal" || isRefusal || (options.kind === "rate-limit" && !result.retry);
      if (failed) {
        const key = keyOf(entry.stageKey, entry.item);
        generation.attempts.set(key, (generation.attempts.get(key) || 0) + 1);
        if (isRefusal) {
          const rows = refusals.get(generation.preset.presetId) || new Set();
          refusals.set(generation.preset.presetId, rows);
          rows.add(key);
        }
      }
      if (!generation.retired) {
        if (kind === "timeout") generation.profile.timeouts += 1;
        if (options.kind === "rate-limit") generation.profile.rateLimits += 1;
        if (isRefusal) generation.profile.refusals += 1;
        if (failed) generation.profile.failures += 1;
        if (options.kind === "success") generation.profile.successes += 1;
      }
    }
    return result;
  }

  function release(request, options = {}) {
    const record = requests.get(request);
    if (!record) return false;
    requests.delete(request);
    const { generation, entry } = record;
    if (!generation.retired) {
      generation.profile.latencyMs += Math.max(0, now() - record.startedAt);
      generation.profile.characters += sizeOf(entry.item);
    }
    const released = generation.dispatch.release(request, options);
    cleanup(generation);
    return released;
  }

  const canRetry = (stageKey, item) => [...current.values()].some((generation) => eligible(generation, { stageKey, item }));

  function snapshot(stageKey = null) {
    const queue = pending.filter((entry) => !stageKey || entry.stageKey === stageKey);
    const active = [...requests.values()].filter((record) => !stageKey || record.entry.stageKey === stageKey);
    const relevant = [...current.values()].filter((generation) => !stageKey || generation.preset.stages.includes(stageKey));
    const states = new Map(relevant.map((generation) => [generation, statsOf(generation)]));
    const counts = new Map(relevant.map((generation) => [generation, 0]));
    for (const entry of queue) {
      const available = relevant.filter((generation) => eligible(generation, entry, states.get(generation)));
      available.sort((a, b) => counts.get(a) - counts.get(b));
      if (available[0]) counts.set(available[0], counts.get(available[0]) + 1);
    }
    const presetStates = relevant.map((generation) => {
      const state = states.get(generation);
      const value = state.presets[0];
      const running = active.filter((record) => record.generation === generation);
      const waiting = counts.get(generation) > 0;
      return {
        ...value, stages: [...generation.preset.stages], stagePriorities: { ...generation.preset.stagePriorities },
        pending: counts.get(generation), inFlight: running.length,
        activeRows: running.map((record) => indexOf(record.entry.item)),
        waitReason: waiting ? value.waitReason : "", retryAt: waiting ? value.retryAt : 0,
        profile: { ...generation.profile }, initialConcurrency: state.initialConcurrency,
      };
    });
    const healthy = presetStates.filter((preset) => !preset.breakerTripped);
    const blockedPending = queue.filter((entry) => !relevant.some((generation) => eligible(generation, entry, states.get(generation)))).length;
    const waiting = queue.length > 0 && healthy.length > 0 && healthy.every((preset) => preset.waitReason || !preset.pending);
    const next = waiting ? healthy.filter((preset) => preset.retryAt).sort((a, b) => a.retryAt - b.retryAt)[0] : null;
    return {
      pending: queue.length, pendingRows: queue.map((entry) => indexOf(entry.item)),
      inFlight: active.length, activeRows: active.map((record) => indexOf(record.entry.item)),
      concurrency: presetStates.reduce((sum, preset) => sum + preset.quota, 0),
      concurrencyMax: presetStates.reduce((sum, preset) => sum + preset.configuredConcurrency, 0),
      initialConcurrency: presetStates.reduce((sum, preset) => sum + preset.initialConcurrency, 0),
      presetCount: presetStates.length, toppedCount: presetStates.filter((preset) => preset.topped).length,
      breakerTrippedCount: presetStates.filter((preset) => preset.breakerTripped).length,
      breakerBroken: presetStates.length > 0 && healthy.length === 0,
      blockedPending, waitReason: next?.waitReason || "", retryAt: next?.retryAt || 0,
      presets: presetStates,
    };
  }

  function drain(stageKey, blockedOnly = false) {
    const drained = [];
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const entry = pending[index];
      if (entry.stageKey !== stageKey || (blockedOnly && canRetry(stageKey, entry.item))) continue;
      drained.unshift(entry.item);
      pending.splice(index, 1);
    }
    return drained;
  }

  function updatePresets(incomingPresets, options = {}) {
    if (disposed) return { added: [], removed: [], fallback: false, rejected: true };
    if (typeof options.priorityEnabled === "boolean") priorityEnabled = options.priorityEnabled;
    const incoming = [...new Map(normalizePresetPool(incomingPresets).map(normalizePoolPreset)
      .map((preset) => [preset.presetId, preset])).values()];
    const ids = new Set(incoming.map((preset) => preset.presetId));
    const removed = [];
    for (const [id, generation] of current) {
      if (ids.has(id)) continue;
      current.delete(id);
      generation.retired = true;
      generation.dispatch.cancelWakeups();
      removed.push(id);
      cleanup(generation);
    }
    const added = [];
    for (const preset of incoming) {
      const existing = current.get(preset.presetId);
      if (existing) {
        existing.preset = { ...existing.preset, stages: preset.stages, stagePriorities: preset.stagePriorities };
      } else {
        add(preset);
        added.push(preset.presetId);
      }
    }
    return { added, removed, fallback: false };
  }

  function dispose() {
    disposed = true;
    cancelWakeups();
    for (const generation of owned) generation.dispatch.dispose();
  }

  updatePresets(presets);
  const stages = Object.fromEntries(POOL_STAGES.map((stageKey) => [stageKey, {
    enqueue: (items, options) => enqueue(stageKey, items, options),
    feedback, release, snapshot: () => snapshot(stageKey),
    drainPending: () => drain(stageKey), drainBlocked: () => drain(stageKey, true),
    cancelWakeups, dispose,
  }]));
  return { stages, take, snapshot, canRetry, updatePresets, cancelWakeups, dispose };
}

module.exports = { createPoolDispatch, normalizePoolPreset, POOL_STAGES, MAX_POOL_ROW_ATTEMPTS };

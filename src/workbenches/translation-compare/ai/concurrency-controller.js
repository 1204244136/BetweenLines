const { AI_CONCURRENCY_LIMITS } = require("./concurrency-limits");

function createStageController({
  stageKey,
  label,
  config,
  fallbackConcurrency = 3,
  fallbackMax = 10,
  clampInteger,
  smartDefault = false,
} = {}) {
  const rawConcurrency = config?.concurrency != null ? Number(config.concurrency) : fallbackConcurrency;
  const initialConcurrency = clampInteger(rawConcurrency, AI_CONCURRENCY_LIMITS.min, AI_CONCURRENCY_LIMITS.max, fallbackConcurrency);
  const isSmart = config?.smartConcurrency != null ? Boolean(config.smartConcurrency) : smartDefault;
  const rawMax = config?.concurrencyMax != null ? Number(config.concurrencyMax) : fallbackMax;
  const maxConcurrency = isSmart
    ? Math.max(initialConcurrency, clampInteger(rawMax, AI_CONCURRENCY_LIMITS.min, AI_CONCURRENCY_LIMITS.maxSmart, fallbackMax))
    : initialConcurrency;
  return {
    stageKey,
    label,
    isSmart,
    currentConcurrency: initialConcurrency,
    maxConcurrency,
    initialConcurrency,
    consecutiveSuccesses: 0,
    consecutiveLimits: 0,
    lastAdjustmentAt: Date.now(),
    lastScaleDownAt: 0,
    backoffUntil: 0,
    backoffTimer: null,
    rowRetryCounts: new Map(),
  };
}

function nextConcurrencyAfterLimit(current, minConcurrency = 1) {
  return current > 3
    ? Math.max(minConcurrency, Math.floor(current * 0.7))
    : Math.max(minConcurrency, current - 1);
}

function backoffDelayMs(consecutiveLimits, retryAfter) {
  const parsed = parseFloat(retryAfter);
  if (Number.isFinite(parsed) && parsed > 0) return Math.min(15000, parsed * 1000);
  return Math.min(10000, 1500 * Math.pow(1.5, Math.min(4, consecutiveLimits - 1)));
}

function shouldRetryRow(retries, maxRetries, stopped) {
  return retries <= maxRetries && !stopped;
}

module.exports = { createStageController, nextConcurrencyAfterLimit, backoffDelayMs, shouldRetryRow };

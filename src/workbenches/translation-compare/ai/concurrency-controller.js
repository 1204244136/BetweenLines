// AI 校对的并发调度（纯函数模块：不读 status、不碰网络，时钟可注入）。
//
// 面板只有一个「并发上限」，调度器内部强制自适应，没有对外开关：实际并发在 1~上限 之间自动升降。
// 阶段内派发与通道生命周期归 stage-dispatch.js，跨阶段顺序、业务和结果写入归 ai-proofread.js；
// 这里仅计算当前允许的并发数。
//
// 起步：min(上限, 3)。默认上限 3 时就是固定 3，与旧行为一致；上限更高时先以 3 个并发请求运行，
// 确认上游服务稳定后再增加。
//
// 增加并发（两段式）：
// 1. 慢启动：一整轮请求（数量 = 当前并发）全部正常，并发翻倍，直到上限；一旦被限流/过载就转入下一段。
//    上限填 32 时 3→6→12→24→32，几轮就到位，不必等 29 个「连续 5 次」。
// 2. 加法增加：每连续 5 次正常应答 +1。达到或超过上次触发限流或过载的并发数时，需要连续 15 次，
//    避免反复超过上游服务的承载能力，触发更多 429 响应。
// 两次增加之间至少间隔 3 秒，以便观察上一次调整的效果。
//
// 降低并发（只处理限流或过载）：
// - 频控（429/503/529）：并发 >3 时 ×0.7，否则 -1。一次拥塞事件里同时返回的一批限流只算一次：
//   下调之前就已发出的请求不再触发第二次下调，且两次下调至少隔 800ms。
// - 过载型失败（超时、5xx、断连）：-1。这类失败未必是并发造成的，下调要更温和；它们同时会进熔断的失败窗口，
//   提前降低并发，以便在错误率触发熔断、终止任务之前降低失败率。
// - 拒答、无效 JSON 等非过载失败不调整并发：上游服务仍能应答，问题不在并发。
//
// 与熔断（circuit-breaker.js）的联动：
// - 断路器打开（限流重试用尽、进入冷却）：并发直接降至 1，慢启动阈值设为冷却前并发的一半（至少 2）。
//   恢复后从 1 慢启动增加至阈值，再按加法增加，避免直接恢复冷却前的并发数，再次触发上游限流。
// - 失败窗口错误率达到熔断阈值的一半（pressure ≥ 0.5）时暂停增加并发，避免加重上游服务负载。

const { AI_CONCURRENCY_LIMITS } = require("./concurrency-limits");

const CONCURRENCY_POLICY = Object.freeze({
  // 起步并发的上界：初始并发 = min(上限, startAt)。
  startAt: 3,
  // 加法增加所需的连续正常应答数。
  additiveSuccesses: 5,
  // 达到或超过已知受限并发数时所需的连续正常应答数。
  cautiousSuccesses: 15,
  // 两次增加并发之间的最短间隔。
  minStepIntervalMs: 3000,
  // 下调后的最短静默期：这段时间内不再下调，等下调的效果显现。
  decreaseDebounceMs: 800,
  // 失败窗口 pressure 达到该值（熔断阈值的一半）时暂停增加并发。
  pauseRampPressure: 0.5,
  // 熔断冷却后慢启动阈值的下限：至少回到 2，否则恢复后永远只有 1。
  breakerRestartFloor: 2,
});

function defaultClamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function initialConcurrencyFor(cap, policy = CONCURRENCY_POLICY) {
  return Math.max(AI_CONCURRENCY_LIMITS.min, Math.min(cap, policy.startAt));
}

function createStageController({
  stageKey,
  label,
  config,
  fallbackConcurrency = AI_CONCURRENCY_LIMITS.defaultConcurrency,
  clampInteger = defaultClamp,
  now = Date.now,
} = {}) {
  // config.concurrency 就是并发上限（cleanConfig / cleanSubStageConfig 已折算旧口径），没配时取阶段默认值。
  const rawCap = config?.concurrency != null ? Number(config.concurrency) : fallbackConcurrency;
  const cap = clampInteger(rawCap, AI_CONCURRENCY_LIMITS.min, AI_CONCURRENCY_LIMITS.max, fallbackConcurrency);
  const initial = initialConcurrencyFor(cap);
  return {
    stageKey,
    label,
    // 并发上限；沿用 maxConcurrency 字段名，状态接口里对应 concurrencyMax。
    maxConcurrency: cap,
    initialConcurrency: initial,
    currentConcurrency: initial,
    // 慢启动阈值：当前并发低于它时翻倍增加，达到后转加法增加。首次限流或过载之前等于上限。
    slowStartThreshold: cap,
    // 本轮拥塞开始时记录的最高并发数；0 表示没有需要谨慎恢复的受限并发数。
    knownLimit: 0,
    rampPaused: false,
    consecutiveSuccesses: 0,
    consecutiveLimits: 0,
    lastAdjustmentAt: now(),
    lastScaleDownAt: 0,
    backoffUntil: 0,
    backoffTimer: null,
    rowRetryCounts: new Map(),
  };
}

// 上游每次正常应答后判断是否增加并发。返回 { from, to, mode, successes }（mode: slow-start | additive）或 null。
// pressure 由调用方取自该阶段断路器（失败窗口接近熔断阈值的程度），达到 pauseRampPressure 时暂停增加；
// 暂停期间成功次数照常累计，pressure 降低后可立即增加并发。
function stepUpOnSuccess(ctrl, { now = Date.now(), pressure = 0, policy = CONCURRENCY_POLICY } = {}) {
  ctrl.consecutiveLimits = 0;
  ctrl.consecutiveSuccesses += 1;
  if (ctrl.currentConcurrency >= ctrl.maxConcurrency) {
    ctrl.rampPaused = false;
    return null;
  }
  ctrl.rampPaused = pressure >= policy.pauseRampPressure;
  if (ctrl.rampPaused) return null;
  if (now - ctrl.lastAdjustmentAt < policy.minStepIntervalMs) return null;

  const from = ctrl.currentConcurrency;
  const successes = ctrl.consecutiveSuccesses;
  let to;
  let mode;
  if (from < ctrl.slowStartThreshold) {
    if (successes < from) return null;
    to = Math.min(from * 2, ctrl.slowStartThreshold, ctrl.maxConcurrency);
    mode = "slow-start";
  } else {
    const cautious = ctrl.knownLimit > 0 && from + 1 >= ctrl.knownLimit;
    if (successes < (cautious ? policy.cautiousSuccesses : policy.additiveSuccesses)) return null;
    to = from + 1;
    mode = "additive";
  }
  ctrl.currentConcurrency = to;
  ctrl.consecutiveSuccesses = 0;
  ctrl.lastAdjustmentAt = now;
  // 并发已稳定超过此前记录的受限并发数，清除该记录。
  if (ctrl.knownLimit > 0 && to > ctrl.knownLimit) ctrl.knownLimit = 0;
  return { from, to, mode, successes };
}

function nextConcurrencyAfterLimit(current, minConcurrency = 1) {
  return current > 3
    ? Math.max(minConcurrency, Math.floor(current * 0.7))
    : Math.max(minConcurrency, current - 1);
}

// 下调：把并发降至 next，并记录调整前的并发数。startedAt 是触发这次下调的请求发出时间：
// 早于上一次下调的请求属于同一次拥塞事件，不重复下调。返回 { from, to } 或 null。
//
// 连续几次下调（32→22→15→10→…→1）属于同一段拥塞，保留这段拥塞开始时记录的最高并发数：
// - knownLimit 取最高值：后续下调是为了缓解同一次拥塞，不能将更低的并发数记为新的受限值；
// - slowStartThreshold 只在首次限流或过载时（阈值仍等于上限）降至调整后的并发数，后续下调不再改它，
//   避免连续限流将阈值降至 1，导致恢复后无法慢启动。
function decrease(ctrl, next, { now, startedAt, policy }) {
  const from = ctrl.currentConcurrency;
  if (now - ctrl.lastScaleDownAt <= policy.decreaseDebounceMs) return null;
  if (startedAt != null && startedAt < ctrl.lastScaleDownAt) return null;
  if (next >= from) return null;
  ctrl.currentConcurrency = next;
  if (ctrl.slowStartThreshold >= ctrl.maxConcurrency) ctrl.slowStartThreshold = next;
  ctrl.knownLimit = Math.max(ctrl.knownLimit, from);
  ctrl.lastScaleDownAt = now;
  ctrl.lastAdjustmentAt = now;
  return { from, to: next };
}

function stepDownOnLimit(ctrl, { now = Date.now(), startedAt = null, minConcurrency = 1, policy = CONCURRENCY_POLICY } = {}) {
  ctrl.consecutiveSuccesses = 0;
  return decrease(ctrl, nextConcurrencyAfterLimit(ctrl.currentConcurrency, minConcurrency), { now, startedAt, policy });
}

// 过载型失败（超时、5xx、断连）：温和地 -1。
function stepDownOnOverload(ctrl, { now = Date.now(), startedAt = null, minConcurrency = 1, policy = CONCURRENCY_POLICY } = {}) {
  ctrl.consecutiveSuccesses = 0;
  return decrease(ctrl, Math.max(minConcurrency, ctrl.currentConcurrency - 1), { now, startedAt, policy });
}

// 断路器刚打开（或探测再次失败，进入下一档冷却）：并发降至最低，恢复后从最低并发开始慢启动。
// 慢启动阈值取受限并发数的一半：受限并发数是 knownLimit（限流下调前记录的并发数），
// 不能只使用当前并发数，因为断路器打开前，连续几行的 429 可能已将并发降至 1。
// 此时只按当前并发数计算，阈值也会变成 1，导致恢复后无法慢启动。
// 阈值只降低、不提高：探测再次失败进入下一档冷却时，不能重新提高阈值。
function collapseForBreaker(ctrl, { now = Date.now(), minConcurrency = 1, policy = CONCURRENCY_POLICY } = {}) {
  const from = ctrl.currentConcurrency;
  const peak = Math.max(from, ctrl.knownLimit);
  if (peak > minConcurrency) {
    const half = Math.max(policy.breakerRestartFloor, Math.floor(peak / 2));
    ctrl.slowStartThreshold = Math.min(ctrl.slowStartThreshold, half, ctrl.maxConcurrency);
  }
  ctrl.currentConcurrency = minConcurrency;
  ctrl.consecutiveSuccesses = 0;
  ctrl.lastScaleDownAt = now;
  ctrl.lastAdjustmentAt = now;
  return { from, to: minConcurrency, threshold: ctrl.slowStartThreshold };
}

function describeConcurrencyPolicy(cap, policy = CONCURRENCY_POLICY) {
  const start = initialConcurrencyFor(cap, policy);
  if (cap <= start) {
    return `并发调度：并发上限 ${cap}，直接以上限起步；遇到限流时自动降低并发并退避重试，恢复后回到上限。`;
  }
  return `并发调度：并发上限 ${cap}，从 ${start} 起步。请求稳定时先成倍增加、再逐步上调并发，遇到限流或过载时自动降低；熔断冷却后从 1 重新开始。`;
}

function backoffDelayMs(consecutiveLimits, retryAfter) {
  const parsed = parseFloat(retryAfter);
  if (Number.isFinite(parsed) && parsed > 0) return Math.min(15000, parsed * 1000);
  return Math.min(10000, 1500 * Math.pow(1.5, Math.min(4, consecutiveLimits - 1)));
}

function shouldRetryRow(retries, maxRetries, stopped) {
  return retries <= maxRetries && !stopped;
}

module.exports = {
  CONCURRENCY_POLICY,
  initialConcurrencyFor,
  createStageController,
  stepUpOnSuccess,
  stepDownOnLimit,
  stepDownOnOverload,
  collapseForBreaker,
  nextConcurrencyAfterLimit,
  describeConcurrencyPolicy,
  backoffDelayMs,
  shouldRetryRow,
};

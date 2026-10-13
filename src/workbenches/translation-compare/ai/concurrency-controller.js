// AI 校对的并发调度（纯函数模块：不读 status、不碰网络，时钟可注入）。
//
// 面板只有一个「并发上限」，调度器内部强制自适应，没有对外开关：实际并发在 1~上限 之间自动升降。
// 阶段内派发与通道生命周期归 stage-dispatch.js，跨阶段顺序、业务和结果写入归 ai-proofread.js；
// 这里仅计算「现在该开多少并发」。
//
// 起步：min(上限, 3)。默认上限 3 时就是固定 3，与旧行为一致；上限更高时先用 3 探路，
// 不上来就用满上限去硬打一个陌生的上游。
//
// 上探（两段式）：
// 1. 慢启动：一整轮请求（数量 = 当前并发）全部正常，并发翻倍，直到上限；一旦被限流/过载就转入下一段。
//    上限填 32 时 3→6→12→24→32，几轮就到位，不必等 29 个「连续 5 次」。
// 2. 加法上探：每连续 5 次正常应答 +1。要踏入「上次出事的水位」及以上时，需要连续 15 次——
//    上游的天花板通常不会变，反复撞同一堵墙只会白白多吃几次 429。
// 两次上探之间至少间隔 3 秒，让上一步的效果先显现出来。
//
// 下行（只对「并发造成的压力」出手）：
// - 频控（429/503/529）：并发 >3 时 ×0.7，否则 -1。一次拥塞事件里同时返回的一批限流只算一次：
//   下调之前就已发出的请求不再触发第二次下调，且两次下调至少隔 800ms。
// - 过载型失败（超时、5xx、断连）：-1。这类失败未必是并发造成的，下调要更温和；它们同时会进熔断的失败窗口，
//   提前把并发压下来，是为了在「错误率熔断」终止任务之前先把失败率压回去。
// - 拒答、坏 JSON 等非过载失败对并发中性：既不算加速，也不触发降速——上游是活的，问题不在并发。
//
// 与熔断（circuit-breaker.js）的联动：
// - 断路器打开（限流重试用尽、进入冷却）：并发直接塌到 1，慢启动阈值设为冷却前并发的一半（至少 2）。
//   恢复后从 1 慢启动爬回阈值再加法上探，不会一步跳回冷却前的水位去撞刚刚放行的上游。
// - 失败窗口错误率达到熔断阈值的一半（pressure ≥ 0.5）时暂停上探：不往正在变差的上游继续加压。

const { AI_CONCURRENCY_LIMITS } = require("./concurrency-limits");

const CONCURRENCY_POLICY = Object.freeze({
  // 起步并发的上界：初始并发 = min(上限, startAt)。
  startAt: 3,
  // 加法上探所需的连续正常应答数。
  additiveSuccesses: 5,
  // 踏入已知限流水位及以上时所需的连续正常应答数。
  cautiousSuccesses: 15,
  // 两次上探之间的最短间隔。
  minStepIntervalMs: 3000,
  // 下调后的最短静默期：这段时间内不再下调，等下调的效果显现。
  decreaseDebounceMs: 800,
  // 失败窗口 pressure 达到该值（熔断阈值的一半）时暂停上探。
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
    // 慢启动阈值：当前并发低于它时翻倍上探，达到后转加法上探。首次出事之前等于上限（一路慢启动到顶）。
    slowStartThreshold: cap,
    // 最近一次出事时的并发水位；0 表示没有需要谨慎对待的水位。
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

// 一次「上游正常应答」之后判断要不要上探。返回 { from, to, mode, successes }（mode: slow-start | additive）或 null。
// pressure 由调用方取自该阶段断路器（失败窗口离熔断线的距离），达到 pauseRampPressure 时暂停上探；
// 暂停期间成功次数照常累计，压力回落后可立即上探。
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
  // 已经越过上次出事的水位并且稳住了：不必再对它保持谨慎。
  if (ctrl.knownLimit > 0 && to > ctrl.knownLimit) ctrl.knownLimit = 0;
  return { from, to, mode, successes };
}

function nextConcurrencyAfterLimit(current, minConcurrency = 1) {
  return current > 3
    ? Math.max(minConcurrency, Math.floor(current * 0.7))
    : Math.max(minConcurrency, current - 1);
}

// 下调：把并发压到 next，并记住出事的水位。startedAt 是触发这次下调的那个请求的发出时间：
// 早于上一次下调的请求属于同一次拥塞事件，不重复下调。返回 { from, to } 或 null。
//
// 连续几次下调（32→22→15→10→…→1）属于同一段拥塞，记录要保住「最早、最高」的那个水位：
// - knownLimit 取最高值：真正的天花板是第一次出事时的水位，后面每一步都是在往下躲，不是新的天花板；
// - slowStartThreshold 只在还没出过事（阈值仍等于上限）时收紧到新水位，后续下调不再改它——
//   否则连续限流会把阈值一路带到 1，恢复后就再也没有慢启动可言。
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

// 断路器刚打开（或探测再次失败换了下一档冷却）：并发塌到最低，恢复后从低位慢启动。
// 慢启动阈值取「出事水位的一半」：出事水位是 knownLimit（限流下调时记下的、下调前的并发），
// 而不是塌缩这一刻的当前并发——断路器打开前，连续几行的 429 早已把并发一路压到 1，
// 拿当前并发算「一半」只会得到 1，恢复后就没有慢启动可言。
// 阈值只收紧、不放宽：探测再次失败换下一档冷却时，不能借机把阈值抬回去。
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
    return `并发调度：并发上限 ${cap}，直接以上限起步；遭遇频控限制自动降速并退避重试，恢复后回到上限。`;
  }
  return `并发调度：并发上限 ${cap}，从 ${start} 起步。请求稳定时先翻倍、再逐步上探，遭遇频控限制或过载自动降速；熔断冷却后从 1 重新起步。`;
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

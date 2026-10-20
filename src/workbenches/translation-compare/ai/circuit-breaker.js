// AI 校对的内部熔断决策（纯函数模块：不读 status、不碰 DOM/网络，时钟可注入）。
//
// 熔断不再对外开放开关或阈值：是否熔断、何时熔断完全由这里的策略裁决，页面与请求体都不携带任何熔断参数。
// 阶段内每条预设通道各持一个断路器，分别统计和判定。
//
// 两类错误分别处理，因为它们的代价与可恢复性不同：
//
// 1. 调用失败（模型/接口错误：5xx、超时、断连、输出无效）
//    - 每次调用都是计费的，且往往不会自愈，所以命中即返回通道熔断建议。
//    - 判据：最近 windowSize 次结果里失败占比 ≥ errorRate，且样本满 minimumSamples。
//    - 返回通道熔断建议；阶段及整体任务的终止由调用方汇总。
//
// 2. 限流（429/503/529 且单行重试已用尽）
//    - 被限流的请求会被上游直接拒绝、不计费，冷却后通常能恢复，因此先暂停请求并等待，避免立即终止或持续重试。
//    - 连续 exhaustedRowsToOpen 行「重试用尽」且中间没有任何成功 → 断路器打开：当前通道停止派发，
//      按 cooldownsMs 阶梯冷却（30s → 90s → 4min → 10min）；冷却结束后放行探测请求（半开）：
//      探测成功即恢复，探测再次被限流则进入下一档冷却；阶梯用尽仍被限流才建议通道熔断。
//    - 冷却期间到达的「迟到」结果不推进状态（它们发出时断路器还没打开）。
//
// 拒答（模型内容安全拒绝）与致命配置错误（401/404/非 JSON）不进入本模块：前者是模型的正常回答，后者当场终止。
//
// 与并发调度（concurrency-controller.js）的联动只有两处，都是只读的：
// - state：冷却/半开期间调度器把并发降至 1，恢复后从最低并发开始慢启动，避免直接恢复冷却前的并发数；
// - pressure：失败窗口接近熔断阈值的程度。逼近时调度器暂停增加并发，避免加重上游服务负载。
// 断路器本身不读取、也不修改并发状态，判定逻辑仍完全独立。

const BREAKER_POLICY = Object.freeze({
  failure: Object.freeze({
    windowSize: 20,
    minimumSamples: 10,
    errorRate: 0.5,
    // pressure 的最小样本数：样本太少时一次偶发失败就是 100%，不能据此阻止增加并发。
    pressureSamples: 5,
  }),
  limit: Object.freeze({
    exhaustedRowsToOpen: 3,
    // 冷却阶梯（累计 16 分钟）。被限流的请求由上游直接拒掉、不计费，等待只花时间不花钱，
    // 而过早放弃要人工点「继续剩下的」，所以整体宁长勿短：
    // - 30s：单行退避重试（1.5s 起，Retry-After 封顶 15s）用尽时已过去约 10~20s，再等 30s 正好盖过常见的 1 分钟速率窗口（RPM/TPM）；
    // - 90s：覆盖一个完整分钟窗口再加抖动，第 1 档没盖住的窗口在这里必然放行；
    // - 4min、10min：中转渠道的自动熔断与上游过载（503/529）常按分钟级恢复。累计约 16 分钟仍被限流，
    //   基本可以判定是额度耗尽或长时间故障，继续等没有意义，此时终止并保留已完成的行。
    // 档间比约 3：探测频率随时间指数衰减，避免向尚未恢复的上游频繁发送请求。
    cooldownsMs: Object.freeze([30000, 90000, 240000, 600000]),
  }),
});

function createStageBreaker({ policy = BREAKER_POLICY, now = Date.now, timeScale = 1 } = {}) {
  const scale = Number.isFinite(timeScale) && timeScale > 0 ? timeScale : 1;
  const cooldowns = policy.limit.cooldownsMs.map((ms) => Math.max(1, Math.round(ms * scale)));
  const recent = [];
  let limitStreak = 0;
  let cycle = 0; // 已经用掉的冷却档数；0 = 闭合
  let openUntil = 0;
  let waitedMs = 0;

  function reset() {
    limitStreak = 0;
    cycle = 0;
    openUntil = 0;
    waitedMs = 0;
  }

  function pushOutcome(failed) {
    recent.push(Boolean(failed));
    if (recent.length > policy.failure.windowSize) {
      recent.splice(0, recent.length - policy.failure.windowSize);
    }
  }

  function evaluateWindow() {
    if (recent.length < policy.failure.minimumSamples) return null;
    const errorCount = recent.filter(Boolean).length;
    const rate = errorCount / recent.length;
    if (rate < policy.failure.errorRate) return null;
    return {
      kind: "failure-rate",
      errorCount,
      sampleCount: recent.length,
      errorRate: rate,
      threshold: policy.failure.errorRate,
    };
  }

  // 限流轨清零；若此前处于冷却/半开则视为恢复并返回 true。
  function clearLimit() {
    const recovered = cycle > 0;
    limitStreak = 0;
    if (recovered) reset();
    return recovered;
  }

  function startCooldown() {
    const cooldownMs = cooldowns[cycle];
    cycle += 1;
    waitedMs += cooldownMs;
    openUntil = now() + cooldownMs;
    return { cooldownMs, until: openUntil, cycle, cycles: cooldowns.length };
  }

  return {
    // 成功一次：限流轨清零；若之前处于冷却/半开，则视为恢复。
    // 窗口判据对每个新样本都重新评估（成功样本挤掉旧成功、把错误率抬到阈值时同样成立），不只看失败那一刻。
    recordSuccess() {
      pushOutcome(false);
      return { recovered: clearLimit(), trip: evaluateWindow() };
    },

    // 一次非限流的真实失败。返回 { trip }：trip 非空时建议通道熔断，由调用方汇总终止范围。
    // 请求拿到了非限流的答复，同样说明上游的限流已经放行，限流轨随之解除。
    recordFailure() {
      pushOutcome(true);
      return { recovered: clearLimit(), trip: evaluateWindow() };
    },

    // 拒答等「上游正常应答、但不该计入成败」的结果：只解除限流轨，不进失败窗口。
    recordNotLimited() {
      return { recovered: clearLimit() };
    },

    // 单行限流重试已用尽。action：
    //   fail  —— 断路器仍闭合，按原逻辑把这一行记为失败；
    //   hold  —— 断路器打开/仍在冷却：这一行不记失败，重新排队等冷却结束（opened=true 表示刚刚新开一档）；
    //   trip  —— 冷却阶梯用尽仍被限流，建议通道熔断。
    recordLimitExhausted() {
      if (now() < openUntil) return { action: "hold", until: openUntil, opened: false };
      limitStreak += 1;
      if (cycle === 0) {
        if (limitStreak < policy.limit.exhaustedRowsToOpen) return { action: "fail" };
        return { action: "hold", opened: true, ...startCooldown() };
      }
      // 半开探测失败：换下一档冷却，阶梯用尽则熔断。
      if (cycle >= cooldowns.length) {
        return { action: "trip", kind: "limit-saturation", cycles: cycle, waitedMs };
      }
      return { action: "hold", opened: true, ...startCooldown() };
    },

    get state() {
      if (cycle === 0) return "closed";
      return now() < openUntil ? "open" : "half-open";
    },

    // 失败窗口离熔断线有多近：当前错误率 / 熔断阈值（1 即已到线）。样本不足时为 0。
    get pressure() {
      if (recent.length < policy.failure.pressureSamples) return 0;
      const rate = recent.filter(Boolean).length / recent.length;
      return rate / policy.failure.errorRate;
    },
  };
}

// 时长文案：不足 1 分钟按秒，整分钟按「N 分钟」，其余「N 分 M 秒」。冷却阶梯最长十分钟，
// 用「600 秒」「960 秒」既难读又容易让人误以为是秒级故障。
function formatDuration(ms) {
  const total = Math.max(1, Math.round(ms / 1000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
}

// 终止原因文案。失败轨保持「错误率熔断」的既有措辞，限流轨单独成句并给出可操作的建议。
function describeTrip(trip, stageLabel) {
  if (trip.kind === "limit-saturation") {
    return `AI 上游持续限流熔断（${stageLabel}）：已按 ${trip.cycles} 档冷却重试（累计等待约 ${formatDuration(trip.waitedMs)}）仍被限流，任务已自动终止。已完成的行会保留，稍后可用「继续剩下的」接着跑，或调低并发上限。`;
  }
  return `AI 请求错误率熔断（${stageLabel}）：最近 ${trip.sampleCount} 次处理中有 ${trip.errorCount} 次失败（${Math.round(trip.errorRate * 100)}%，阈值 ${Math.round(trip.threshold * 100)}%），任务已自动终止。`;
}

function describePolicy(policy = BREAKER_POLICY) {
  const cooldowns = policy.limit.cooldownsMs.map((ms) => formatDuration(ms)).join(" → ");
  return `自动熔断：最近 ${policy.failure.windowSize} 次调用中失败占比达到 ${Math.round(policy.failure.errorRate * 100)}% 时终止任务；持续被限流时暂停并按 ${cooldowns} 冷却后探测，仍被限流才终止。`;
}

module.exports = { BREAKER_POLICY, createStageBreaker, describeTrip, describePolicy, formatDuration };

// AI 校对的内部熔断决策（纯函数模块：不读 status、不碰 DOM/网络，时钟可注入）。
//
// 熔断不再对外开放开关或阈值：是否熔断、何时熔断完全由这里的策略裁决，页面与请求体都不携带任何熔断参数。
// 每个阶段（初审 / 复审 / 仲裁）各持一个断路器，互不稀释。
//
// 两类证据走两条独立的轨道，因为它们代价与可恢复性完全不同：
//
// 1. 失败轨（模型/接口真的出了错：5xx、超时、断连、输出坏掉）
//    - 每次调用都是计费的，且往往不会自愈，所以命中就终止任务。
//    - 判据：最近 windowSize 次结果里失败占比 ≥ errorRate，且样本满 minimumSamples。
//
// 2. 限流轨（429/503/529 且单行重试已用尽）
//    - 被限流的请求会被上游直接拒掉、不计费，冷却后通常能恢复，所以不该一刀切终止，也不该硬打。
//    - 连续 exhaustedRowsToOpen 行「重试用尽」且中间没有任何成功 → 断路器打开：整个阶段停止派发，
//      按 cooldownsMs 阶梯冷却（20s → 60s → 180s）；冷却结束后放行探测请求（半开）：
//      探测成功即恢复，探测再次被限流则进入下一档冷却；阶梯用尽仍被限流才终止任务。
//    - 冷却期间到达的「迟到」结果不推进状态（它们发出时断路器还没打开）。
//
// 拒答（模型内容安全拒绝）与致命配置错误（401/404/非 JSON）不进入本模块：前者是模型的正常回答，后者当场终止。

const BREAKER_POLICY = Object.freeze({
  failure: Object.freeze({
    windowSize: 20,
    minimumSamples: 10,
    errorRate: 0.5,
  }),
  limit: Object.freeze({
    exhaustedRowsToOpen: 3,
    cooldownsMs: Object.freeze([20000, 60000, 180000]),
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

    // 一次非限流的真实失败。返回 { trip }：trip 非空时应终止任务。
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
    //   trip  —— 冷却阶梯用尽仍被限流，终止任务。
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
  };
}

function formatSeconds(ms) {
  return `${Math.max(1, Math.round(ms / 1000))} 秒`;
}

// 终止原因文案。失败轨保持「错误率熔断」的既有措辞，限流轨单独成句并给出可操作的建议。
function describeTrip(trip, stageLabel) {
  if (trip.kind === "limit-saturation") {
    return `AI 上游持续限流熔断（${stageLabel}）：已按 ${trip.cycles} 档冷却重试（累计等待约 ${formatSeconds(trip.waitedMs)}）仍被限流，任务已自动终止。已完成的行会保留，稍后可用「继续剩下的」接着跑，或调低并发上限。`;
  }
  return `AI 请求错误率熔断（${stageLabel}）：最近 ${trip.sampleCount} 次处理中有 ${trip.errorCount} 次失败（${Math.round(trip.errorRate * 100)}%，阈值 ${Math.round(trip.threshold * 100)}%），任务已自动终止。`;
}

function describePolicy(policy = BREAKER_POLICY) {
  const cooldowns = policy.limit.cooldownsMs.map((ms) => formatSeconds(ms)).join(" → ");
  return `自动熔断：最近 ${policy.failure.windowSize} 次调用中失败占比达到 ${Math.round(policy.failure.errorRate * 100)}% 时终止任务；持续被限流时暂停并按 ${cooldowns} 冷却后探测，仍被限流才终止。`;
}

module.exports = { BREAKER_POLICY, createStageBreaker, describeTrip, describePolicy };

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  BREAKER_POLICY,
  createStageBreaker,
  describeTrip,
  describePolicy,
  formatDuration,
} = require("../src/workbenches/translation-compare/ai/circuit-breaker");

// 冷却阶梯只从策略常量读：以后再调数字，只改 circuit-breaker.js，不必逐处改断言。
const LADDER = BREAKER_POLICY.limit.cooldownsMs;
const LADDER_TOTAL = LADDER.reduce((sum, ms) => sum + ms, 0);

function fakeClock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test("冷却阶梯：逐档拉长，末档不超过 10 分钟，累计不超过 20 分钟", () => {
  assert.ok(LADDER.length >= 3, "至少三档，给上游足够多的恢复机会");
  for (let i = 1; i < LADDER.length; i += 1) assert.ok(LADDER[i] > LADDER[i - 1], "每一档都比上一档更长");
  assert.ok(LADDER[0] >= 30000, "首档要盖过常见的 1 分钟速率窗口的一部分，太短等于白探测");
  assert.ok(LADDER.at(-1) <= 10 * 60 * 1000, "单档最长 10 分钟：再长用户会以为程序卡死");
  assert.ok(LADDER_TOTAL <= 20 * 60 * 1000, "累计不超过 20 分钟：再久基本是额度耗尽或长时间故障，应终止而不是空等");
});

test("熔断策略是冻结的常量：外部无法改阈值", () => {
  assert.equal(Object.isFrozen(BREAKER_POLICY), true);
  assert.equal(Object.isFrozen(BREAKER_POLICY.failure), true);
  assert.equal(Object.isFrozen(BREAKER_POLICY.limit), true);
  assert.equal(Object.isFrozen(BREAKER_POLICY.limit.cooldownsMs), true);
});

test("失败轨：样本不足时不判定，满 10 次且失败占比达 50% 才熔断", () => {
  const breaker = createStageBreaker();
  for (let i = 0; i < 9; i += 1) assert.equal(breaker.recordFailure().trip, null, "不足 10 个样本不判定");
  const { trip } = breaker.recordFailure();
  assert.equal(trip.kind, "failure-rate");
  assert.equal(trip.sampleCount, 10);
  assert.equal(trip.errorCount, 10);
});

test("失败轨：窗口只看最近 20 次，早期失败会被后来的成功挤出", () => {
  const breaker = createStageBreaker();
  for (let i = 0; i < 4; i += 1) assert.equal(breaker.recordFailure().trip, null);
  for (let i = 0; i < 16; i += 1) assert.equal(breaker.recordSuccess().trip, null);
  // 再来 5 个成功，最早的 4 个失败已滑出窗口。
  for (let i = 0; i < 5; i += 1) assert.equal(breaker.recordSuccess().trip, null);
  for (let i = 0; i < 9; i += 1) assert.equal(breaker.recordFailure().trip, null, `失败占比仍低于 50%（第 ${i + 1} 个）`);
  assert.ok(breaker.recordFailure().trip, "累计 10/20 才熔断");
});

test("失败轨：成功样本把窗口错误率抬到阈值时同样判定", () => {
  const breaker = createStageBreaker();
  for (let i = 0; i < 5; i += 1) breaker.recordFailure();
  for (let i = 0; i < 4; i += 1) assert.equal(breaker.recordSuccess().trip, null);
  // 第 10 个样本是成功，此时窗口 5/10 = 50%。
  assert.ok(breaker.recordSuccess().trip);
});

test("限流轨：连续 3 行重试用尽前只记失败，第 3 行起打开断路器并冷却", () => {
  const clock = fakeClock();
  const breaker = createStageBreaker({ now: clock.now });
  assert.deepEqual(breaker.recordLimitExhausted(), { action: "fail" });
  assert.deepEqual(breaker.recordLimitExhausted(), { action: "fail" });
  const third = breaker.recordLimitExhausted();
  assert.equal(third.action, "hold");
  assert.equal(third.opened, true);
  assert.equal(third.cooldownMs, LADDER[0]);
  assert.equal(third.cycle, 1);
  assert.equal(third.until, clock.now() + LADDER[0]);
  assert.equal(breaker.state, "open");
});

test("限流轨：中间出现成功会清零，限流耗尽的行不进入失败窗口", () => {
  const breaker = createStageBreaker();
  breaker.recordLimitExhausted();
  breaker.recordLimitExhausted();
  breaker.recordSuccess();
  assert.deepEqual(breaker.recordLimitExhausted(), { action: "fail" });
  assert.deepEqual(breaker.recordLimitExhausted(), { action: "fail" });
  // 限流不算「真实失败」：失败窗口里只有 1 个成功样本。
  assert.equal(breaker.recordFailure().trip, null);
});

test("限流轨：冷却期内迟到的结果只回队，不推进阶梯", () => {
  const clock = fakeClock();
  const breaker = createStageBreaker({ now: clock.now });
  for (let i = 0; i < 3; i += 1) breaker.recordLimitExhausted();
  clock.advance(5000);
  const stale = breaker.recordLimitExhausted();
  assert.equal(stale.action, "hold");
  assert.equal(stale.opened, false);
  clock.advance(LADDER[0] - 5000); // 冷却结束
  assert.equal(breaker.state, "half-open");
  const probe = breaker.recordLimitExhausted();
  assert.equal(probe.cooldownMs, LADDER[1], "迟到结果没占用第二档，探测失败才进入第二档");
});

test("限流轨：探测失败逐档拉长冷却，阶梯用尽后熔断终止", () => {
  const clock = fakeClock();
  const breaker = createStageBreaker({ now: clock.now });
  for (let i = 0; i < 3; i += 1) breaker.recordLimitExhausted();
  // 第 1 档已在打开时启用；之后每次探测失败依次进入下一档，末档也探测失败才终止。
  for (let level = 0; level < LADDER.length - 1; level += 1) {
    clock.advance(LADDER[level]);
    assert.equal(breaker.recordLimitExhausted().cooldownMs, LADDER[level + 1], `探测失败进入第 ${level + 2} 档`);
  }
  clock.advance(LADDER.at(-1));
  const verdict = breaker.recordLimitExhausted();
  assert.equal(verdict.action, "trip");
  assert.equal(verdict.kind, "limit-saturation");
  assert.equal(verdict.cycles, LADDER.length);
  assert.equal(verdict.waitedMs, LADDER_TOTAL);
  assert.match(describeTrip(verdict, "初审"), new RegExp(`上游持续限流熔断（初审）：已按 ${LADDER.length} 档冷却重试（累计等待约 ${formatDuration(LADDER_TOTAL)}）`));
});

test("限流轨：半开探测成功即恢复，并且阶梯重新计数", () => {
  const clock = fakeClock();
  const breaker = createStageBreaker({ now: clock.now });
  for (let i = 0; i < 3; i += 1) breaker.recordLimitExhausted();
  clock.advance(LADDER[0]);
  assert.equal(breaker.recordSuccess().recovered, true);
  assert.equal(breaker.state, "closed");
  for (let i = 0; i < 2; i += 1) assert.equal(breaker.recordLimitExhausted().action, "fail");
  assert.equal(breaker.recordLimitExhausted().cooldownMs, LADDER[0], "恢复后重新从第一档冷却开始");
});

test("限流轨：冷却期间的迟到成功说明上游已放行，提前恢复", () => {
  const clock = fakeClock();
  const breaker = createStageBreaker({ now: clock.now });
  for (let i = 0; i < 3; i += 1) breaker.recordLimitExhausted();
  clock.advance(2000);
  assert.equal(breaker.state, "open");
  assert.equal(breaker.recordSuccess().recovered, true);
  assert.equal(breaker.state, "closed");
});

test("timeScale 只缩放冷却时长，用于测试压缩分钟级等待", () => {
  const breaker = createStageBreaker({ timeScale: 0.001 });
  breaker.recordLimitExhausted();
  breaker.recordLimitExhausted();
  assert.equal(breaker.recordLimitExhausted().cooldownMs, Math.round(LADDER[0] * 0.001));
});

test("终止文案：失败轨保持既有措辞，策略摘要如实描述内部阈值", () => {
  const breaker = createStageBreaker();
  let trip = null;
  for (let i = 0; i < 10; i += 1) trip = breaker.recordFailure().trip;
  assert.equal(
    describeTrip(trip, "终审仲裁"),
    "AI 请求错误率熔断（终审仲裁）：最近 10 次处理中有 10 次失败（100%，阈值 50%），任务已自动终止。",
  );
  assert.match(describePolicy(), /最近 20 次调用中失败占比达到 50% 时终止任务/);
  assert.match(describePolicy(), /30 秒 → 1 分 30 秒 → 4 分钟 → 10 分钟 冷却后探测/, "策略摘要按可读时长列出整条阶梯");
});

test("时长文案：不足 1 分钟按秒，整分钟按分钟，其余分秒并列", () => {
  assert.equal(formatDuration(900), "1 秒", "不足 1 秒也至少显示 1 秒，不出现「0 秒」");
  assert.equal(formatDuration(30000), "30 秒");
  assert.equal(formatDuration(59400), "59 秒");
  assert.equal(formatDuration(60000), "1 分钟");
  assert.equal(formatDuration(90000), "1 分 30 秒");
  assert.equal(formatDuration(240000), "4 分钟");
  assert.equal(formatDuration(600000), "10 分钟");
  assert.equal(formatDuration(LADDER_TOTAL), "16 分钟", "30s + 90s + 4min + 10min = 16 分钟");
  assert.equal(formatDuration(95000), "1 分 35 秒");
});

test("限流轨：探测拿到非限流的失败或拒答，同样视为限流已解除", () => {
  for (const settle of [
    (breaker) => breaker.recordFailure(),
    (breaker) => breaker.recordNotLimited(),
  ]) {
    const clock = fakeClock();
    const breaker = createStageBreaker({ now: clock.now });
    for (let i = 0; i < 3; i += 1) breaker.recordLimitExhausted();
    clock.advance(LADDER[0]);
    assert.equal(breaker.state, "half-open");
    assert.equal(settle(breaker).recovered, true);
    assert.equal(breaker.state, "closed");
  }
});

test("拒答只解除限流轨，不进失败窗口", () => {
  const breaker = createStageBreaker();
  for (let i = 0; i < 20; i += 1) assert.equal(breaker.recordNotLimited().recovered, false);
  // 窗口里没有任何样本：仍要攒满 10 次才可能判定。
  for (let i = 0; i < 9; i += 1) assert.equal(breaker.recordFailure().trip, null);
  assert.ok(breaker.recordFailure().trip);
});

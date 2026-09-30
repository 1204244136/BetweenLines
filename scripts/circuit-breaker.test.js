const assert = require("node:assert/strict");
const test = require("node:test");

const {
  BREAKER_POLICY,
  createStageBreaker,
  describeTrip,
  describePolicy,
} = require("../src/workbenches/translation-compare/ai/circuit-breaker");

function fakeClock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

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
  assert.equal(third.cooldownMs, 20000);
  assert.equal(third.cycle, 1);
  assert.equal(third.until, clock.now() + 20000);
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
  clock.advance(15000); // 冷却结束
  assert.equal(breaker.state, "half-open");
  const probe = breaker.recordLimitExhausted();
  assert.equal(probe.cooldownMs, 60000, "迟到结果没占用第二档，探测失败才进入第二档");
});

test("限流轨：探测失败逐档拉长冷却，阶梯用尽后熔断终止", () => {
  const clock = fakeClock();
  const breaker = createStageBreaker({ now: clock.now });
  for (let i = 0; i < 3; i += 1) breaker.recordLimitExhausted();
  clock.advance(20000);
  assert.equal(breaker.recordLimitExhausted().cooldownMs, 60000);
  clock.advance(60000);
  assert.equal(breaker.recordLimitExhausted().cooldownMs, 180000);
  clock.advance(180000);
  const verdict = breaker.recordLimitExhausted();
  assert.equal(verdict.action, "trip");
  assert.equal(verdict.kind, "limit-saturation");
  assert.equal(verdict.cycles, 3);
  assert.equal(verdict.waitedMs, 260000);
  assert.match(describeTrip(verdict, "初审"), /上游持续限流熔断（初审）.*累计等待约 260 秒/);
});

test("限流轨：半开探测成功即恢复，并且阶梯重新计数", () => {
  const clock = fakeClock();
  const breaker = createStageBreaker({ now: clock.now });
  for (let i = 0; i < 3; i += 1) breaker.recordLimitExhausted();
  clock.advance(20000);
  assert.equal(breaker.recordSuccess().recovered, true);
  assert.equal(breaker.state, "closed");
  for (let i = 0; i < 2; i += 1) assert.equal(breaker.recordLimitExhausted().action, "fail");
  assert.equal(breaker.recordLimitExhausted().cooldownMs, 20000, "恢复后重新从第一档冷却开始");
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
  assert.equal(breaker.recordLimitExhausted().cooldownMs, 20);
});

test("终止文案：失败轨保持既有措辞，策略摘要如实描述内部阈值", () => {
  const breaker = createStageBreaker();
  let trip = null;
  for (let i = 0; i < 10; i += 1) trip = breaker.recordFailure().trip;
  assert.equal(
    describeTrip(trip, "终审仲裁"),
    "AI 请求错误率熔断（终审仲裁）：最近 10 次处理中有 10 次失败（100%，阈值 50%），任务已自动终止。",
  );
  assert.match(describePolicy(), /最近 20 次调用中失败占比达到 50% 时终止任务.*20 秒 → 60 秒 → 180 秒/);
});

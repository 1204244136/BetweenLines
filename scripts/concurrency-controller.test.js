const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CONCURRENCY_POLICY,
  initialConcurrencyFor,
  createStageController,
  stepUpOnSuccess,
  stepDownOnLimit,
  stepDownOnOverload,
  collapseForBreaker,
  describeConcurrencyPolicy,
} = require("../src/workbenches/translation-compare/ai/concurrency-controller");
const { resolveConcurrencyCap } = require("../src/workbenches/translation-compare/ai/concurrency-limits");
const { createStageBreaker } = require("../src/workbenches/translation-compare/ai/circuit-breaker");

// 让上探不受「最短间隔」限制：这里测的是策略本身，间隔单独有一条用例。
const policy = { ...CONCURRENCY_POLICY, minStepIntervalMs: 0 };

function controller(cap) {
  return createStageController({ stageKey: "stage1", label: "初审", config: { concurrency: cap }, now: () => 0 });
}

// 单调递增的测试时钟：下调会把 lastAdjustmentAt 记成「当时」，喂成功用的时钟不能倒流回更早的时刻。
let clock = 100_000;

// 喂 n 次成功，返回途中发生的每一次上探。
function feed(ctrl, n, extra = {}) {
  const steps = [];
  for (let i = 0; i < n; i += 1) {
    clock += 1;
    const step = stepUpOnSuccess(ctrl, { now: clock, policy, ...extra });
    if (step) steps.push(step);
  }
  return steps;
}

test("起步并发：min(上限, 3)；默认上限 3 就是固定 3，与旧行为一致", () => {
  assert.equal(initialConcurrencyFor(1), 1);
  assert.equal(initialConcurrencyFor(3), 3);
  assert.equal(initialConcurrencyFor(10), 3);
  assert.equal(initialConcurrencyFor(32), 3);

  const small = controller(2);
  assert.deepEqual({ cur: small.currentConcurrency, max: small.maxConcurrency }, { cur: 2, max: 2 });
  const wide = controller(20);
  assert.deepEqual({ cur: wide.currentConcurrency, max: wide.maxConcurrency, initial: wide.initialConcurrency }, { cur: 3, max: 20, initial: 3 });
});

test("上限是唯一输入：只保底 1，20/99/256 都原样保留（没有 32 硬顶）", () => {
  assert.equal(controller(20).maxConcurrency, 20);
  assert.equal(controller(99).maxConcurrency, 99);
  assert.equal(controller(256).maxConcurrency, 256);
  assert.equal(controller(0).maxConcurrency, 1);
  assert.equal(controller(-5).maxConcurrency, 1);
  // 没配置时取阶段默认值。
  assert.equal(createStageController({ stageKey: "stage3", label: "终审仲裁", config: null, fallbackConcurrency: 2 }).maxConcurrency, 2);
});

test("旧口径折算：开启智能并发的旧数据，上限取 max(初始并发, concurrencyMax)", () => {
  assert.equal(resolveConcurrencyCap({ concurrency: 4, smartConcurrency: true, concurrencyMax: 8 }), 8);
  assert.equal(resolveConcurrencyCap({ concurrency: 12, smartConcurrency: true, concurrencyMax: 8 }), 12);
  assert.equal(resolveConcurrencyCap({ concurrency: 4, smartConcurrency: true, concurrencyMax: 99 }), 99);
  // 关闭智能并发的旧数据，concurrencyMax 是历史遗留、从不生效：上限就是 concurrency。
  assert.equal(resolveConcurrencyCap({ concurrency: 4, smartConcurrency: false, concurrencyMax: 20 }), 4);
  assert.equal(resolveConcurrencyCap({ concurrency: 4, concurrencyMax: 20 }), 4);
  assert.equal(resolveConcurrencyCap({}), 3);
  assert.equal(resolveConcurrencyCap({}, 2), 2);
  assert.equal(resolveConcurrencyCap({ concurrency: "abc" }), 3);
});

test("慢启动：一整轮请求全部正常就翻倍，上限 32 时 3→6→12→24→32", () => {
  const ctrl = controller(32);
  const steps = feed(ctrl, 3 + 6 + 12 + 24 + 100);
  assert.deepEqual(steps.map((s) => `${s.from}>${s.to}:${s.mode}`), [
    "3>6:slow-start",
    "6>12:slow-start",
    "12>24:slow-start",
    "24>32:slow-start",
  ]);
  assert.equal(ctrl.currentConcurrency, 32);
  // 到顶后不再上探。
  assert.equal(feed(ctrl, 50).length, 0);
});

test("慢启动不到一整轮不翻倍：成功数少于当前并发时保持原位", () => {
  const ctrl = controller(16);
  assert.equal(feed(ctrl, 2).length, 0);
  assert.equal(ctrl.currentConcurrency, 3);
  assert.equal(feed(ctrl, 1).length, 1);
  assert.equal(ctrl.currentConcurrency, 6);
});

test("限流下调：并发 >3 时 ×0.7，否则 -1；并把慢启动阈值压到新水位", () => {
  const ctrl = controller(32);
  feed(ctrl, 200); // 爬到 32
  const step = stepDownOnLimit(ctrl, { now: clock, policy });
  assert.deepEqual(step, { from: 32, to: 22 });
  assert.equal(ctrl.slowStartThreshold, 22, "阈值压到出事后的水位，之后不再翻倍冒进");
  assert.equal(ctrl.knownLimit, 32);

  const low = controller(3);
  assert.deepEqual(stepDownOnLimit(low, { now: clock, policy }), { from: 3, to: 2 });
  assert.deepEqual(stepDownOnLimit(low, { now: clock + 5_000, policy }), { from: 2, to: 1 });
  assert.equal(stepDownOnLimit(low, { now: clock + 10_000, policy }), null, "已经是 1，不能再降");
  assert.equal(low.currentConcurrency, 1);
});

test("限流下调去抖：同一次拥塞事件里同时返回的一批 429 只下调一次", () => {
  const ctrl = controller(32);
  feed(ctrl, 200);
  const t0 = clock + 1_000;
  assert.ok(stepDownOnLimit(ctrl, { now: t0, startedAt: t0 - 10, policy }));
  // 下调之前就已发出的请求（startedAt 早于上次下调）：属于同一次拥塞，不再降。
  assert.equal(stepDownOnLimit(ctrl, { now: t0 + 900, startedAt: t0 - 5, policy }), null);
  // 下调之后才发出、依然被限流的请求：这是新证据，可以再降（需过去抖窗口）。
  assert.ok(stepDownOnLimit(ctrl, { now: t0 + 1_500, startedAt: t0 + 100, policy }));
  // 去抖窗口内一律不降。
  assert.equal(stepDownOnLimit(ctrl, { now: t0 + 1_600, startedAt: t0 + 1_550, policy }), null);
});

test("下调之后：先慢启动爬回阈值，再加法上探；越过出事水位需要更长的稳定期", () => {
  const ctrl = controller(32);
  feed(ctrl, 200); // 32
  stepDownOnLimit(ctrl, { now: clock, policy }); // 22，阈值 22，knownLimit 32
  ctrl.currentConcurrency = 10; // 假设继续被压到 10（阈值随之收紧到 10 以下的场景在下一条测）
  ctrl.slowStartThreshold = 22;
  ctrl.consecutiveSuccesses = 0;

  // 10 < 22：慢启动，一整轮（10 次）翻倍，封顶到阈值 22。
  const slow = feed(ctrl, 10);
  assert.deepEqual(slow.map((s) => `${s.from}>${s.to}:${s.mode}`), ["10>20:slow-start"]);
  // 20 < 22：继续慢启动，但翻倍会超阈值，只到 22。
  const toThreshold = feed(ctrl, 20);
  assert.deepEqual(toThreshold.map((s) => `${s.from}>${s.to}:${s.mode}`), ["20>22:slow-start"]);
  // 到达阈值后加法上探：22→23…每 5 次 +1，直到贴近出事水位 32。
  const additive = feed(ctrl, 5);
  assert.deepEqual(additive.map((s) => `${s.from}>${s.to}:${s.mode}`), ["22>23:additive"]);
  ctrl.currentConcurrency = 30;
  ctrl.consecutiveSuccesses = 0;
  ctrl.knownLimit = 32;
  // 30→31 离出事水位还有余量：5 次即可；31→32 会踏入出事水位：要求 15 次。
  assert.equal(feed(ctrl, 5).length, 1);
  assert.equal(ctrl.currentConcurrency, 31);
  assert.equal(feed(ctrl, 14).length, 0, "踏入出事水位前必须更谨慎：14 次不够");
  assert.equal(feed(ctrl, 1).length, 1);
  assert.equal(ctrl.currentConcurrency, 32);
});

test("上探最短间隔：两次调整之间不足 3 秒不上探，成功数照常累计", () => {
  const ctrl = controller(16);
  ctrl.lastAdjustmentAt = 10_000;
  const early = [];
  for (let i = 0; i < 5; i += 1) early.push(stepUpOnSuccess(ctrl, { now: 11_000 + i, policy: CONCURRENCY_POLICY }));
  assert.deepEqual(early.filter(Boolean), []);
  assert.equal(ctrl.consecutiveSuccesses, 5);
  // 间隔够了，累计的成功数立刻兑现。
  const step = stepUpOnSuccess(ctrl, { now: 13_001, policy: CONCURRENCY_POLICY });
  assert.deepEqual({ from: step.from, to: step.to }, { from: 3, to: 6 });
});

test("过载型失败温和 -1，同样受去抖与「同一次事件」约束", () => {
  const ctrl = controller(16);
  feed(ctrl, 3);
  assert.equal(ctrl.currentConcurrency, 6);
  assert.deepEqual(stepDownOnOverload(ctrl, { now: clock, startedAt: 9_900, policy }), { from: 6, to: 5 });
  assert.equal(stepDownOnOverload(ctrl, { now: 10_100, startedAt: 9_950, policy }), null);
  const low = controller(1);
  assert.equal(stepDownOnOverload(low, { now: clock, policy }), null, "已是 1 不能再降");
});

test("与熔断联动：断路器打开，并发塌到 1，慢启动阈值设为冷却前并发的一半（至少 2）", () => {
  const ctrl = controller(32);
  feed(ctrl, 200); // 32
  const collapsed = collapseForBreaker(ctrl, { now: clock, policy });
  assert.deepEqual(collapsed, { from: 32, to: 1, threshold: 16 });
  assert.equal(ctrl.currentConcurrency, 1);
  assert.equal(ctrl.slowStartThreshold, 16);

  // 恢复后从 1 慢启动：1→2→4→8→16，然后才是加法上探；不会一步跳回 32。
  const steps = feed(ctrl, 1 + 2 + 4 + 8 + 5);
  assert.deepEqual(steps.map((s) => `${s.from}>${s.to}:${s.mode}`), [
    "1>2:slow-start",
    "2>4:slow-start",
    "4>8:slow-start",
    "8>16:slow-start",
    "16>17:additive",
  ]);
});

test("与熔断联动：连续限流已把并发压到 1 后断路器才打开，阈值仍取出事水位的一半", () => {
  const ctrl = controller(32);
  feed(ctrl, 200); // 32
  // 连续几行 429 把并发一路压到 1（每次下调都记下出事水位）。
  let t = clock;
  let guard = 0;
  while (ctrl.currentConcurrency > 1) {
    t += 1_000;
    assert.ok(stepDownOnLimit(ctrl, { now: t, policy }), "每次都应有下调");
    assert.ok(++guard < 20, "下调必须收敛到 1");
  }
  assert.equal(ctrl.currentConcurrency, 1);
  assert.ok(ctrl.knownLimit >= 2, "出事水位被记住了");
  const expected = Math.min(ctrl.slowStartThreshold, Math.max(2, Math.floor(ctrl.knownLimit / 2)));
  const collapsed = collapseForBreaker(ctrl, { now: t + 1_000, policy });
  assert.equal(collapsed.from, 1);
  assert.ok(collapsed.threshold >= 2, "不能因为当前并发已是 1，就把阈值算到保底值以下");
  assert.equal(collapsed.threshold, expected);
});

test("与熔断联动：探测再次失败换下一档冷却时，阈值只收紧不放宽", () => {
  const ctrl = controller(32);
  feed(ctrl, 200);
  collapseForBreaker(ctrl, { now: clock, policy });
  assert.equal(ctrl.slowStartThreshold, 16);
  // 冷却期间并发已是 1，第二档冷却不能借机把阈值抬回去，也不能把它压成 0.5。
  const again = collapseForBreaker(ctrl, { now: clock + 5_000, policy });
  assert.deepEqual(again, { from: 1, to: 1, threshold: 16 });

  // 上限很小时阈值保底 2，否则恢复后永远只有 1。
  const tiny = controller(3);
  const c = collapseForBreaker(tiny, { now: clock, policy });
  assert.deepEqual(c, { from: 3, to: 1, threshold: 2 });
});

test("与熔断联动：失败窗口逼近熔断线（pressure ≥ 0.5）时暂停上探，回落后立即恢复", () => {
  const breaker = createStageBreaker();
  const ctrl = controller(16);

  // 5 个样本里 2 个失败：错误率 40%，是熔断阈值 50% 的 0.8 倍 → 该停止加压。
  for (let i = 0; i < 3; i += 1) breaker.recordSuccess();
  for (let i = 0; i < 2; i += 1) breaker.recordFailure();
  assert.ok(breaker.pressure >= CONCURRENCY_POLICY.pauseRampPressure);
  assert.equal(feed(ctrl, 30, { pressure: breaker.pressure }).length, 0, "压力大时无论成功多少次都不上探");
  assert.equal(ctrl.rampPaused, true);
  assert.equal(ctrl.currentConcurrency, 3);

  // 成功把失败挤出窗口，压力回落：成功数在暂停期间已累计，恢复后立即兑现。
  for (let i = 0; i < 20; i += 1) breaker.recordSuccess();
  assert.equal(breaker.pressure, 0);
  const steps = feed(ctrl, 1, { pressure: breaker.pressure });
  assert.equal(steps.length, 1);
  assert.equal(ctrl.rampPaused, false);
});

test("断路器 pressure：样本不足 5 个时恒为 0，偶发一次失败不会卡住上探", () => {
  const breaker = createStageBreaker();
  breaker.recordFailure();
  assert.equal(breaker.pressure, 0);
  for (let i = 0; i < 3; i += 1) breaker.recordFailure();
  assert.equal(breaker.pressure, 0, "4 个样本仍不足");
  breaker.recordFailure(); // 5 个样本，全失败 → 100% / 50% = 2
  assert.equal(breaker.pressure, 2);
});

test("pressure 是只读读数：读取它不改变断路器的判定", () => {
  const breaker = createStageBreaker();
  for (let i = 0; i < 9; i += 1) breaker.recordFailure();
  for (let i = 0; i < 20; i += 1) void breaker.pressure;
  assert.ok(breaker.recordFailure().trip, "第 10 个失败仍按原口径熔断");
});

test("策略文案：如实描述起步并发与上限", () => {
  assert.match(describeConcurrencyPolicy(3), /并发上限 3，直接以上限起步/);
  assert.match(describeConcurrencyPolicy(1), /并发上限 1，直接以上限起步/);
  assert.match(describeConcurrencyPolicy(20), /并发上限 20，从 3 起步/);
});

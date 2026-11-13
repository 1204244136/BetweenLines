const assert = require("node:assert/strict");
const test = require("node:test");
const { createPoolDispatch, POOL_STAGES, MAX_POOL_ROW_ATTEMPTS } = require("../src/workbenches/translation-compare/ai/pool-dispatch");
const { CONCURRENCY_POLICY } = require("../src/workbenches/translation-compare/ai/concurrency-controller");

function fixture(t, presets, options = {}) {
  let timestamp = 10000;
  const scheduled = new Map();
  let wakes = 0;
  const timers = {
    setTimeout(callback, delay) {
      const id = {};
      scheduled.set(id, { callback, at: timestamp + delay });
      return id;
    },
    clearTimeout(id) { scheduled.delete(id); },
  };
  const pool = createPoolDispatch({
    presets, now: () => timestamp, timers, wake: () => { wakes += 1; },
    policy: { ...CONCURRENCY_POLICY, minStepIntervalMs: 1 }, ...options,
  });
  t.after(() => pool.dispose());
  return {
    pool, scheduled,
    get wakes() { return wakes; },
    advance(ms) {
      timestamp += ms;
      for (const [id, task] of [...scheduled]) {
        if (task.at > timestamp) continue;
        scheduled.delete(id);
        task.callback();
      }
    },
  };
}

const preset = (presetId, extra = {}) => ({ presetId, name: presetId, model: presetId, concurrency: 1, ...extra });
const row = (index, length = 5) => ({ index, jp: "原".repeat(length), cn: "译".repeat(length) });
const stageItem = (index, length = 5) => ({ row: row(index, length) });
const refusal = Object.assign(new Error("模型拒答"), { code: "MODEL_REFUSAL" });
const timeout = Object.assign(new Error("request timeout"), { code: "REQUEST_TIMEOUT" });
const rateLimit = { httpStatus: 429, message: "rate limit", retryAfter: "0.01" };

function finish(pool, next, kind = "success", error = undefined) {
  const feedback = pool.stages[next.stageKey].feedback(next.request, { kind, error });
  pool.stages[next.stageKey].release(next.request, { ok: kind === "success" });
  return feedback;
}

test("预设默认适用三个阶段，并发额度由三个阶段共享", (t) => {
  const { pool } = fixture(t, [preset("shared", { concurrency: 2 })]);
  pool.stages.stage1.enqueue(row(1));
  pool.stages.stage2.enqueue(stageItem(2));
  pool.stages.stage3.enqueue(stageItem(3));
  const first = pool.take();
  const second = pool.take();
  assert.equal(pool.take(), null);
  assert.equal(pool.snapshot().inFlight, 2);
  assert.equal(pool.snapshot().concurrencyMax, 2);
  assert.deepEqual(pool.snapshot().presets[0].stages, POOL_STAGES);
  assert.equal(first.item.presetConfig.model, "shared");
  finish(pool, first);
  const third = pool.take();
  assert.deepEqual(new Set([first.stageKey, second.stageKey, third.stageKey]), new Set(POOL_STAGES));
  assert.equal(pool.snapshot().inFlight, 2);
});

test("阶段优先级优先派发已就绪工作，高优先级无任务时接低优先级", (t) => {
  const { pool } = fixture(t, [preset("high", { stagePriorities: { stage1: 1, stage2: 2, stage3: 3 } })], { priorityEnabled: true });
  pool.stages.stage1.enqueue([row(1), row(2)]);
  const first = pool.take();
  assert.equal(first.stageKey, "stage1");
  pool.stages.stage3.enqueue(stageItem(3));
  finish(pool, first);
  const second = pool.take();
  assert.equal(second.stageKey, "stage3");
  finish(pool, second);
  assert.equal(pool.take().stageKey, "stage1");
});

test("关闭优先级按阶段轮转，显式空阶段列表不能接任务", (t) => {
  const { pool } = fixture(t, [preset("off", { stages: [] }), preset("all", { stagePriorities: { stage3: 100 } })]);
  pool.stages.stage1.enqueue([row(1), row(2)]);
  pool.stages.stage3.enqueue(stageItem(3));
  const first = pool.take();
  assert.equal(first.stageKey, "stage1");
  assert.equal(first.item.presetId, "all");
  finish(pool, first);
  assert.equal(pool.take().stageKey, "stage3");
});

test("拒答按预设、阶段和行排除，另一个预设可接手且其它行不受限", (t) => {
  const { pool } = fixture(t, [preset("sensitive"), preset("other")]);
  pool.stages.stage1.enqueue(row(1));
  const first = pool.take();
  assert.equal(first.item.presetId, "sensitive");
  finish(pool, first, "not-limited", refusal);
  pool.stages.stage1.enqueue(row(1));
  assert.equal(pool.take().item.presetId, "other");
  pool.stages.stage2.enqueue(stageItem(1));
  assert.equal(pool.take().item.presetId, "sensitive");
});

test("全部预设拒答后明确报告无可行重试而不是空转", (t) => {
  const { pool } = fixture(t, [preset("only")]);
  pool.stages.stage1.enqueue(row(1));
  finish(pool, pool.take(), "not-limited", refusal);
  assert.equal(pool.canRetry("stage1", row(1)), false);
  pool.stages.stage1.enqueue(row(1));
  assert.equal(pool.take(), null);
  assert.equal(pool.stages.stage1.snapshot().blockedPending, 1);
  assert.deepEqual(pool.stages.stage1.drainBlocked().map((item) => item.index), [1]);
  assert.equal(pool.snapshot().pending, 0);
});

test("超时预设偏好短文本，普通失败有有限的单行重试预算", (t) => {
  const { pool } = fixture(t, [preset("slow")]);
  pool.stages.stage1.enqueue(row(1, 100));
  finish(pool, pool.take(), "failure", timeout);
  pool.stages.stage1.enqueue([row(2, 100), row(3, 2)]);
  const short = pool.take();
  assert.equal(short.item.index, 3);
  finish(pool, short);
  pool.stages.stage1.drainPending();
  for (let count = 1; count < MAX_POOL_ROW_ATTEMPTS; count += 1) {
    pool.stages.stage1.enqueue(row(1));
    finish(pool, pool.take(), "failure", timeout);
  }
  assert.equal(pool.canRetry("stage1", row(1)), false);
  assert.equal(pool.canRetry("stage2", stageItem(1)), true);
  assert.equal(pool.snapshot().presets[0].profile.timeouts, MAX_POOL_ROW_ATTEMPTS);
});

test("同一预设限流阻挡所有阶段，健康预设可接收回队行", (t) => {
  const { pool } = fixture(t, [preset("limited"), preset("healthy")]);
  pool.stages.stage1.enqueue(row(1));
  const first = pool.take();
  assert.equal(finish(pool, first, "rate-limit", rateLimit).retry, true);
  pool.stages.stage3.enqueue(stageItem(2));
  const retry = pool.take();
  assert.equal(retry.item.presetId, "healthy");
  assert.equal(pool.take(), null);
  assert.equal(pool.snapshot().presets.find((item) => item.presetId === "limited").profile.rateLimits, 1);
});

test("限流通道唤醒后仍能从池中取工作，取消定时器后可重设", (t) => {
  const clock = fixture(t, [preset("limited")]);
  clock.pool.stages.stage1.enqueue(row(1));
  finish(clock.pool, clock.pool.take(), "rate-limit", rateLimit);
  clock.pool.cancelWakeups();
  assert.equal(clock.scheduled.size, 0);
  assert.equal(clock.pool.take(), null);
  assert.ok(clock.scheduled.size > 0);
  assert.equal(clock.pool.snapshot().waitReason, "rate_limit");
  clock.advance(1000);
  assert.ok(clock.wakes > 0);
  assert.ok(clock.pool.take());
});

test("致命错误停用共享通道，另一预设继续全部阶段", (t) => {
  const { pool } = fixture(t, [preset("broken"), preset("healthy")]);
  pool.stages.stage1.enqueue(row(1));
  finish(pool, pool.take(), "fatal", { httpStatus: 401, message: "unauthorized" });
  pool.stages.stage3.enqueue(stageItem(2));
  const next = pool.take();
  assert.equal(next.item.presetId, "healthy");
  assert.equal(pool.snapshot().presets.find((item) => item.presetId === "broken").breakerTripped, true);
  assert.equal(pool.stages.stage3.snapshot().breakerBroken, false);
});

test("限流后的收尾偏好不越过显式优先级", (t) => {
  const clock = fixture(t, [preset("limited", { stagePriorities: { stage1: 5, stage3: 1 } })], { priorityEnabled: true });
  const { pool } = clock;
  pool.stages.stage1.enqueue(row(1));
  finish(pool, pool.take(), "rate-limit", rateLimit);
  pool.stages.stage1.drainPending();
  pool.stages.stage1.enqueue([row(2), row(3)]);
  pool.stages.stage3.enqueue(stageItem(4));
  clock.advance(1000);
  assert.equal(pool.take().stageKey, "stage1");
});

test("移除再加入相同 ID 的迟到失败不污染新通道，迟到限流重新回池", (t) => {
  const { pool } = fixture(t, [preset("same", { concurrency: 2 })]);
  pool.stages.stage1.enqueue([row(1), row(2)]);
  const fatal = pool.take();
  const rate = pool.take();
  pool.updatePresets([]);
  assert.equal(pool.snapshot().presets.length, 0);
  assert.equal(pool.snapshot().inFlight, 2);
  pool.updatePresets([preset("same")]);
  const result = finish(pool, fatal, "fatal", { httpStatus: 401, message: "unauthorized" });
  assert.equal(result.events.some((event) => event.type === "trip"), false);
  assert.equal(finish(pool, rate, "rate-limit", rateLimit).retry, true);
  const state = pool.snapshot().presets[0];
  assert.equal(state.breakerTripped, false);
  assert.equal(state.completed, 0);
  assert.equal(state.profile.rateLimits, 0);
  const retry = pool.take();
  assert.equal(retry.item.index, 2);
  assert.equal(retry.item.presetId, "same");
});

test("热更新阶段资格即时生效，旧请求仍释放原通道且不会清掉其它阶段队列", (t) => {
  const { pool } = fixture(t, [preset("shared", { concurrency: 2 })]);
  pool.stages.stage1.enqueue([row(1), row(2)]);
  const first = pool.take();
  pool.stages.stage2.enqueue(stageItem(3));
  pool.updatePresets([preset("shared", { stages: ["stage2"] })]);
  assert.equal(pool.take().stageKey, "stage2");
  assert.equal(pool.stages.stage1.snapshot().blockedPending, 1);
  assert.deepEqual(pool.stages.stage1.drainPending().map((item) => item.index), [2]);
  finish(pool, first);
  assert.equal(pool.snapshot().inFlight, 1);
});

test("同一行的限流重试计数不跨阶段串用", (t) => {
  const clock = fixture(t, [preset("limited")]);
  const { pool } = clock;
  pool.stages.stage1.enqueue(row(1));
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const next = pool.take();
    assert.ok(next);
    assert.equal(finish(pool, next, "rate-limit", rateLimit).retry, attempt < 3);
    clock.advance(1000);
  }
  pool.stages.stage2.enqueue(stageItem(1));
  assert.equal(finish(pool, pool.take(), "rate-limit", rateLimit).retry, true);
});

test("有过限流的预设在同优先级时先处理较小尾队列", (t) => {
  const clock = fixture(t, [preset("limited")]);
  const { pool } = clock;
  pool.stages.stage1.enqueue(row(1));
  finish(pool, pool.take(), "rate-limit", rateLimit);
  pool.stages.stage1.drainPending();
  pool.stages.stage1.enqueue([row(2), row(3), row(4)]);
  pool.stages.stage3.enqueue(stageItem(5));
  clock.advance(1000);
  assert.equal(pool.take().stageKey, "stage3");
});

test("重复预设 ID 只有一条通道，重加后的普通失败预算与旧请求隔离", (t) => {
  const { pool } = fixture(t, [preset("same"), preset("same")]);
  assert.equal(pool.snapshot().presetCount, 1);
  pool.stages.stage1.enqueue(row(1));
  const old = pool.take();
  pool.updatePresets([]);
  pool.updatePresets([preset("same")]);
  finish(pool, old, "failure", timeout);
  for (let attempt = 0; attempt < MAX_POOL_ROW_ATTEMPTS; attempt += 1) {
    assert.equal(pool.canRetry("stage1", row(1)), true);
    pool.stages.stage1.enqueue(row(1));
    finish(pool, pool.take(), "failure", timeout);
  }
  assert.equal(pool.canRetry("stage1", row(1)), false);
});

test("移除重加不清除本次池运行已观察到的拒答", (t) => {
  const { pool } = fixture(t, [preset("same")]);
  pool.stages.stage1.enqueue(row(1));
  const old = pool.take();
  pool.updatePresets([]);
  pool.updatePresets([preset("same")]);
  finish(pool, old, "not-limited", refusal);
  assert.equal(pool.canRetry("stage1", row(1)), false);
  assert.equal(pool.canRetry("stage2", stageItem(1)), true);
  assert.equal(pool.snapshot().presets[0].profile.refusals, 0);
});

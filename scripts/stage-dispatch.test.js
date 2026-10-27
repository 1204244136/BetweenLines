const assert = require("node:assert/strict");
const test = require("node:test");
const { createStageDispatch } = require("../src/workbenches/translation-compare/ai/stage-dispatch");
const { CONCURRENCY_POLICY } = require("../src/workbenches/translation-compare/ai/concurrency-controller");

function clockFixture() {
  let now = 10000;
  const pending = new Map();
  return {
    now: () => now,
    get pendingCount() { return pending.size; },
    setTimeout(callback, delay) {
      const timer = {};
      pending.set(timer, { at: now + delay, callback });
      return timer;
    },
    clearTimeout(timer) { pending.delete(timer); },
    advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...pending].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        now = next[1].at;
        pending.delete(next[0]);
        next[1].callback();
      }
      now = end;
    },
  };
}

const preset = (id, concurrency = 3) => ({ presetId: id, name: id, concurrency, model: id });
const rateError = { httpStatus: 429, message: "rate limit", retryAfter: "0.01" };

function fixture(t, presets = [preset("same")]) {
  const clock = clockFixture();
  let wakes = 0;
  const dispatcher = createStageDispatch({
    stageKey: "stage1", label: "初审", presets, fallbackConfig: preset("fallback"),
    now: clock.now, timers: clock, wake: () => { wakes += 1; },
    policy: { ...CONCURRENCY_POLICY, minStepIntervalMs: 1 },
  });
  t.after(() => dispatcher.dispose());
  return { dispatcher, clock, wakes: () => wakes };
}

test("可用预设仍接 FIFO 队头，待办绑定不变成严格路由", (t) => {
  const { dispatcher } = fixture(t, [preset("a"), preset("b")]);
  const rows = [1, 2, 3, 4].map((index) => ({ index }));
  dispatcher.enqueue(rows);
  const first = dispatcher.take();
  assert.equal(first.item.index, 1);
  assert.equal(first.item.presetId, "a");
  assert.equal(dispatcher.feedback(first.request, { kind: "rate-limit", error: rateError }).retry, true);
  dispatcher.release(first.request);
  const retry = dispatcher.take();
  assert.equal(retry.item.index, 1);
  assert.equal(retry.item.presetId, "b", "健康预设接手冷却预设的队头");
});

test("同 id 重加：旧成功只归还旧通道，新通道配额与完成统计保持不变", (t) => {
  const { dispatcher, clock } = fixture(t, [preset("same", 6)]);
  dispatcher.enqueue([1, 2, 3].map((index) => ({ index })));
  const old = [dispatcher.take(), dispatcher.take(), dispatcher.take()];
  dispatcher.updatePresets([preset("temporary")]);
  dispatcher.updatePresets([preset("same", 6)]);
  dispatcher.enqueue([{ index: 4 }, { index: 5 }]);
  const fresh = [dispatcher.take(), dispatcher.take()];
  clock.advance(4000);
  for (const request of old) {
    dispatcher.feedback(request.request, { kind: "success" });
    assert.equal(dispatcher.release(request.request), true);
    assert.equal(dispatcher.release(request.request), false, "重复归还不扣第二次");
  }
  const state = dispatcher.snapshot();
  assert.equal(state.inFlight, 2);
  assert.equal(state.presets[0].inFlight, 2);
  assert.equal(state.presets[0].completed, 0);
  assert.equal(state.presets[0].quota, 3, "旧通道上调不提升新通道配额");
  assert.equal(state.presets[0].breakerState, "closed");
  dispatcher.release(fresh[0].request);
  dispatcher.release(fresh[1].request);
  assert.equal(dispatcher.snapshot().inFlight, 0);
});

test("同 id 重加：旧请求的真实失败窗口不会熔断新通道", (t) => {
  const { dispatcher, clock } = fixture(t, [preset("same", 12)]);
  let index = 1;
  // 通过真实反馈让旧通道慢启动到 12，随后保留 10 个未完成请求。
  while (dispatcher.snapshot().concurrency < 12) {
    dispatcher.enqueue({ index: index++ });
    const request = dispatcher.take();
    clock.advance(4000);
    dispatcher.feedback(request.request, { kind: "success" });
    dispatcher.release(request.request);
  }
  dispatcher.enqueue(Array.from({ length: 10 }, () => ({ index: index++ })));
  const old = Array.from({ length: 10 }, () => dispatcher.take());
  dispatcher.updatePresets([preset("temporary")]);
  dispatcher.updatePresets([preset("same", 12)]);
  dispatcher.enqueue({ index: index++ });
  const fresh = dispatcher.take();
  const trips = [];
  for (const request of old) {
    trips.push(...dispatcher.feedback(request.request, { kind: "failure", error: { httpStatus: 500, message: "server error" } }).events.filter((event) => event.type === "trip"));
    dispatcher.release(request.request, { ok: false });
  }
  assert.deepEqual(trips, [], "退休通道熔断不进入阶段汇总");
  const state = dispatcher.snapshot();
  assert.equal(state.breakerBroken, false);
  assert.equal(state.presets[0].breakerState, "closed");
  assert.equal(state.presets[0].failures, 0);
  assert.equal(state.presets[0].inFlight, 1);
  assert.equal(state.presets[0].completed, 0);
  assert.equal(state.presets[0].quota, 3);
  dispatcher.release(fresh.request);
});

test("同 id 重加：旧 429 回队，但不继承旧退避；新派发获得新配置", (t) => {
  const { dispatcher, clock } = fixture(t);
  dispatcher.enqueue({ index: 1 });
  const old = dispatcher.take();
  dispatcher.updatePresets([preset("temporary")]);
  dispatcher.updatePresets([{ ...preset("same"), model: "new-model" }]);
  assert.equal(dispatcher.feedback(old.request, { kind: "rate-limit", error: rateError }).retry, true);
  dispatcher.release(old.request);
  const retry = dispatcher.take();
  assert.equal(retry.item.index, 1);
  assert.equal(retry.item.presetConfig.model, "new-model");
  assert.equal(dispatcher.snapshot().presets[0].quota, 3);
  assert.equal(dispatcher.snapshot().presets[0].completed, 0);
  assert.equal(clock.pendingCount, 0, "退休请求不创建唤醒新通道的定时器");
});

test("移除仍有请求正在处理的通道后，阶段等待旧请求；finally 清掉其唤醒定时器", (t) => {
  const { dispatcher, clock, wakes } = fixture(t);
  dispatcher.enqueue({ index: 1 });
  const old = dispatcher.take();
  dispatcher.feedback(old.request, { kind: "rate-limit", error: rateError });
  assert.equal(clock.pendingCount, 1);
  dispatcher.updatePresets([preset("new")]);
  assert.equal(dispatcher.snapshot().inFlight, 1);
  assert.equal(dispatcher.snapshot().presets[0].inFlight, 0);
  dispatcher.release(old.request);
  assert.equal(clock.pendingCount, 0);
  clock.advance(100000);
  assert.equal(wakes(), 0);
  assert.equal(dispatcher.snapshot().inFlight, 0);
});

test("dispose 覆盖退休通道，晚到 release 仍可收尾，句柄不跨阶段使用", (t) => {
  const { dispatcher, clock, wakes } = fixture(t);
  const other = fixture(t).dispatcher;
  dispatcher.enqueue({ index: 1 });
  const request = dispatcher.take();
  assert.equal(other.release(request.request), false);
  dispatcher.feedback(request.request, { kind: "rate-limit", error: rateError });
  dispatcher.updatePresets([preset("new")]);
  dispatcher.dispose();
  assert.equal(clock.pendingCount, 0);
  clock.advance(100000);
  assert.equal(wakes(), 0);
  assert.equal(dispatcher.take(), null);
  assert.deepEqual(dispatcher.feedback(request.request, { kind: "success" }), { retry: false, events: [] });
  assert.equal(dispatcher.release(request.request), true);
  assert.equal(dispatcher.snapshot().inFlight, 0);
});

test("热更新保持现有连接参数，删空回落；drainPending 返回完整领域条目", (t) => {
  const { dispatcher } = fixture(t);
  const item = { row: { index: 1 }, decision: { complete: true } };
  dispatcher.enqueue(item);
  dispatcher.updatePresets([{ ...preset("same", 9), model: "changed" }]);
  const request = dispatcher.take();
  assert.equal(request.item.presetConfig.model, "same", "现有 id 的连接不会在热更新中刷新");
  assert.equal(dispatcher.snapshot().concurrencyMax, 3);
  dispatcher.release(request.request);
  const updated = dispatcher.updatePresets([]);
  assert.equal(updated.fallback, true);
  assert.deepEqual(updated.added, ["fallback"]);
  dispatcher.enqueue(item);
  assert.deepEqual(dispatcher.drainPending(), [item]);
  assert.equal(dispatcher.snapshot().pending, 0);
});

test("限流等待状态：真实退避期间报告原因与重试时间，到期由原有定时器唤醒", (t) => {
  const { dispatcher, clock, wakes } = fixture(t, [preset("same", 128)]);
  dispatcher.enqueue([1, 2].map((index) => ({ index })));
  const request = dispatcher.take();
  dispatcher.feedback(request.request, { kind: "rate-limit", error: rateError });
  dispatcher.release(request.request);
  const state = dispatcher.snapshot();
  assert.equal(state.inFlight, 0);
  assert.equal(state.pending, 2);
  assert.equal(state.concurrency, 2);
  assert.equal(state.waitReason, "rate_limit");
  assert.ok(state.retryAt > clock.now());
  assert.equal(state.presets[0].waitReason, "rate_limit");
  assert.equal(state.presets[0].retryAt, state.retryAt);
  assert.equal(clock.pendingCount, 1);
  assert.deepEqual(dispatcher.snapshot(), state, "读取等待状态不修改计时器或派发状态");
  assert.equal(clock.pendingCount, 1);
  assert.equal(dispatcher.take(), null);
  clock.advance(state.retryAt - clock.now() - 1);
  assert.equal(wakes(), 0);
  assert.equal(dispatcher.snapshot().waitReason, "rate_limit");
  clock.advance(1);
  assert.equal(wakes(), 1);
  assert.equal(dispatcher.snapshot().waitReason, "");
  assert.equal(dispatcher.snapshot().retryAt, 0);
  assert.equal(dispatcher.snapshot().presets[0].waitReason, "");
  assert.ok(dispatcher.take(), "到期后仍由真实派发闸门放行");
});

test("持续限流冷却报告 cooldown，半开探测不残留过期等待", (t) => {
  const { dispatcher, clock } = fixture(t);
  dispatcher.enqueue([1, 2, 3, 4].map((index) => ({ index })));
  for (let row = 1; row <= 3; row += 1) {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const request = dispatcher.take();
      assert.equal(request.item.index, row);
      const feedback = dispatcher.feedback(request.request, { kind: "rate-limit", error: rateError });
      dispatcher.release(request.request, { ok: false });
      const state = dispatcher.snapshot();
      if (row === 3 && attempt === 4) {
        assert.equal(feedback.retry, true);
        assert.equal(state.waitReason, "cooldown");
        assert.equal(state.presets[0].waitReason, "cooldown");
        assert.equal(state.presets[0].breakerState, "open");
        assert.equal(state.retryAt, clock.now() + 30000);
        assert.equal(dispatcher.take(), null);
        clock.advance(state.retryAt - clock.now());
      } else {
        assert.equal(feedback.retry, attempt <= 3);
        clock.advance(state.retryAt - clock.now());
      }
    }
  }
  const state = dispatcher.snapshot();
  assert.equal(state.waitReason, "");
  assert.equal(state.retryAt, 0);
  assert.equal(state.presets[0].breakerState, "half-open");
  const probe = dispatcher.take();
  assert.ok(probe);
  assert.equal(dispatcher.take(), null, "半开仍只放行一个探测，不因状态读取改变");
  dispatcher.feedback(probe.request, { kind: "success" });
  dispatcher.release(probe.request);
  assert.equal(dispatcher.snapshot().presets[0].waitReason, "");
});

test("多预设分别等待：健康预设可接队头，全部受阻时阶段报告最早恢复时间", (t) => {
  const { dispatcher, clock } = fixture(t, [preset("a"), preset("b")]);
  dispatcher.enqueue([1, 2].map((index) => ({ index })));
  const first = dispatcher.take();
  dispatcher.feedback(first.request, { kind: "rate-limit", error: { ...rateError, retryAfter: "2" } });
  dispatcher.release(first.request);
  let state = dispatcher.snapshot();
  assert.equal(state.presets.find((item) => item.presetId === "a").waitReason, "rate_limit");
  assert.equal(state.presets.find((item) => item.presetId === "b").waitReason, "");
  assert.equal(state.waitReason, "", "单个预设等待不代表整个阶段等待");
  assert.equal(state.retryAt, 0);
  const second = dispatcher.take();
  assert.equal(second.item.presetId, "b");
  dispatcher.feedback(second.request, { kind: "rate-limit", error: rateError });
  dispatcher.release(second.request);
  state = dispatcher.snapshot();
  assert.equal(state.waitReason, "rate_limit");
  assert.equal(state.retryAt, Math.min(...state.presets.map((item) => item.retryAt)));
  clock.advance(state.retryAt - clock.now());
  assert.equal(dispatcher.snapshot().waitReason, "");
  assert.ok(dispatcher.take());
});

test("移除、清空待办与 dispose 后不再报告旧等待", (t) => {
  const { dispatcher } = fixture(t);
  dispatcher.enqueue({ index: 1 });
  const request = dispatcher.take();
  dispatcher.feedback(request.request, { kind: "rate-limit", error: rateError });
  dispatcher.release(request.request);
  assert.equal(dispatcher.snapshot().waitReason, "rate_limit");
  dispatcher.updatePresets([preset("replacement")]);
  assert.equal(dispatcher.snapshot().waitReason, "");
  assert.equal(dispatcher.snapshot().presets[0].retryAt, 0);
  const replacement = dispatcher.take();
  dispatcher.feedback(replacement.request, { kind: "rate-limit", error: rateError });
  dispatcher.release(replacement.request);
  assert.equal(dispatcher.snapshot().waitReason, "rate_limit");
  const pending = dispatcher.drainPending();
  assert.equal(dispatcher.snapshot().waitReason, "");
  assert.equal(dispatcher.snapshot().presets[0].waitReason, "");
  dispatcher.enqueue(pending);
  assert.equal(dispatcher.snapshot().waitReason, "rate_limit");
  dispatcher.dispose();
  assert.equal(dispatcher.snapshot().waitReason, "");
  assert.equal(dispatcher.snapshot().retryAt, 0);
  assert.equal(dispatcher.snapshot().presets[0].waitReason, "");
  assert.equal(dispatcher.snapshot().presets[0].retryAt, 0);
});

test("阶段等待仅汇总未熔断通道，已经熔断的预设不遮住剩余通道的退避", (t) => {
  const { dispatcher } = fixture(t, [preset("broken"), preset("waiting")]);
  dispatcher.enqueue(Array.from({ length: 12 }, (_, index) => ({ index: index + 1 })));
  let failed = dispatcher.take();
  const waiting = dispatcher.take();
  dispatcher.feedback(waiting.request, { kind: "rate-limit", error: { ...rateError, retryAfter: "15" } });
  dispatcher.release(waiting.request);
  for (let count = 0; count < 10; count += 1) {
    if (count > 0) failed = dispatcher.take();
    assert.equal(failed.item.presetId, "broken");
    dispatcher.feedback(failed.request, { kind: "failure", error: { httpStatus: 500, message: "server error" } });
    dispatcher.release(failed.request, { ok: false });
  }
  const state = dispatcher.snapshot();
  assert.equal(state.presets.find((item) => item.presetId === "broken").breakerTripped, true);
  assert.equal(state.presets.find((item) => item.presetId === "broken").waitReason, "");
  assert.equal(state.breakerBroken, false);
  assert.equal(state.waitReason, "rate_limit");
  assert.equal(state.retryAt, state.presets.find((item) => item.presetId === "waiting").retryAt);
});

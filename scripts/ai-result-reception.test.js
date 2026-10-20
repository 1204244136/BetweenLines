const assert = require("node:assert/strict");
const test = require("node:test");
const { createAiResultReception } = require("../src/workbenches/translation-compare/ai-result-reception");

const scope = { projectKey: "project", rowsSignature: "rows" };
const result = (index, resultRevision = index, overrides = {}) => ({
  index, resultRevision, runId: "run-a", signature: `sig-${index}`, status: "same", ...overrides,
});
const status = (results = [], overrides = {}) => ({
  ...scope, runId: "run-a", running: false, resultRevision: results.at(-1)?.resultRevision || 0,
  results, ...overrides,
});
const reception = (options = {}) => createAiResultReception({
  ...scope, signatureFor: (index) => `sig-${index}`, ...options,
});
const consume = (session, packet, batches = []) => session.commit(session.begin(packet), (items) => {
  batches.push(items);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function fakeTimers() {
  const pending = new Map();
  let nextId = 0;
  return {
    pending,
    setTimeout(callback, delay) {
      const id = ++nextId;
      pending.set(id, { callback, delay });
      return id;
    },
    fire() {
      const [id, timer] = pending.entries().next().value;
      pending.delete(id);
      timer.callback();
      return timer.delay;
    },
  };
}

async function settle() {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
}

test("两阶段交付：begin 不提前消费游标，备注批次完成后才提交；保存返回失败仍消费", () => {
  const session = reception();
  consume(session, status([result(1)]));
  const receipt = session.begin(status([result(2, 3)], { resultRevision: 3 }));
  assert.equal(session.snapshot().resultRevision, 1);
  const applied = session.commit(receipt, (items) => {
    assert.equal(session.snapshot().resultRevision, 1, "DOM 和备注处理期间仍保留上次游标");
    assert.deepEqual(items.map((item) => item.index), [2]);
    return false;
  });
  assert.equal(applied.applied, 1);
  assert.equal(session.snapshot().resultRevision, 3, "保存未成功时，内存成果仍已接收");
});

test("批次应用抛错不推进游标，重送仍遵守已认领结果的去重口径", () => {
  const session = reception();
  consume(session, status([result(1)]));
  const packet = status([result(2)], { resultRevision: 2 });
  assert.throws(() => session.commit(session.begin(packet), () => {
    throw new Error("apply failed");
  }), /apply failed/);
  assert.equal(session.snapshot().resultRevision, 1);
  const batches = [];
  assert.equal(consume(session, packet, batches).applied, 0);
  assert.deepEqual(batches, [[]]);
  assert.equal(session.snapshot().resultRevision, 2);
});

test("结果准入：重复回包不重复写入，新修订可接收，错误签名只提示一次，忽略运行不降级恢复成果", () => {
  const session = reception({ ignoredRunIds: ["incomplete"] });
  const batches = [];
  const packet = status([
    result(1), result(1), result(2, 2, { signature: "old-signature" }),
    result(3, 3, { runId: "incomplete" }),
  ], { resultRevision: 3 });
  assert.deepEqual(consume(session, packet, batches), { applied: 1, skippedStale: 1, ignoredForeign: false });
  assert.deepEqual(consume(session, packet, batches), { applied: 0, skippedStale: 0, ignoredForeign: false });
  const changed = result(1, 4, { status: "suggestion" });
  assert.equal(consume(session, status([changed]), batches).applied, 1);
  assert.deepEqual(batches.map((items) => items.map((item) => item.resultRevision)), [[1], [], [4]]);
  assert.equal(session.snapshot().resultRevision, 4);
});

test("换轮观察先于项目准入；discard 保留游标，已清除运行仅阻止静止回包", () => {
  const session = reception();
  const batches = [];
  consume(session, status([result(1)], { resultRevision: 5 }), batches);
  session.discardCurrentRun();
  assert.equal(session.snapshot().resultRevision, 5);
  const idle = session.begin(status([result(2)], { resultRevision: 6 }));
  assert.equal(idle.cleared, true);
  session.commit(idle, () => assert.fail("已清除的静止运行不能写备注"));
  assert.equal(session.snapshot().resultRevision, 5);
  assert.equal(consume(session, status([result(2)], { running: true, resultRevision: 6 }), batches).applied, 1);

  const foreign = session.begin(status([result(3)], { projectKey: "other", runId: "run-b", resultRevision: 7 }));
  assert.equal(foreign.runChanged, true);
  assert.equal(foreign.sameScope, false);
  assert.equal(session.snapshot().runId, "run-b");
  assert.equal(session.snapshot().resultRevision, 0);
  assert.equal(session.commit(foreign, (items, summary) => {
    assert.deepEqual(items, [], "其他项目不能写备注");
    assert.equal(summary.ignoredForeign, true);
  }).ignoredForeign, true);
  assert.equal(session.snapshot().resultRevision, 7, "其他项目回包也按旧行为消费交付游标");
  session.ignoreRun("run-b");
  session.resetReception();
  assert.equal(session.begin(status([], { runId: "run-b" })).cleared, true, "reset 不解除运行墓碑");
});

test("清除行失败保留墓碑；指定确认只解除对应行，成功请求只确认其携带的行", async () => {
  const requests = [];
  const successfulClear = deferred();
  const session = reception({ clearResults(payload) {
    requests.push(payload);
    return requests.length === 2 ? successfulClear.promise : Promise.reject(new Error("offline"));
  } });
  await session.forgetRows([1, "2", 2, 0, -1, 1.5, "bad"]);
  assert.deepEqual(requests[0], { ...scope, forgetResultIndexes: [1, 2] });
  session.resetReception();
  assert.deepEqual(session.snapshot().forgottenIndexes, [1, 2]);
  const batches = [];
  assert.equal(consume(session, status([result(1), result(2), result(3)]), batches).applied, 1);
  assert.deepEqual(batches[0].map((item) => item.index), [3]);
  session.acknowledgeForgotten([1]);
  assert.deepEqual(session.snapshot().forgottenIndexes, [2]);
  const pending = session.forgetRows([2]);
  await session.forgetRows([3]);
  successfulClear.resolve();
  await pending;
  assert.deepEqual(session.snapshot().forgottenIndexes, [3], "较早请求成功不能清掉稍后新增的行墓碑");
  assert.equal(consume(session, status([result(1), result(2)], { resultRevision: 4 })).applied, 2);
});

test("受控轮询：请求互斥、每批游标参数与 16ms 追赶均由接收会话持有", async () => {
  const timers = fakeTimers();
  const requests = [];
  const batches = [];
  let profile = "profile-a";
  let session;
  session = reception({ timers, getProfileId: () => profile, requestStatus(params) {
    const response = deferred();
    requests.push({ params: Object.fromEntries(params), response });
    return response.promise;
  }, onStatus(packet) { consume(session, packet, batches); } });
  const first = session.refresh();
  await session.refresh();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].params, {
    compact: "1", resultLimit: "64", profileId: "profile-a", ...scope,
  });
  requests[0].response.resolve({ ok: true, ai: status([result(1)], { hasMoreResults: true }) });
  await first;
  assert.equal(timers.pending.size, 1);
  assert.equal(session.snapshot().resultRevision, 1);
  profile = "profile-b";
  assert.equal(timers.fire(), 16);
  await session.refresh();
  assert.equal(requests.length, 2, "定时器发出的追赶请求也受同一请求互斥锁保护");
  assert.equal(requests[1].params.runId, "run-a");
  assert.equal(requests[1].params.afterRevision, "1");
  assert.equal(requests[1].params.profileId, "profile-b");
  requests[1].response.resolve({ ok: true, ai: status([result(2)]) });
  await settle();
  assert.deepEqual(batches.map((items) => items.map((item) => item.index)), [[1], [2]]);
  assert.equal(session.snapshot().resultRevision, 2);
  assert.equal(timers.pending.size, 0);
});

test("reset 保留尚未完成的请求及追赶：旧 running 响应仍可接收，已清除运行仍拦截停止状态的响应", async () => {
  const timers = fakeTimers();
  const requests = [];
  const batches = [];
  let session;
  session = reception({ timers, requestStatus(params) {
    const response = deferred();
    requests.push({ params: Object.fromEntries(params), response });
    return response.promise;
  }, onStatus(packet) { consume(session, packet, batches); } });
  consume(session, status([result(1)]), batches);
  session.ignoreRun("run-a");
  const inFlight = session.refresh();
  session.resetReception();
  await session.refresh();
  assert.equal(requests.length, 1, "reset 不释放正在等待返回的请求锁");
  requests[0].response.resolve({ ok: true, ai: status([result(1)], { running: true, hasMoreResults: true }) });
  await inFlight;
  assert.deepEqual(batches.map((items) => items.map((item) => item.index)), [[1], [1]]);
  assert.equal(timers.pending.size, 1);
  session.resetReception();
  assert.equal(timers.fire(), 16, "reset 不取消已安排的追赶");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].params.runId, undefined);
  requests[1].response.resolve({ ok: true, ai: status([result(2)]) });
  await settle();
  assert.equal(batches.length, 2, "清除墓碑仍拦住旧运行的静止回包");
  assert.equal(session.snapshot().resultRevision, 0);
});

test("轮询失败报告连接异常并释放请求锁；非成功响应不认领结果或安排追赶", async () => {
  const timers = fakeTimers();
  let calls = 0;
  let unavailable = 0;
  const batches = [];
  let session;
  session = reception({ timers, getProfileId: () => "", requestStatus(params) {
    assert.equal(params.get("profileId"), "", "空档案选择仍保留原请求参数");
    calls += 1;
    if (calls === 1) return Promise.reject(new Error("offline"));
    return Promise.resolve({ ok: calls === 3, ai: status([result(1)], { hasMoreResults: calls === 2 }) });
  }, onStatus(packet) { consume(session, packet, batches); }, onUnavailable() { unavailable += 1; } });
  await session.refresh();
  await session.refresh();
  assert.equal(unavailable, 1);
  assert.equal(batches.length, 0);
  assert.equal(timers.pending.size, 0);
  await session.refresh();
  assert.equal(calls, 3);
  assert.equal(batches.length, 1);
});

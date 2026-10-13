const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createProofreadResults } = require("../src/workbenches/translation-compare/ai/proofread-results");
const { readResults, writeResults } = require("../src/workbenches/translation-compare/ai/result-store");

const scope = { projectKey: "project-a", rowsSignature: "rows-a" };
const metadata = { ...scope, runId: "run-a", kind: "proofread", total: 1000, finishedAt: null };

function fakeClock() {
  let now = 0;
  const pending = new Map();
  return {
    setTimeout(callback, delay) {
      const timer = { unref() {} };
      pending.set(timer, { callback, at: now + delay });
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

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "betweenlines-results-"));
  const clock = fakeClock();
  const errors = [];
  const results = createProofreadResults({ dataDir, timers: clock, onPersistError: (error) => errors.push(error) });
  t.after(() => {
    results.reset();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  results.begin(metadata);
  return { results, clock, errors, dataDir, stored: () => readResults(scope.projectKey, scope.rowsSignature, { dataDir }) };
}

test("结果 interface：最新结果按行排序，增量分页保留同一行的每次修订", (t) => {
  const { results } = fixture(t);
  results.record({ index: 2, note: "old" });
  results.record({ index: 1, note: "first" });
  results.record({ index: 2, note: "new" });
  assert.deepEqual(results.read().results.map((item) => [item.index, item.note]), [[1, "first"], [2, "new"]]);
  const first = results.read({ runId: metadata.runId, resultLimit: 2 });
  assert.deepEqual(first.results.map((item) => item.resultRevision), [1, 2]);
  assert.equal(first.hasMoreResults, true);
  const next = results.read({ runId: metadata.runId, afterRevision: first.resultRevision, resultLimit: 2 });
  assert.deepEqual(next.results.map((item) => [item.index, item.note, item.resultRevision]), [[2, "new", 3]]);
  assert.equal(next.hasMoreResults, false);
});

test("结果交付保持旧 runId、缺身份、异项目和不消费游标的口径", (t) => {
  const { results } = fixture(t);
  for (let index = 1; index <= 3; index += 1) results.record({ index, note: String(index) });
  for (const runId of [undefined, "old-run"]) {
    assert.equal(results.read({ runId, afterRevision: 2, resultLimit: 1 }).results[0].index, 1);
  }
  assert.equal(results.read().results.length, 3, "缺身份仍可交付内存结果");
  const foreign = results.read({ ...scope, projectKey: "other", runId: metadata.runId, afterRevision: 1, resultLimit: 1 });
  assert.deepEqual(foreign.results, []);
  assert.equal(foreign.resultRevision, 1);
  assert.equal(foreign.latestResultRevision, 3);
  assert.equal(foreign.hasMoreResults, true);
  const statusOnly = results.read({ runId: metadata.runId, afterRevision: 2, includeResults: false });
  assert.deepEqual(statusOnly.results, []);
  assert.equal(statusOnly.resultRevision, 2);
  assert.equal(statusOnly.latestResultRevision, 3);
  assert.equal(statusOnly.hasMoreResults, true);
  assert.equal(results.read({ resultLimit: -1 }).results.length, 3, "0 表示不限量");
});

test("启动先取同快照完整结果；返回集合不与新轮次共享所有权", (t) => {
  const { results, clock, stored } = fixture(t);
  results.record({ index: 1, note: "old", decision: { complete: true } });
  clock.advance(10000);
  const previous = results.begin({ ...metadata, runId: "run-b" }, { reusePrevious: true });
  assert.equal(previous.get(1).decision.complete, true);
  assert.equal(results.get(1), undefined);
  previous.set(2, { index: 2, note: "external" });
  assert.equal(results.get(2), undefined);
  results.record({ index: 1, note: "new" });
  assert.equal(previous.get(1).note, "old");
  clock.advance(20000);
  assert.equal(stored(), null, "旧轮次的定时回调不能提前落盘新轮次结果");
  clock.advance(10000);
  assert.deepEqual(stored().results.map((item) => item.note), ["new"]);
  assert.equal(stored().runId, "run-b");
  const different = results.begin({ ...metadata, rowsSignature: "other" }, { reusePrevious: true });
  assert.equal(different.size, 0, "跨行集不复用");
});

test("恢复不抢占运行任务；跨项目返回展示复位信号，空项目也清掉旧结果", (t) => {
  const { results, dataDir } = fixture(t);
  const other = { projectKey: "project-b", rowsSignature: "rows-b" };
  writeResults(other.projectKey, other.rowsSignature, { runId: "stored-run", results: [{ index: 7, note: "stored" }] }, { dataDir });
  results.record({ index: 1, note: "active" });
  assert.deepEqual(results.restore(other, { running: true }), { resetTask: false, metadata: null });
  assert.equal(results.get(1).note, "active");
  const restored = results.restore(other);
  assert.equal(restored.resetTask, true);
  assert.equal(restored.metadata.total, 1);
  assert.equal(restored.metadata.runId, "stored-run");
  assert.equal(results.get(1), undefined);
  assert.equal(results.get(7).resultRevision, 1);
  restored.metadata.runId = "external";
  assert.equal(results.read({ runId: "stored-run", afterRevision: 1 }).resultRevision, 1);
  const missing = results.restore(scope);
  assert.deepEqual(missing, { resetTask: true, metadata: null });
  assert.deepEqual(results.read().results, []);
});

test("200 次更新触发落盘；不足阈值从首个脏结果计 30 秒", (t) => {
  const { results, clock, stored } = fixture(t);
  for (let index = 1; index < 200; index += 1) results.record({ index, note: String(index) });
  assert.equal(stored(), null);
  results.record({ index: 200, note: "threshold" });
  assert.equal(stored().results.length, 200);
  clock.advance(20000);
  results.record({ index: 201, note: "timed" });
  clock.advance(29999);
  assert.equal(stored().results.length, 200);
  results.record({ index: 202, note: "later" });
  clock.advance(1);
  assert.equal(stored().results.length, 202, "后续更新不延长首个脏结果的期限");
});

test("收尾立即合并落盘，reset 取消旧定时器，内存清理与整份删除独立", (t) => {
  const { results, clock, stored, dataDir } = fixture(t);
  writeResults(scope.projectKey, scope.rowsSignature, { results: [{ index: 9, note: "kept" }] }, { dataDir });
  results.record({ index: 1, note: "finished" });
  results.finish("finished-at");
  assert.deepEqual(stored().results.map((item) => item.index), [1, 9]);
  assert.equal(stored().finishedAt, "finished-at");
  assert.equal(stored().total, 1000);
  results.record({ index: 2, note: "discarded" });
  results.reset();
  clock.advance(30000);
  assert.deepEqual(stored().results.map((item) => item.index), [1, 9]);
  results.restore(scope);
  results.reset({ clearPersisted: true });
  assert.equal(stored(), null);
});

test("局部清除同步盘上与内存并重编号；启动遗忘只删磁盘", (t) => {
  const { results, stored } = fixture(t);
  results.record({ index: 1, note: "first" });
  results.record({ index: 2, note: "second" });
  results.record({ index: 1, note: "updated" });
  results.finish("finished");
  assert.equal(results.forget(scope, new Set([1])), 1);
  assert.deepEqual(stored().results.map((item) => item.index), [2]);
  assert.equal(results.get(1), undefined);
  assert.equal(results.get(2).resultRevision, 1);
  assert.equal(results.read({ runId: metadata.runId, afterRevision: 1 }).hasMoreResults, false);
  assert.equal(results.forget(scope, new Set([2]), { memory: false }), 1);
  assert.equal(stored(), null);
  assert.equal(results.get(2).note, "second");
  const previous = results.begin({ ...metadata, runId: "next" }, { reusePrevious: true });
  assert.equal(previous.get(2).note, "second", "保持启动遗忘与旧内存快照的现有次序");
});

test("真实文件落盘失败只回报错误，结果仍可交付并在下次触发时写入", (t) => {
  const { results, clock, errors, stored, dataDir } = fixture(t);
  const runtimePath = path.join(dataDir, "runtime");
  fs.writeFileSync(runtimePath, "blocked");
  results.record({ index: 1, note: "recoverable" });
  clock.advance(30000);
  assert.equal(errors.length, 1);
  assert.equal(results.read().results[0].note, "recoverable");
  fs.unlinkSync(runtimePath);
  results.finish("finished");
  assert.equal(stored().results[0].note, "recoverable");
});

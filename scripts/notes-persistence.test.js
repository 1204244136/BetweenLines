const assert = require("node:assert/strict");
const test = require("node:test");
const { createNotesPersistence } = require("../src/workbenches/translation-compare/notes-persistence");
const { createNotesStorage } = require("../src/workbenches/translation-compare/notes-storage");
const codec = require("lz-string");

const key = "translation-compare-notes-v7:project:rows";

function storageFixture(initial = { [key]: "{}" }) {
  const data = new Map(Object.entries(initial));
  const writes = [];
  return {
    data, writes, writeError: null,
    get length() { return data.size; },
    key(index) { return [...data.keys()][index] ?? null; },
    getItem(name) { return data.get(name) ?? null; },
    setItem(name, raw) {
      if (this.writeError) throw this.writeError;
      writes.push({ key: name, raw: String(raw) });
      data.set(name, String(raw));
    },
    removeItem(name) { data.delete(name); },
  };
}

function schedulerFixture(idle = false) {
  let now = 0;
  let sequence = 0;
  const pending = new Map();
  const scheduled = [];
  const cancelled = [];
  const schedule = (kind, callback, delay) => {
    const id = ++sequence;
    scheduled.push({ id, kind, delay });
    pending.set(id, { callback, at: now + delay });
    return id;
  };
  const scheduler = {
    scheduled, cancelled,
    setTimeout(callback, delay) { return schedule("timeout", callback, delay); },
    clearTimeout(id) { cancelled.push({ kind: "timeout", id }); pending.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...pending]) {
        if (timer.at > now) continue;
        pending.delete(id);
        timer.callback();
      }
    },
  };
  if (idle) {
    scheduler.requestIdleCallback = (callback, options) => schedule("idle", callback, options.timeout);
    scheduler.cancelIdleCallback = (id) => { cancelled.push({ kind: "idle", id }); pending.delete(id); };
  }
  return scheduler;
}

function fixture({ scheduler = schedulerFixture(), storage = storageFixture(), initialBlocked = false } = {}) {
  const notifications = [];
  const classified = [];
  const state = { raw: "{}", serialized: 0 };
  let session;
  session = createNotesPersistence({
    key, storage, initialRaw: storage.getItem(key), initialBlocked, scheduler,
    serialize() { state.serialized += 1; return state.raw; },
    classifyFailure(error) { classified.push(error); return error.kind || "unknown"; },
    onStateChange() { notifications.push(session.snapshot()); },
  });
  return { session, scheduler, storage, notifications, classified, state };
}

test("保存合并以第一次 250ms deadline 为准，并在执行时序列化最新备注", () => {
  const f = fixture();
  assert.deepEqual(f.notifications, [], "constructor 不提前通知尚未初始化的页面");
  f.state.raw = '{"1":{"note":"first"}}';
  f.session.save();
  f.scheduler.advance(200);
  f.state.raw = '{"1":{"note":"latest"}}';
  f.session.save();
  assert.equal(f.scheduler.scheduled.length, 1);
  f.scheduler.advance(49);
  assert.equal(f.storage.writes.length, 0);
  f.scheduler.advance(1);
  assert.equal(f.storage.getItem(key), f.state.raw);
  assert.equal(f.state.serialized, 1);
  assert.equal(f.notifications.length, 1);
  assert.equal(f.session.snapshot().pending, false);
});

test("idle 保存保留首个 2000ms deadline，重复请求不会延后或重复保存", () => {
  const f = fixture({ scheduler: schedulerFixture(true) });
  f.session.save();
  f.scheduler.advance(1500);
  f.state.raw = '{"1":{"note":"idle latest"}}';
  f.session.save();
  assert.deepEqual(f.scheduler.scheduled.map(({ kind, delay }) => ({ kind, delay })), [{ kind: "idle", delay: 2000 }]);
  f.scheduler.advance(499);
  assert.equal(f.state.serialized, 0);
  f.scheduler.advance(1);
  assert.equal(f.state.serialized, 1);
  assert.equal(f.storage.getItem(key), f.state.raw);
});

test("persist 不取消排队保存；immediate 与 flush 取消正确类型且只保存一次", async (t) => {
  const direct = fixture();
  direct.state.raw = '{"1":{}}';
  direct.session.save();
  assert.equal(direct.session.persist(), true);
  assert.equal(direct.session.snapshot().pending, true);
  assert.deepEqual(direct.scheduler.cancelled, []);
  direct.scheduler.advance(250);
  assert.equal(direct.state.serialized, 2, "排队保存仍执行，但相同内容不重复写入");
  assert.equal(direct.storage.writes.length, 1);

  for (const idle of [false, true]) {
    for (const action of ["immediate", "flush"]) {
      await t.test(`${idle ? "idle" : "timeout"} / ${action}`, () => {
        const f = fixture({ scheduler: schedulerFixture(idle) });
        f.state.raw = '{"1":{}}';
        f.session.save();
        if (action === "immediate") f.session.save({ immediate: true }); else f.session.flush();
        assert.equal(f.storage.writes.length, 1);
        assert.deepEqual(f.scheduler.cancelled, [{ kind: idle ? "idle" : "timeout", id: f.scheduler.scheduled[0].id }]);
        f.scheduler.advance(3000);
        assert.equal(f.state.serialized, 1);
        assert.equal(f.session.snapshot().pending, false);
      });
    }
  }
});

test("无 pending 的 flush 不保存或重试之前失败；显式 persist 可以恢复保存", () => {
  const f = fixture();
  f.state.raw = '{"1":{}}';
  f.storage.writeError = Object.assign(new Error("quota"), { kind: "quota" });
  assert.equal(f.session.persist(), false);
  assert.equal(f.session.snapshot().failed, true);
  f.storage.writeError = null;
  f.session.flush();
  assert.equal(f.state.serialized, 1);
  assert.equal(f.notifications.length, 1);
  assert.equal(f.session.snapshot().failed, true);
  assert.equal(f.session.persist(), true);
  assert.equal(f.storage.getItem(key), f.state.raw);
  assert.deepEqual(f.session.snapshot(), { blocked: false, failed: false, failureKind: "", pending: false });
});

test("跨页冲突与初始损坏在 serialize 之前阻挡保存；观察到原基线才解除", () => {
  const f = fixture();
  const other = '{"2":{"note":"other page"}}';
  f.storage.setItem(key, other);
  f.state.raw = '{"1":{"note":"memory"}}';
  assert.equal(f.session.persist(), false);
  assert.equal(f.state.serialized, 0);
  assert.equal(f.storage.getItem(key), other);
  assert.equal(f.session.snapshot().blocked, true);
  f.storage.setItem(key, "{}");
  assert.equal(f.session.persist(), false, "persist 本身不解除已观察到的阻挡");
  f.session.observeStorageChange();
  assert.equal(f.session.snapshot().blocked, false);
  assert.equal(f.session.persist(), true);
  assert.equal(f.storage.getItem(key), f.state.raw);

  const corrupt = fixture({ storage: storageFixture({ [key]: "{broken" }), initialBlocked: true });
  assert.equal(corrupt.session.persist(), false);
  assert.equal(corrupt.state.serialized, 0);
  assert.equal(corrupt.storage.getItem(key), "{broken");
});

test("写入异常原样交给分类器，每次通知；成功重试清除失败类别", () => {
  const f = fixture();
  f.state.raw = '{"1":{}}';
  for (const kind of ["quota", "denied", "unknown"]) {
    const error = Object.assign(new Error(kind), { kind });
    f.storage.writeError = error;
    assert.equal(f.session.persist(), false);
    assert.equal(f.classified.at(-1), error);
    assert.equal(f.notifications.at(-1).failureKind, kind);
    assert.equal(f.storage.getItem(key), "{}");
  }
  f.storage.writeError = null;
  assert.equal(f.session.persist(), true);
  assert.equal(f.notifications.length, 4);
  assert.equal(f.session.snapshot().failureKind, "");
});

test("显式清空按写入→页面回调→认领基线复位；保留 timer 且不新增通知", () => {
  const f = fixture();
  f.state.raw = '{"1":{"note":"unsaved"}}';
  f.session.save();
  f.storage.writeError = Object.assign(new Error("quota"), { kind: "quota" });
  assert.equal(f.session.persist(), false);
  f.storage.writeError = null;
  f.storage.setItem(key, '{"2":{}}');
  f.session.observeStorageChange();
  const before = f.session.snapshot();
  const notified = f.notifications.length;
  f.session.clearCurrent(() => {
    assert.equal(f.storage.getItem(key), "{}", "页面清备注前，空空间已写入");
    assert.deepEqual(f.session.snapshot(), before, "页面回调期间尚未复位保存状态");
    f.state.raw = "{}";
  });
  assert.deepEqual(f.session.snapshot(), { blocked: false, failed: false, failureKind: "", pending: true });
  assert.equal(f.notifications.length, notified);
  assert.deepEqual(f.scheduler.cancelled, []);
  const writes = f.storage.writes.length;
  f.scheduler.advance(250);
  assert.equal(f.storage.writes.length, writes, "排队保存认得清空后的新基线，不重新写入旧内容");
  assert.equal(f.session.snapshot().pending, false);
});

test("显式清空写入失败不调用页面；页面回调失败不认领基线，两者均传播异常", () => {
  const f = fixture();
  f.state.raw = '{"1":{}}';
  f.session.save();
  const before = f.session.snapshot();
  const writeError = new Error("write failed");
  f.storage.writeError = writeError;
  assert.throws(() => f.session.clearCurrent(() => assert.fail("不能清页面")), (error) => error === writeError);
  assert.deepEqual(f.session.snapshot(), before);
  assert.equal(f.classified.length, 0);
  assert.equal(f.notifications.length, 0);

  f.storage.writeError = null;
  const callbackError = new Error("page failed");
  assert.throws(() => f.session.clearCurrent(() => { throw callbackError; }), (error) => error === callbackError);
  assert.deepEqual(f.session.snapshot(), before);
  assert.equal(f.notifications.length, 0);
  assert.deepEqual(f.scheduler.cancelled, []);
  f.scheduler.advance(250);
  assert.equal(f.storage.getItem(key), f.state.raw, "原基线本就是 {}；失败回调未清掉页面内容");

  const distinct = fixture({ storage: storageFixture({ [key]: '{"2":{}}' }) });
  assert.throws(() => distinct.session.clearCurrent(() => { throw callbackError; }), (error) => error === callbackError);
  assert.equal(distinct.session.persist(), false, "失败回调不认领空空间，原基线冲突仍会被保护");
  assert.equal(distinct.state.serialized, 0);
});

test("snapshot 只读且独立，不允许页面改变保存会话状态", () => {
  const f = fixture();
  const before = f.session.snapshot();
  assert.equal(Object.isFrozen(before), true);
  assert.equal(Reflect.set(before, "blocked", true), false);
  f.session.save();
  assert.equal(before.pending, false);
  assert.equal(f.session.snapshot().pending, true);
});

test("真实压缩 adapter 保留逻辑基线，保存和显式清空仅作用当前项目 key", () => {
  const sibling = "translation-compare-notes-v7:other:rows";
  const raw = JSON.stringify({ 1: { note: "保存会话回归。".repeat(1000) } });
  const native = storageFixture({ [key]: "{}", [sibling]: raw });
  const storage = createNotesStorage(native, codec);
  const f = fixture({ storage });
  f.state.raw = raw;
  assert.equal(f.session.persist(), true);
  assert.notEqual(native.getItem(key), raw, "底层存储确实使用了压缩包");
  assert.equal(storage.getItem(key), raw);
  const writes = native.writes.length;
  assert.equal(f.session.persist(), true);
  assert.equal(native.writes.length, writes, "相同逻辑 raw 不因压缩载体重复写入");
  f.session.clearCurrent(() => { f.state.raw = "{}"; });
  assert.equal(storage.getItem(key), "{}");
  assert.equal(native.getItem(sibling), raw, "其他项目保留原始字节，不自动压缩或清理");
});

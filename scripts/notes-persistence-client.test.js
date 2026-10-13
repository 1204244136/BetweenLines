const assert = require("node:assert/strict");
const test = require("node:test");
const { createWorkbench, storageFixture, currentKey } = require("./workbench-fixture");

const stored = (ui) => JSON.parse(ui.run("notesStorage.getItem(storageKey)"));

function idleScheduler() {
  const pending = new Map();
  const cancelled = [];
  let nextId = 0;
  return {
    pending, cancelled,
    requestIdleCallback(callback, options) {
      const id = ++nextId;
      pending.set(id, { callback, options });
      return id;
    },
    cancelIdleCallback(id) {
      cancelled.push(id);
      pending.delete(id);
    },
    fire(id) {
      const task = pending.get(id);
      pending.delete(id);
      task.callback();
    },
  };
}

test("生成页面：合并 250ms 保存，pagehide 写入最新备注并取消原 timer", async () => {
  const ui = createWorkbench(storageFixture({ [currentKey]: "{}" }));
  const metricsVersion = ui.run("notesMetricsVersion");
  ui.run('notes["1"] = { note: "第一版" }; saveNotes(); notes["1"].note = "最新版本"; saveNotes();');
  assert.equal(ui.run("notesMetricsVersion"), metricsVersion + 2, "合并 timer 不省略页面指标失效");
  const scheduled = ui.timeouts.filter((timer) => !timer.cleared && timer.delay === 250);
  assert.equal(scheduled.length, 1);
  assert.deepEqual(stored(ui), {}, "排队期间不提前写入");
  await ui.dispatchWindow("pagehide");
  assert.equal(stored(ui)[1].note, "最新版本");
  assert.equal(stored(ui)[1].rowSig, "sig-1");
  assert.equal(scheduled[0].cleared, true);
  assert.equal(ui.run("notesPersistence.snapshot().pending"), false);
});

test("生成页面：idle 保存采用 2000ms 上限，显式清空保留 timer，隐藏页面收尾最新内容", async () => {
  const idle = idleScheduler();
  const ui = createWorkbench(storageFixture({
    [currentKey]: JSON.stringify({ 1: { note: "旧记录" } }),
  }), { windowData: {
    requestIdleCallback: idle.requestIdleCallback,
    cancelIdleCallback: idle.cancelIdleCallback,
  } });
  ui.run('notes["1"].note = "排队改动"; saveNotes();');
  const firstId = [...idle.pending.keys()][0];
  assert.equal(idle.pending.get(firstId).options.timeout, 2000);
  await ui.element("clearCurrentNotes").dispatch("click");
  assert.deepEqual(stored(ui), {});
  assert.equal(ui.run("Object.keys(notes).length"), 0);
  assert.equal(idle.pending.has(firstId), true, "清空不改变既有排队时序");
  ui.run('notes["2"] = { note: "清空后新记录" }; saveNotes();');
  assert.equal(idle.pending.size, 1);
  idle.fire(firstId);
  assert.equal(stored(ui)[1], undefined, "旧记录不能被 timer 恢复");
  assert.equal(stored(ui)[2].note, "清空后新记录");

  ui.run('notes["2"].note = "隐藏前最新内容"; saveNotes();');
  const secondId = [...idle.pending.keys()][0];
  await ui.dispatchDocument("visibilitychange");
  assert.equal(idle.pending.has(secondId), true, "可见状态不触发 flush");
  ui.run("document.hidden = true");
  await ui.dispatchDocument("visibilitychange");
  assert.deepEqual(idle.cancelled, [secondId]);
  assert.equal(stored(ui)[2].note, "隐藏前最新内容");
  assert.equal(ui.run("notesPersistence.snapshot().pending"), false);
});

test("生成页面：storage 事件阻止跨页覆盖且不补签名，回到原基线后可显式重试", async () => {
  const ui = createWorkbench(storageFixture({ [currentKey]: "{}" }));
  ui.run('notes["1"] = { note: "本页尚未保存" }; saveNotes();');
  const save = ui.timeouts.find((timer) => !timer.cleared && timer.delay === 250);
  const other = JSON.stringify({ 2: { note: "另一页已保存" } });
  ui.storage.setItem(currentKey, other);
  await ui.dispatchWindow("storage", { key: "unrelated-key" });
  assert.equal(ui.run("notesPersistence.snapshot().blocked"), false);
  await ui.dispatchWindow("storage", { key: currentKey });
  assert.equal(ui.run("notesPersistence.snapshot().blocked"), true);
  assert.equal(ui.element("notesSaveWarning").hidden, false);
  save.callback();
  assert.equal(ui.storage.getItem(currentKey), other);
  assert.equal(ui.run('notes["1"].rowSig'), undefined, "冲突先于签名序列化");
  let prevented = false;
  const event = { preventDefault() { prevented = true; } };
  await ui.dispatchWindow("beforeunload", event);
  assert.equal(prevented, true);
  assert.equal(event.returnValue, "");

  ui.storage.setItem(currentKey, "{}");
  await ui.dispatchWindow("storage", { key: null });
  assert.equal(ui.run("notesPersistence.snapshot().blocked"), false);
  assert.deepEqual(stored(ui), {}, "跨页检查不自动保存本页内容");
  await ui.element("retryNotesSave").dispatch("click");
  assert.equal(stored(ui)[1].note, "本页尚未保存");
  assert.match(ui.element("notesPanelStatus").textContent, /本页记录已保存/);
});

test("生成页面：清空写入失败保持内容与排队保存，保存失败只由显式重试恢复", async () => {
  const storage = storageFixture({ [currentKey]: JSON.stringify({ 1: { note: "原记录" } }) });
  const ui = createWorkbench(storage);
  ui.run('notes["1"].note = "待保存版本"; saveNotes();');
  const save = ui.timeouts.find((timer) => !timer.cleared && timer.delay === 250);
  const originalRaw = storage.getItem(currentKey);
  storage.failWrites = true;
  await ui.element("clearCurrentNotes").dispatch("click");
  assert.equal(storage.getItem(currentKey), originalRaw);
  assert.equal(ui.run('notes["1"].note'), "待保存版本");
  assert.equal(ui.run("notesPersistence.snapshot().failed"), false, "清空异常仍由页面处理");
  assert.equal(ui.run("notesPersistence.snapshot().pending"), true);
  assert.match(ui.element("notesPanelStatus").textContent, /清空失败/);
  save.callback();
  assert.equal(ui.run("notesPersistence.snapshot().failed"), true);
  assert.equal(ui.element("notesSaveWarning").hidden, false);
  let prevented = false;
  await ui.dispatchWindow("beforeunload", { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);

  storage.failWrites = false;
  await ui.dispatchWindow("pagehide");
  assert.equal(storage.getItem(currentKey), originalRaw, "无 pending 的 flush 不擅自重试");
  await ui.element("retryNotesSave").dispatch("click");
  assert.equal(stored(ui)[1].note, "待保存版本");
  assert.equal(ui.element("notesSaveWarning").hidden, true);
  prevented = false;
  await ui.dispatchWindow("beforeunload", { preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
});

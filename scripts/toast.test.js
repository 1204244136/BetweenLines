const assert = require("node:assert/strict");
const test = require("node:test");
const { ROWS, projectKey, storageFixture, createWorkbench, toastMessages } = require("./workbench-fixture");

// 服务端一轮 AI 校对的状态响应：客户端据此判断「本页看着它跑起来」再补结束提示。
function aiStatus({ runId = "run-1", running = false, finishedAt = "", stopRequested = false, error = "" } = {}) {
  return {
    ok: true,
    ai: {
      kind: "ai", runId, running, finishedAt, stopRequested, error,
      projectKey, rowsSignature: "rows", total: ROWS.length, queued: 4, modelProcessed: running ? 1 : 4,
      handled: 4, suggested: 1, errors: 0, results: [],
    },
  };
}

test("按钮的一次性回执落在浮动提示上，不再覆盖 AI 固定状态行", async () => {
  const ui = createWorkbench();
  ui.run('setRuntimeStatus("AI 校对中：实际调用 1/4")');
  await ui.element("prefilterConfirm").dispatch("click");
  assert.deepEqual(toastMessages(ui), ["当前筛选结果中没有待确认的预筛通过行。"]);
  assert.equal(ui.run("toasts[0].tone"), "watch");
  assert.equal(ui.element("aiStatus").textContent, "AI 校对中：实际调用 1/4", "固定状态行留给机器任务的持续状态");
});

test("备注面板按钮既写就地状态行，也弹浮动提示", async () => {
  const ui = createWorkbench();
  await ui.element("clearCurrentNotes").dispatch("click");
  assert.match(ui.element("notesPanelStatus").textContent, /本页没有可清空的备注记录/);
  assert.deepEqual(toastMessages(ui), ["本页没有可清空的备注记录。"]);
});

test("行内「未校验」徽标核验后弹提示并解除隔离", async () => {
  const ui = createWorkbench();
  ui.run('notes["1"] = { note: "按行号找回的记录", recoveredUnverified: true, manualDone: false, done: false }');
  await ui.element("tbody").dispatch("click", {
    target: { closest: (selector) => (selector === "[data-verify]" ? { dataset: { verify: "1" } } : null) },
    preventDefault() {},
    stopPropagation() {},
  });
  assert.equal(ui.run('notes["1"].recoveredUnverified'), undefined);
  assert.equal(ui.run('notes["1"].manualDone'), true);
  assert.deepEqual(toastMessages(ui), ["已核验第 1 行的找回记录，并标记为人工确认。"]);
});

test("同一条提示不叠加，超过上限淘汰最旧，也可以手动关闭", async () => {
  const ui = createWorkbench();
  await ui.element("aiBaseUrl").dispatch("input");
  await ui.element("aiBaseUrl").dispatch("input");
  assert.deepEqual(toastMessages(ui), ["地址已修改，可点击刷新获取模型列表。"], "连续同一条提示只保留一条");
  await ui.element("aiBaseUrl").dispatch("change");
  assert.equal(toastMessages(ui).length, 2);
  ui.run('for (let i = 1; i <= 6; i += 1) showToast("提示 " + i);');
  assert.equal(ui.run("toasts.length"), 4);
  assert.equal(ui.element("toastStack").children.length, 4, "被淘汰的提示同时从页面移除");
  assert.deepEqual(toastMessages(ui), ["提示 3", "提示 4", "提示 5", "提示 6"]);
  ui.run("dismissToast(toasts[0].id)");
  assert.equal(ui.element("toastStack").children.length, 3);
  assert.deepEqual(toastMessages(ui), ["提示 4", "提示 5", "提示 6"]);
});

test("一轮跑完后补一次提示，同一轮不重复，也不提示打开页面前就结束的轮次", async () => {
  const finished = aiStatus({ finishedAt: "2026-01-01T00:00:00.000Z" });
  const ui = createWorkbench(storageFixture(), { statusQueue: [aiStatus({ running: true }), finished, finished] });
  await ui.refresh();
  assert.match(ui.element("aiStatus").textContent, /AI 校对中/);
  assert.deepEqual(toastMessages(ui), [], "运行中不弹提示");
  await ui.refresh();
  assert.equal(toastMessages(ui).length, 1);
  assert.match(toastMessages(ui)[0], /AI 校对完成/);
  assert.equal(ui.run("toasts[0].tone"), "success");
  await ui.refresh();
  assert.equal(toastMessages(ui).length, 1, "同一轮只提示一次");

  const late = createWorkbench(storageFixture(), { statusQueue: [finished] });
  await late.refresh();
  assert.match(late.element("aiStatus").textContent, /AI 校对完成/);
  assert.deepEqual(toastMessages(late), [], "打开页面时认领到的历史轮次不弹提示");
});

test("失败轮次的提示报错因而不是统计数字", async () => {
  const failed = aiStatus({ finishedAt: "2026-01-01T00:00:00.000Z", stopRequested: true, error: "AI 接口配置或响应异常，任务已自动终止。" });
  const ui = createWorkbench(storageFixture(), { statusQueue: [aiStatus({ running: true }), failed] });
  await ui.refresh();
  await ui.refresh();
  assert.deepEqual(toastMessages(ui), ["AI 接口配置或响应异常，任务已自动终止。"]);
  assert.equal(ui.run("toasts[0].tone"), "error");
});

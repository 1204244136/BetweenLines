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

test("按钮的一次性回执落在浮动提示上，不再写进任何固定状态行", async () => {
  const ui = createWorkbench();
  await ui.element("prefilterConfirm").dispatch("click");
  assert.deepEqual(toastMessages(ui), ["当前筛选结果中没有待确认的预筛通过行。"]);
  assert.equal(ui.run("toasts[0].tone"), "watch");
  assert.equal(ui.element("aiStatus").textContent, "", "右上角固定状态行已移除，回执只走浮动提示");
});

test("备注面板按钮既写就地状态行，也弹浮动提示", async () => {
  const ui = createWorkbench();
  await ui.element("clearCurrentNotes").dispatch("click");
  assert.match(ui.element("notesPanelStatus").textContent, /本页没有可清空的备注记录/);
  assert.deepEqual(toastMessages(ui), ["本页没有可清空的备注记录。"]);
});

test("行内「未校验」徽标只解锁写回，不把行移出未人工确认筛选", async () => {
  const ui = createWorkbench();
  ui.run('notes["1"] = { note: "修改结果：改写后的译文。", revisionText: "改写后的译文。", revisionTarget: "cn", recoveredUnverified: true, manualDone: false, done: false }; doneMode = "open"; applyFilters({ reset: false });');
  assert.equal(ui.run('filteredRows.some((row) => String(row.index) === "1")'), true);
  await ui.element("tbody").dispatch("click", {
    target: { closest: (selector) => (selector === "[data-verify]" ? { dataset: { verify: "1" } } : null) },
    preventDefault() {},
    stopPropagation() {},
  });
  assert.equal(ui.run('notes["1"].recoveredUnverified'), undefined);
  assert.equal(ui.run('notes["1"].manualDone'), false);
  assert.equal(ui.run('notes["1"].done'), false);
  assert.equal(ui.run('filteredRows.some((row) => String(row.index) === "1")'), true, "解除隔离后仍应留在未人工确认筛选中");
  assert.equal(ui.run('currentRevisionEntries().map((entry) => entry.id).join(",")'), "1", "解除隔离后应进入写回候选集");
  assert.deepEqual(toastMessages(ui), ["已核验第 1 行的找回记录，现在可以写回；尚未标记人工确认。"]);
});

test("同一条提示不叠加，超过上限淘汰最旧，也可以手动关闭", async () => {
  const ui = createWorkbench();
  await ui.element("aiBaseUrl").dispatch("input");
  await ui.element("aiBaseUrl").dispatch("input");
  assert.deepEqual(toastMessages(ui), ["地址已修改，可点击刷新获取模型列表。"], "连续同一条提示只保留一条");
  assert.equal(ui.timeouts.at(-1).delay, 3000, "非错误提示的持续时间按传入时长减半");
  await ui.element("aiBaseUrl").dispatch("change");
  assert.equal(toastMessages(ui).length, 2);
  ui.run('for (let i = 1; i <= 6; i += 1) showToast("提示 " + i);');
  assert.equal(ui.run("toasts.length"), 4);
  assert.equal(ui.element("toastStack").children.length, 8, "被淘汰的提示先进入淡出");
  ui.run('document.getElementById("toastStack").children.slice(0, 4).forEach((node) => node.dispatch("animationend"));');
  assert.equal(ui.element("toastStack").children.length, 4, "淡出结束后移除被淘汰的提示");
  assert.deepEqual(toastMessages(ui), ["提示 3", "提示 4", "提示 5", "提示 6"]);
  ui.run("dismissToast(toasts[0].id)");
  assert.equal(ui.element("toastStack").children.length, 4, "关闭后先保留节点播放淡出");
  assert.equal(ui.timeouts.at(-1).delay, 260, "淡出动画结束后才移除节点");
  ui.run('document.getElementById("toastStack").children[0].dispatch("animationend")');
  assert.equal(ui.element("toastStack").children.length, 3);
  assert.deepEqual(toastMessages(ui), ["提示 4", "提示 5", "提示 6"]);
});

test("一轮跑完后补一次提示，同一轮不重复，也不提示打开页面前就结束的轮次", async () => {
  const finished = aiStatus({ finishedAt: "2026-01-01T00:00:00.000Z" });
  const ui = createWorkbench(storageFixture(), { statusQueue: [aiStatus({ running: true }), finished, finished] });
  await ui.refresh();
  assert.deepEqual(toastMessages(ui), [], "运行中不弹提示");
  await ui.refresh();
  assert.equal(toastMessages(ui).length, 1);
  assert.match(toastMessages(ui)[0], /AI 校对完成/);
  assert.equal(ui.run("toasts[0].tone"), "success");
  await ui.refresh();
  assert.equal(toastMessages(ui).length, 1, "同一轮只提示一次");

  const late = createWorkbench(storageFixture(), { statusQueue: [finished] });
  await late.refresh();
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

test("「确认自动不改」无视当前筛选，直接确认全部 AI 判断不改的行", async () => {
  const ui = createWorkbench();
  ui.run(`
    let lastConfirm = "";
    confirm = (msg) => { lastConfirm = msg; return true; };
    notes["1"] = { note: "[AI校对]\\n语义是否相同：相同\\n是否需要修改：否\\n分析：无需修改。", manualDone: false, done: false };
    notes["2"] = { note: "[AI校对]\\n语义是否相同：相同\\n是否需要修改：否\\n分析：无需修改。", manualDone: false, done: false };
    notes["3"] = { note: "[AI校对]\\n语义是否相同：不同\\n是否需要修改：是\\n修改结果：改写后的译文。\\n分析：需改写。", manualDone: false, done: false };
    query.value = "译文三";
    applyFilters({ reset: false });
  `);
  assert.equal(ui.run("filteredRows.length"), 1, "当前筛选只命中第 3 行");
  assert.equal(ui.run("filteredRows[0].index"), 3);

  await ui.element("acceptAiSame").dispatch("click");

  assert.match(ui.run("lastConfirm"), /将全部 2 条自动不改行标记为人工确认（无视当前筛选）？/);
  assert.equal(ui.run('notes["1"].manualDone'), true, "第 1 行被标记为人工确认");
  assert.equal(ui.run('notes["1"].done'), true);
  assert.equal(ui.run('notes["2"].manualDone'), true, "第 2 行被标记为人工确认");
  assert.equal(ui.run('notes["2"].done'), true);
  assert.equal(ui.run('notes["3"].manualDone'), false, "第 3 行（需修改）不受影响");
  assert.deepEqual(toastMessages(ui), ["已将 2 条自动不改行标记为人工确认。"]);

  await ui.element("acceptAiSame").dispatch("click");
  assert.equal(toastMessages(ui).at(-1), "没有待确认的自动不改行。");
});

test("出错提示不被时长缩放：error 按调用方给的时长原样停留", () => {
  const ui = createWorkbench(storageFixture());
  ui.run('showToast("写回失败：原文件中没有匹配的段落。", { tone: "error", durationMs: 12000 })');
  assert.equal(ui.run("toasts[0].tone"), "error");
  assert.equal(ui.timeouts.at(-1).delay, 12000, "error 不折半，保证用户读得完");
  ui.run('showToast("已写回 3 处修改。", { tone: "success", durationMs: 12000 })');
  assert.equal(ui.timeouts.at(-1).delay, 6000, "其余语气仍按基准时长折半，避免提示堆积");
});

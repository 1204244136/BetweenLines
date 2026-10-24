const test = require("node:test");
const assert = require("node:assert/strict");
const { createWorkbench, storageFixture } = require("./workbench-fixture");

async function settledWorkbench(storage) {
  const ui = createWorkbench(storage, { strictIds: true });
  // 页面初始化会异步刷新 AI 状态；先排空它，再由测试接管连续响应。
  await ui.settle();
  return ui;
}

function renderStatus(ui, done, overrides = {}) {
  ui.run(`renderAiStatus(${JSON.stringify({
    kind: "ai", runId: "hover-run", running: true,
    projectKey: "project", rowsSignature: "rows", results: [],
    total: 40, queued: 40, modelProcessed: done,
    stageMetrics: { stage1Passed: done },
    stagePipelines: {
      stage1: { inFlight: 1, pending: 39 - done, concurrency: 3, concurrencyMax: 6, activeRows: [done + 1] },
    },
    metrics: {
      modelCalls: done, cacheReportedCalls: done,
      cacheReportedPromptTokens: done * 1000, cachedPromptTokens: done * 500,
      cacheMissPromptTokens: done * 500,
    },
    ...overrides,
  })});`);
}

function trackTitleWrites(node) {
  const initialTitle = node.title || "";
  const setAttribute = node.setAttribute.bind(node);
  setAttribute("title", initialTitle);
  let writes = 0;
  node.setAttribute = (name, value) => {
    if (name === "title") writes += 1;
    setAttribute(name, value);
  };
  Object.defineProperty(node, "title", {
    configurable: true,
    // 与浏览器一致：removeAttribute("title") 会同时清空 title 属性。
    get: () => node.getAttribute("title") || "",
    set(value) { node.setAttribute("title", String(value)); },
  });
  return () => writes;
}

test("实时悬停：连续状态刷新保留进度提示，数字与无障碍说明继续更新", async () => {
  const ui = await settledWorkbench();
  renderStatus(ui, 1);
  const progress = ui.element("stage1ProgressWrap");
  const snapshot = progress.title;
  const titleWrites = trackTitleWrites(progress);
  for (let repeat = 0; repeat < 20; repeat += 1) renderStatus(ui, 1);
  assert.equal(titleWrites(), 0, "相同状态回包在未悬停时也不重复写 title");
  await progress.dispatch("mouseenter");

  for (let done = 2; done <= 20; done += 1) {
    renderStatus(ui, done);
    renderStatus(ui, done);
  }

  assert.equal(progress.title, snapshot, "鼠标未离开时显示进入时的说明");
  assert.equal(titleWrites(), 0, "不能重复写原生 title，避免浏览器重启悬停提示");
  assert.equal(progress.getAttribute("aria-valuenow"), "20");
  assert.match(progress.getAttribute("aria-valuetext"), /已初审 20/);
  assert.match(progress.getAttribute("aria-valuetext"), /当前行：21$/);
  assert.equal(Number(ui.element("metricStage1Total").textContent), 20);
  assert.match(ui.element("stage1ProgressText").textContent, /%$/);

  await progress.dispatch("mouseleave");
  assert.match(progress.title, /已完成 20/);
  assert.match(progress.title, /当前行：21$/);
  await progress.dispatch("mouseenter");
  assert.match(progress.title, /当前行：21$/, "再次进入显示最新说明");
});

test("实时悬停：缓存统计聚焦时保留提示，最新 ARIA 不读取冻结的 title", async () => {
  const ui = await settledWorkbench();
  renderStatus(ui, 1);
  const badge = ui.element("aiCacheHitRate");
  const snapshot = badge.title;
  await badge.dispatch("focusin");
  const titleWrites = trackTitleWrites(badge);

  for (let done = 2; done <= 12; done += 1) {
    renderStatus(ui, done, { metrics: {
      modelCalls: done, cacheReportedCalls: done,
      cacheReportedPromptTokens: done * 1000, cachedPromptTokens: (done - 1) * 500,
      cacheMissPromptTokens: done * 1000 - (done - 1) * 500,
    } });
  }

  assert.equal(badge.title, snapshot);
  assert.equal(titleWrites(), 0);
  assert.equal(badge.textContent, "缓存命中: 45.8%");
  assert.match(badge.getAttribute("aria-label"), /缓存读取 5,500 \/ 12,000 token/);
  assert.match(badge.getAttribute("aria-label"), /12 \/ 12 次调用/);
  await badge.dispatch("focusout");
  assert.match(badge.title, /12 \/ 12 次调用/);
});

test("实时悬停：鼠标与键盘焦点重叠时，双方都离开才替换提示", async () => {
  const ui = await settledWorkbench();
  renderStatus(ui, 1);
  const badge = ui.element("aiCacheHitRate");
  const snapshot = badge.title;
  await badge.dispatch("mouseenter");
  await badge.dispatch("focusin");
  renderStatus(ui, 2);
  await badge.dispatch("mouseleave");
  assert.equal(badge.title, snapshot, "焦点仍在元素内时不能解除冻结");
  renderStatus(ui, 3);
  await badge.dispatch("focusout");
  assert.match(badge.title, /3 \/ 3 次调用/);
});

test("实时悬停：焦点移向同一提示元素的子节点时保持冻结", async () => {
  const ui = await settledWorkbench();
  renderStatus(ui, 1);
  const progress = ui.element("stage1ProgressWrap");
  const bar = ui.element("stage1Progress");
  // 最小 DOM 夹具不会解析父子关系，补齐页面中已有的进度容器和条形节点关系。
  progress.append(bar);
  const snapshot = progress.title;
  await progress.dispatch("focusin");
  renderStatus(ui, 2);
  await progress.dispatch("focusout", { relatedTarget: bar });
  assert.equal(progress.title, snapshot, "焦点仍在当前元素内时不得替换说明");
  renderStatus(ui, 3);
  await progress.dispatch("focusout", { relatedTarget: null });
  assert.match(progress.title, /已完成 3/);
});

test("实时悬停：进度隐藏、重置和运行停止立即移除过期行号", async () => {
  for (const reset of [
    "resetStageProgressBars();",
    'renderStageProgress("1", 0, 0, { enabled: false });',
  ]) {
    const ui = await settledWorkbench();
    renderStatus(ui, 1);
    const progress = ui.element("stage1ProgressWrap");
    trackTitleWrites(progress);
    await progress.dispatch("mouseenter");
    renderStatus(ui, 2);
    ui.run(reset);
    assert.equal(progress.hidden, true);
    assert.equal(progress.title || "", "");
    assert.equal(progress.getAttribute("aria-valuetext"), null);
    await progress.dispatch("mouseleave");
    assert.equal(progress.title || "", "", "离开不能恢复隐藏前的说明");
  }

  const ui = await settledWorkbench();
  renderStatus(ui, 1);
  const progress = ui.element("stage1ProgressWrap");
  const runtime = ui.element("stage1RuntimeInfo");
  await progress.dispatch("mouseenter");
  await runtime.dispatch("mouseenter");
  renderStatus(ui, 2, { running: false });
  assert.doesNotMatch(progress.title || "", /当前行/);
  assert.doesNotMatch(progress.getAttribute("aria-valuetext") || "", /当前行/);
  assert.equal(runtime.title || "", "");
  await runtime.dispatch("mouseleave");
  assert.equal(runtime.title || "", "");
});

test("实时悬停：清除记录、切轮及外项目响应立即撤掉旧缓存说明", async () => {
  for (const invalidate of [
    (ui) => ui.run("clearLocalAiCache();"),
    (ui) => ui.run("renderClearedAiStatus();"),
    (ui) => renderStatus(ui, 0, { runId: "next-run", metrics: {} }),
    (ui) => renderStatus(ui, 2, { projectKey: "other" }),
  ]) {
    const ui = await settledWorkbench();
    renderStatus(ui, 1);
    const badge = ui.element("aiCacheHitRate");
    await badge.dispatch("mouseenter");
    renderStatus(ui, 2);
    invalidate(ui);
    assert.equal(badge.textContent, "缓存命中: —");
    assert.doesNotMatch(badge.title || "", /缓存读取 500|1 \/ 1 次调用/);
    assert.doesNotMatch(badge.getAttribute("aria-label") || "", /缓存读取 500|1 \/ 1 次调用/);
    await badge.dispatch("mouseleave");
    assert.doesNotMatch(badge.title || "", /缓存读取 [\d,]+ \/ [\d,]+ token/);
  }

  const ui = await settledWorkbench();
  renderStatus(ui, 1);
  const badge = ui.element("aiCacheHitRate");
  await badge.dispatch("mouseenter");
  renderStatus(ui, 2, { runId: "next-run" });
  assert.match(badge.title, /2 \/ 2 次调用/, "新一轮已有数据时也不能保留上一轮快照");
});

test("实时悬停：换轮或作用域变化立即刷新所有正在查看的动态说明", async () => {
  const ui = await settledWorkbench();
  renderStatus(ui, 1);
  const progress = ui.element("stage1ProgressWrap");
  await progress.dispatch("mouseenter");
  renderStatus(ui, 2);
  assert.match(progress.title, /已完成 1/);
  renderStatus(ui, 0, {
    runId: "next-run",
    stagePipelines: { stage1: { inFlight: 1, pending: 39, concurrency: 3, concurrencyMax: 6, activeRows: [1] } },
  });
  assert.match(progress.title, /已完成 0/);
  assert.match(progress.title, /当前行：1$/);
});

test("实时悬停：预设运行刷新复用条目、悬停锚点与操作按钮", async () => {
  const ui = await settledWorkbench(storageFixture({
    "translation-compare-ai-presets-v2": JSON.stringify([
      { id: "p1", name: "模型甲", model: "model-a", concurrency: 4 },
      { id: "p2", name: "模型乙", model: "model-b", concurrency: 8 },
    ]),
  }));
  ui.run('restoreAiConfig(); stagePresetSelections.stage1 = ["p1"];');
  const pipelines = (inFlight) => ({
    stage1: [{ presetId: "p1", inFlight, quota: 3, configuredConcurrency: 4, pending: 4, activeRows: [inFlight + 1] }],
  });
  renderStatus(ui, 1, { presetPipelines: pipelines(1) });
  const tags = ui.element("stage1PresetTags");
  const tag = tags.children[0];
  const [name, runtime, remove] = tag.children;
  const snapshot = runtime.title;
  await runtime.dispatch("mouseenter");
  renderStatus(ui, 2, { presetPipelines: pipelines(2) });

  assert.ok(tags.children[0] === tag, "运行刷新保留原预设条目");
  assert.ok(tag.children[0] === name, "运行刷新保留名称节点");
  assert.ok(tag.children[1] === runtime, "运行刷新保留悬停锚点");
  assert.ok(tag.children[2] === remove, "运行刷新保留操作按钮");
  assert.match(runtime.textContent, /运行 2/);
  assert.equal(runtime.title, snapshot);
  await runtime.dispatch("mouseleave");
  assert.match(runtime.title, /当前运行 2/);
  await runtime.dispatch("mouseenter");
  renderStatus(ui, 2, {
    running: false,
    presetPipelines: {
      stage1: [{ presetId: "p1", inFlight: 0, quota: 0, configuredConcurrency: 4, pending: 0, activeRows: [] }],
    },
  });
  assert.match(runtime.title, /额定并发上限 4/, "失去运行态立即移除旧行号与运行数字");
  await runtime.dispatch("mouseleave");
  assert.doesNotMatch(runtime.title, /当前行/);

  // 删除按钮必须读取最新列表；复用旧节点不能同时复用过期闭包里的列表。
  ui.run('stagePresetSelections.stage1 = ["p1", "p2"]; renderStagePresetSelection("stage1"); currentAiRunning = false;');
  assert.ok(tags.children[0] === tag, "新增其它预设后仍复用原条目");
  remove.click();
  assert.deepEqual([...ui.run('committedStagePresetIds("stage1")')], ["p2"]);
  assert.equal(tags.children.length, 1);
});

test("实时悬停：运行号切换且新轮仍在运行时，进度与预设说明立即换成新轮", async () => {
  const ui = await settledWorkbench(storageFixture({
    "translation-compare-ai-presets-v2": JSON.stringify([
      { id: "p1", name: "模型甲", model: "model-a", concurrency: 4 },
    ]),
  }));
  ui.run('restoreAiConfig(); stagePresetSelections.stage1 = ["p1"];');
  const stagePipeline = (done, activeRow) => ({
    stage1: { inFlight: 1, pending: 39 - done, concurrency: 3, concurrencyMax: 6, activeRows: [activeRow] },
  });
  const presetPipeline = (inFlight, activeRow) => ({
    stage1: [{ presetId: "p1", inFlight, quota: 3, configuredConcurrency: 4, pending: 4, activeRows: [activeRow] }],
  });
  renderStatus(ui, 1, {
    runId: "run-a",
    stagePipelines: stagePipeline(1, 2),
    presetPipelines: presetPipeline(1, 2),
  });
  const progress = ui.element("stage1ProgressWrap");
  const trigger = ui.element("stage1AppliedTrigger");
  const runtime = ui.element("stage1PresetTags").children[0].children[1];
  await progress.dispatch("mouseenter");
  await trigger.dispatch("mouseenter");
  await runtime.dispatch("mouseenter");
  const oldProgressTitle = progress.title;
  const oldTriggerTitle = trigger.title;
  const oldRuntimeTitle = runtime.title;

  renderStatus(ui, 2, {
    runId: "run-b",
    stagePipelines: stagePipeline(2, 3),
    presetPipelines: presetPipeline(2, 3),
  });

  assert.notEqual(progress.title, oldProgressTitle, "进度提示不能继续显示上一轮");
  assert.match(progress.title, /已完成 2 [\s\S]*当前行：3/);
  assert.notEqual(trigger.title, oldTriggerTitle, "预设入口提示不能继续显示上一轮");
  assert.match(trigger.title, /运行 2/);
  assert.notEqual(runtime.title, oldRuntimeTitle, "预设运行提示不能继续显示上一轮");
  assert.match(runtime.title, /当前运行 2 [\s\S]*当前行：3/);
});

test("实时悬停：停止响应仍带预设运行结构时，清除旧当前行提示", async () => {
  const ui = await settledWorkbench(storageFixture({
    "translation-compare-ai-presets-v2": JSON.stringify([
      { id: "p1", name: "模型甲", model: "model-a", concurrency: 4 },
    ]),
  }));
  ui.run('restoreAiConfig(); stagePresetSelections.stage1 = ["p1"];');
  renderStatus(ui, 1, {
    runId: "run-a",
    stagePipelines: { stage1: { inFlight: 1, pending: 3, concurrency: 3, concurrencyMax: 6, activeRows: [2] } },
    presetPipelines: { stage1: [{ presetId: "p1", inFlight: 1, quota: 3, configuredConcurrency: 4, pending: 3, activeRows: [2] }] },
  });
  const runtime = ui.element("stage1PresetTags").children[0].children[1];
  await runtime.dispatch("mouseenter");

  renderStatus(ui, 1, {
    running: false,
    finishedAt: "2026-10-24T00:00:00.000Z",
    stagePipelines: { stage1: { inFlight: 0, pending: 0, concurrency: 3, concurrencyMax: 6, activeRows: [] } },
    presetPipelines: { stage1: [{ presetId: "p1", inFlight: 0, quota: 3, configuredConcurrency: 4, pending: 0, activeRows: [] }] },
  });

  assert.doesNotMatch(runtime.title || "", /当前行/);
  await runtime.dispatch("mouseleave");
  assert.doesNotMatch(runtime.title || "", /当前行/);
});

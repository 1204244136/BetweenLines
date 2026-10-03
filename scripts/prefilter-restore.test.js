const assert = require("node:assert/strict");
const test = require("node:test");
const { ROWS, storageFixture, createWorkbench, prefilterStatus, prefilterResult } = require("./workbench-fixture");

test("页面重开后从服务端上一轮预筛结果里认领结果集，「确认预筛」不再空锁", async () => {
  // 用户上次已经跑过预筛（第 1、2 行通过规则、第 3 行通过相似度），这次重新打开页面：
  // 服务端仍保留这一轮的全部结果，状态轮询会整轮返回。
  const results = [
    prefilterResult(1),
    prefilterResult(2),
    prefilterResult(3, { status: "similarity-prefilter" }),
  ];
  const ui = createWorkbench(storageFixture({}), {
    statusQueue: [prefilterStatus({ runId: "run-old", results })],
  });
  assert.equal(ui.run("prefilterResultIds.size"), 0, "刚打开时还没有认领");
  await ui.refresh();
  assert.equal(ui.run("prefilterRunId"), "run-old", "必须认领上一轮的运行号");
  assert.equal(ui.run("prefilterResultIds.size"), 3, "上一轮筛过的行必须重新登记");
  assert.equal(ui.run('[...prefilterResultIds].sort().join(",")'), "1,2,3");
  // 已人工确认的行不再进入「待确认」集合，其余仍可一键确认。
  ui.run('notes["1"] = { note: "[规则预筛]", manualDone: true, done: true }; notes["2"] = { note: "[规则预筛]" }; prefilterResultFilterActive = true; applyFilters({ reset: false });');
  const pending = ui.run(`filteredRows.filter((row) => {
    const id = String(row.index);
    return prefilterResultIds.has(id) && prefilterResultKind(row) && !notes[id]?.manualDone && !notes[id]?.recoveredUnverified;
  }).map((row) => row.index).join(",")`);
  assert.equal(pending, "2,3", "已确认的第 1 行必须排除在待确认之外");
});

test("分页返回的预筛结果会一页页累积，不是只留最后一页", async () => {
  const ui = createWorkbench(storageFixture({}), {
    statusQueue: [
      prefilterStatus({ runId: "run-page", results: [prefilterResult(1)], hasMoreResults: true }),
      prefilterStatus({ runId: "run-page", results: [prefilterResult(1), prefilterResult(2)], hasMoreResults: true }),
      prefilterStatus({ runId: "run-page", results: [prefilterResult(1), prefilterResult(2), prefilterResult(3)] }),
    ],
  });
  await ui.refresh();
  assert.equal(ui.run("prefilterResultIds.size"), 1);
  await ui.refresh();
  assert.equal(ui.run("prefilterResultIds.size"), 2);
  await ui.refresh();
  assert.equal(ui.run("prefilterResultIds.size"), 3);
});

test("换一轮新的预筛时结果集整体替换，不混进上一轮的行", async () => {
  const ui = createWorkbench(storageFixture({}), {
    statusQueue: [
      prefilterStatus({ runId: "run-old", results: [prefilterResult(1, { runId: "run-old" }), prefilterResult(2, { runId: "run-old" })] }),
      prefilterStatus({ runId: "run-new", results: [prefilterResult(3, { runId: "run-new" })] }),
    ],
  });
  await ui.refresh();
  assert.equal(ui.run('[...prefilterResultIds].sort().join(",")'), "1,2");
  await ui.refresh();
  assert.equal(ui.run("prefilterRunId"), "run-new");
  assert.equal(ui.run('[...prefilterResultIds].sort().join(",")'), "3");
});

test("非当前项目快照的预筛结果不认领（换了快照就不该复用结果集）", async () => {
  const status = prefilterStatus({ runId: "run-other", results: [prefilterResult(1, { runId: "run-other" })] });
  status.ai.projectKey = "another-project";
  const ui = createWorkbench(storageFixture({}), { statusQueue: [status] });
  await ui.refresh();
  assert.equal(ui.run("prefilterResultIds.size"), 0);
  assert.equal(ui.run("prefilterRunId"), "");
});

test("AI 校对（非预筛）的结果不会被当成预筛结果集", async () => {
  const status = prefilterStatus({ runId: "run-ai", results: [prefilterResult(1, { runId: "run-ai", status: "suggestion" })] });
  status.ai.kind = "proofread";
  const ui = createWorkbench(storageFixture({}), { statusQueue: [status] });
  await ui.refresh();
  assert.equal(ui.run("prefilterResultIds.size"), 0);
  assert.equal(ui.run("prefilterRunId"), "");
  assert.equal(ROWS.length, 3);
});

test("恢复预筛结果后可勾选仅看结果，取消勾选恢复全部行", async () => {
  const ui = createWorkbench(storageFixture({}), {
    statusQueue: [prefilterStatus({ results: [prefilterResult(1), prefilterResult(2)] })],
  });
  const resultFilter = ui.element("prefilterResultFilter");
  const confirmButton = ui.element("prefilterConfirm");
  assert.equal(resultFilter.disabled, true);
  await ui.refresh();
  assert.equal(resultFilter.disabled, false, "认领历史预筛结果后应可筛选");
  assert.equal(resultFilter.checked, false);
  assert.equal(confirmButton.disabled, true, "未限定预筛结果时不能批量确认");

  resultFilter.checked = true;
  await resultFilter.dispatch("change", { target: resultFilter });
  assert.equal(ui.run("prefilterResultFilterActive"), true);
  assert.equal(ui.run('filteredRows.map((row) => row.index).join(",")'), "1,2");
  assert.equal(confirmButton.disabled, false);

  resultFilter.checked = false;
  await resultFilter.dispatch("change", { target: resultFilter });
  assert.equal(ui.run("prefilterResultFilterActive"), false);
  assert.equal(ui.run("filteredRows.length"), ROWS.length);
  assert.equal(confirmButton.disabled, true);
});

test("运行中和结果分页未收齐时锁定确认，完整收齐后开放确认", async () => {
  const ui = createWorkbench(storageFixture({}), {
    statusQueue: [
      prefilterStatus({ running: true, results: [prefilterResult(1)] }),
      prefilterStatus({ results: [prefilterResult(1), prefilterResult(2)], hasMoreResults: true }),
      prefilterStatus({ results: [prefilterResult(1), prefilterResult(2), prefilterResult(3)] }),
    ],
  });
  const resultFilter = ui.element("prefilterResultFilter");
  const confirmButton = ui.element("prefilterConfirm");
  await ui.refresh();
  assert.equal(resultFilter.disabled, false, "运行期间允许查看已返回的结果");
  resultFilter.checked = true;
  await resultFilter.dispatch("change", { target: resultFilter });
  assert.equal(confirmButton.disabled, true, "预筛仍在运行时不能确认");
  await ui.refresh();
  assert.equal(resultFilter.checked, true);
  assert.equal(confirmButton.disabled, true, "运行结束但结果仍在补齐时不能确认");
  await ui.refresh();
  assert.equal(confirmButton.disabled, false, "全部结果收齐后可确认");
});

test("确认预筛只处理搜索范围内的待确认行，排除已确认与需核验记录", async () => {
  const rows = [
    ...ROWS.map((row) => ({ ...row, cn: "范围内译文" + row.index })),
    { index: 4, jp: "原文四", cn: "范围外译文", relation: "1:1", score: 0.9, signature: "sig-4" },
  ];
  const confirmations = [];
  const ui = createWorkbench(storageFixture({}), {
    rows,
    confirm: (message) => { confirmations.push(message); return true; },
    statusQueue: [prefilterStatus({ results: rows.map((row) => prefilterResult(row.index)) })],
  });
  await ui.refresh();
  ui.run('notes["1"].manualDone = true; notes["1"].done = true; notes["2"].recoveredUnverified = true; query.value = "范围内";');
  const resultFilter = ui.element("prefilterResultFilter");
  resultFilter.checked = true;
  await resultFilter.dispatch("change", { target: resultFilter });
  assert.equal(ui.run('currentPrefilterRows().map((row) => row.index).join(",")'), "3");
  await ui.element("prefilterConfirm").dispatch("click");

  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0], /当前预筛结果共 1 条/);
  assert.equal(ui.run('notes["1"].manualDone'), true);
  assert.equal(ui.run('Boolean(notes["2"].manualDone)'), false, "需核验记录必须逐行确认");
  assert.equal(ui.run('notes["2"].recoveredUnverified'), true);
  assert.equal(ui.run('notes["3"].manualDone'), true);
  assert.equal(ui.run('Boolean(notes["4"].manualDone)'), false, "搜索范围外的结果不可被确认");
  assert.equal(ui.element("prefilterConfirm").disabled, true, "当前范围已无待确认结果");
});

test("清除筛选保留预筛结果，清除运行记录则重置并禁用结果控件", async () => {
  const ui = createWorkbench(storageFixture({}), {
    statusQueue: [prefilterStatus({ results: [prefilterResult(1), prefilterResult(2)] })],
  });
  await ui.refresh();
  const resultFilter = ui.element("prefilterResultFilter");
  resultFilter.checked = true;
  await resultFilter.dispatch("change", { target: resultFilter });
  ui.run('query.value = "原文一"; applyFilters();');
  assert.equal(ui.run("filteredRows.length"), 1);
  await ui.element("clearFilter").dispatch("click");
  assert.equal(resultFilter.checked, false);
  assert.equal(resultFilter.disabled, false, "取消筛选后仍可重新查看本轮结果");
  assert.equal(ui.run("prefilterResultIds.size"), 2);
  assert.equal(ui.run("filteredRows.length"), ROWS.length);
  assert.equal(ui.element("prefilterConfirm").disabled, true);

  resultFilter.checked = true;
  await resultFilter.dispatch("change", { target: resultFilter });
  ui.run("renderClearedAiStatus()");
  assert.equal(resultFilter.checked, false);
  assert.equal(resultFilter.disabled, true);
  assert.equal(ui.run("prefilterResultFilterActive"), false);
  assert.equal(ui.run("prefilterResultIds.size"), 0);
  assert.equal(ui.run("prefilterRunId"), "");
  assert.equal(ui.run("prefilterResultsCatchingUp"), false);
  assert.equal(ui.run("filteredRows.length"), ROWS.length);
  assert.equal(ui.element("prefilterConfirm").disabled, true);
  assert.equal(ui.element("prefilterStats").textContent, "尚未运行预筛选。");
});

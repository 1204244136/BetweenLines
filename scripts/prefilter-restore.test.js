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

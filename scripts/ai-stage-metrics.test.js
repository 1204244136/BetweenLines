const test = require("node:test");
const assert = require("node:assert/strict");
const { makeHtml } = require("./build-compare");
const { createWorkbench, storageFixture } = require("./workbench-fixture");
const { createStageMetrics } = require("../src/workbenches/translation-compare/ai/stage-results");

test("build-compare renders visible ai stage metrics dashboard", () => {
  const rows = [{ index: 1, relation: "原文-译文 1:1", jp: "テスト原文", cn: "测试译文", score: 0.9, signature: "sig1" }];
  const selection = {
    comparisonMode: "bilingual",
    inputMode: "txt",
    files: { jp: "A.txt", cn: "B.txt", tw: "" },
    labels: { jp: "A 原文", cn: "B 译文", tw: "C 版本" },
  };
  const html = makeHtml(rows, selection, {
    generatedAt: "2026-01-01T00:00:00.000Z",
    projectKey: "project",
    rowsSignature: "rows",
    notesStorage: { key: "notes" },
  }, "");

  assert.match(html, /<div id="aiStageDashboard" class="ai-stage-dashboard"/);
  assert.match(html, /id="metricStage1Passed"/);
  assert.match(html, /id="metricFastPassHits"/);
  assert.match(html, /id="metricStage2Reviewed"/);
  assert.match(html, /id="metricCritiqueAccept"/);
  assert.match(html, /id="metricCritiqueModify"/);
  assert.match(html, /id="metricCritiqueReject"/);
  assert.match(html, /采纳:\s*<span id="metricCritiqueAccept">/);
  assert.match(html, /调整:\s*<span id="metricCritiqueModify">/);
  assert.match(html, /驳回:\s*<span id="metricCritiqueReject">/);
  assert.match(html, /升级仲裁:\s*<span id="metricCritiqueEscalate">/);
  assert.equal(/调:<span id="metricCritiqueModify">/.test(html), false, "不使用单字缩写「调:」");
  assert.equal(/驳:<span id="metricCritiqueReject">/.test(html), false, "不使用单字缩写「驳:」");
  assert.equal(html.includes('id="metricTotalTokens"'), false, "资源统计卡片已被移除");
  assert.match(html, /id="aiStageFastPassRate"/);
  assert.match(html, /id="stage1StatusPill"/);
  assert.match(html, /id="stage2StatusPill"/);
  assert.match(html, /id="stage3StatusPill"/);
  assert.match(html, /id="stage1ActiveInfo"/);
});

test("client renderAiStatus updates in-page stage dashboard metrics", () => {
  const ui = createWorkbench();

  // Update through ui.run
  ui.run(`
    renderAiStatus({
      kind: "ai",
      running: false,
      finishedAt: "2026-01-01T00:00:00.000Z",
      queued: 10,
      modelProcessed: 10,
      total: 10,
      stageMetrics: {
        stage1Passed: 10,
        fastPassHits: 7,
        stage2Reviewed: 3,
        critiqueAccept: 1,
        critiqueModify: 1,
        critiqueReject: 1,
        critiqueEscalate: 0,
        stage3Arbitrated: 1,
      },
      results: [],
    });
  `);

  const elS1 = ui.element("metricStage1Passed");
  assert.equal(elS1.textContent, 10);

  const elFp = ui.element("metricFastPassHits");
  assert.equal(elFp.textContent, 7);

  const elS2 = ui.element("metricStage2Reviewed");
  assert.equal(elS2.textContent, 3);

  const elCAccept = ui.element("metricCritiqueAccept");
  assert.equal(elCAccept.textContent, 1);

  const elS3 = ui.element("metricStage3Arbitrated");
  assert.equal(elS3.textContent, 1);

  const elRate = ui.element("aiStageFastPassRate");
  assert.equal(elRate.textContent, "快速直通: 70%");
});

test("client renderAiStatus displays multi-stage pipeline flow status and active pills", () => {
  const ui = createWorkbench();

  // Simulate active multi-stage execution
  ui.run(`
    renderAiStatus({
      kind: "ai",
      running: true,
      queued: 273,
      modelProcessed: 69,
      total: 273,
      suggested: 17,
      errors: 1,
      smartConcurrency: true,
      currentConcurrency: 2,
      concurrencyMax: 10,
      stageMetrics: {
        stage1Passed: 51,
        fastPassHits: 51,
        stage2Reviewed: 17,
        critiqueAccept: 0,
        critiqueModify: 17,
        critiqueReject: 0,
        critiqueEscalate: 0,
        stage3Arbitrated: 0,
      },
      stagePipelines: {
        stage1: { inFlight: 2, pending: 150, activeRows: [70, 71] },
        stage2: { inFlight: 1, pending: 2, activeRows: [68] },
        stage3: { inFlight: 0, pending: 0, activeRows: [] },
      },
      results: [],
    });
  `);

  const statusText = ui.element("aiStatus").textContent;
  assert.match(statusText, /AI 校对中（动态并发 2\/10）：实际调用 69\/273，建议 17，错误 1/);
  assert.match(statusText, /S1初审 2在飞 ➔ S2复审 1在飞\(2排队\) ➔ S3仲裁 空闲/);

  // Check stage pills
  const pill1 = ui.element("stage1StatusPill");
  assert.equal(pill1.dataset.state, "running");
  assert.match(pill1.textContent, /2在飞 · 150待审/);

  const pill2 = ui.element("stage2StatusPill");
  assert.equal(pill2.dataset.state, "running");
  assert.match(pill2.textContent, /1在飞 · 2排队/);

  const pill3 = ui.element("stage3StatusPill");
  assert.equal(pill3.dataset.state, "disabled");
  assert.equal(pill3.textContent, "未启用");

  // Check active rows text
  const active1Text = ui.element("stage1ActiveRowsText");
  assert.equal(active1Text.textContent, "70, 71");
  const active2Text = ui.element("stage2ActiveRowsText");
  assert.equal(active2Text.textContent, "68");
});

test("client restores stage metrics from notes on reload without waiting for AI status", () => {
  const currentKey = "translation-compare-notes-v7:project:rows";
  const storage = storageFixture({
    [currentKey]: JSON.stringify({
      1: {
        note: "[规则预筛]\n语义是否相同：相同\n是否需要修改：否\n分析：预筛通过。",
        aiDone: true,
      },
      2: {
        note: "[AI校对]\n语义是否相同：相同\n是否需要修改：否\nGatekeeper初审：无需修改\n分析：原译准确。",
        aiDone: true,
      },
      3: {
        note: "[AI校对]\n语义是否相同：相同\n是否需要修改：是\nGatekeeper初审：建议修改\n初审改案：改案A\nStylist复审[调整]：深化隐喻\n复审改案：改案B\n修改结果：改案B",
        aiDone: true,
      },
      4: {
        note: "[AI校对]\n语义是否相同：相同\n是否需要修改：是\nGatekeeper初审：初审建议\n初审改案：初审案\nStylist复审[提交仲裁]：存在分歧\n复审改案：复审案\nArbiter仲裁[Gatekeeper方案]：采纳初审方案\n仲裁改案：初审案\n修改结果：初审案",
        aiDone: true,
      },
    }),
  });

  const ui = createWorkbench(storage, {
    rows: [
      { index: 1, jp: "A1", cn: "B1", relation: "1:1", score: 0.9, signature: "sig-1" },
      { index: 2, jp: "A2", cn: "B2", relation: "1:1", score: 0.9, signature: "sig-2" },
      { index: 3, jp: "A3", cn: "B3", relation: "1:1", score: 0.9, signature: "sig-3" },
      { index: 4, jp: "A4", cn: "B4", relation: "1:1", score: 0.9, signature: "sig-4" },
    ],
  });

  // 页面刚加载完，在未调用任何 renderAiStatus 之前，各指标就已从 notes 恢复
  assert.equal(ui.element("metricStage1Passed").textContent, 2); // 行1预筛通过 + 行2初审通过
  assert.equal(ui.element("metricFastPassHits").textContent, 2);
  assert.equal(ui.element("aiStageFastPassRate").textContent, "快速直通: 100%");
  assert.equal(ui.element("metricStage2Reviewed").textContent, 2); // 行3调整 + 行4提交仲裁
  assert.equal(ui.element("metricCritiqueModify").textContent, 1);
  assert.equal(ui.element("metricCritiqueEscalate").textContent, 1);
  assert.equal(ui.element("metricStage3Arbitrated").textContent, 1); // 行4仲裁

  // Status pills reflect ready state
  assert.equal(ui.element("stage1StatusPill").dataset.state, "done");
  assert.equal(ui.element("stage1StatusPill").textContent, "就绪");
  assert.equal(ui.element("stage2StatusPill").dataset.state, "done");
  assert.equal(ui.element("stage2StatusPill").textContent, "就绪");
  assert.equal(ui.element("stage3StatusPill").dataset.state, "done");
  assert.equal(ui.element("stage3StatusPill").textContent, "就绪");
});

test("idle AI status with zero stageMetrics does not overwrite restored metrics from notes", () => {
  const currentKey = "translation-compare-notes-v7:project:rows";
  const storage = storageFixture({
    [currentKey]: JSON.stringify({
      1: {
        note: "[AI校对]\n语义是否相同：相同\n是否需要修改：否\nGatekeeper初审：无需修改",
        aiDone: true,
      },
      2: {
        note: "[AI校对]\n语义是否相同：相同\n是否需要修改：是\nGatekeeper初审：建议修改\nStylist复审[采纳]：同意初审\n修改结果：改案",
        aiDone: true,
      },
    }),
  });

  const ui = createWorkbench(storage, {
    rows: [
      { index: 1, jp: "A1", cn: "B1", relation: "1:1", score: 0.9, signature: "sig-1" },
      { index: 2, jp: "A2", cn: "B2", relation: "1:1", score: 0.9, signature: "sig-2" },
    ],
  });

  assert.equal(ui.element("metricStage1Passed").textContent, 1);
  assert.equal(ui.element("metricStage2Reviewed").textContent, 1);
  assert.equal(ui.element("metricCritiqueAccept").textContent, 1);

  // 服务端返回非运行状态且各指标全为 0（如常驻服务刚重启或空闲未跑 AI）
  ui.run(`
    renderAiStatus({
      kind: "ai",
      running: false,
      stageMetrics: {
        stage1Passed: 0,
        fastPassHits: 0,
        stage2Reviewed: 0,
        critiqueAccept: 0,
        critiqueModify: 0,
        critiqueReject: 0,
        critiqueEscalate: 0,
        stage3Arbitrated: 0,
      },
      results: [],
    });
  `);

  // 本地已还原的指标不得被服务端的全 0 冲刷掉
  assert.equal(ui.element("metricStage1Passed").textContent, 1);
  assert.equal(ui.element("metricStage2Reviewed").textContent, 1);
  assert.equal(ui.element("metricCritiqueAccept").textContent, 1);
});

test("recovering notes from historical space restores and updates stage metrics dashboard", async () => {
  const currentKey = "translation-compare-notes-v7:project:rows";
  const historicalKey = "translation-compare-notes-v7:project:rowsPrevious";
  const storage = storageFixture({
    [currentKey]: JSON.stringify({}),
    [historicalKey]: JSON.stringify({
      1: {
        note: "[AI校对]\n语义是否相同：相同\n是否需要修改：否\nGatekeeper初审：无误",
        rowSig: "sig-1",
        manualDone: false,
        aiDone: true,
      },
      2: {
        note: "[AI校对]\n语义是否相同：相同\n是否需要修改：是\nGatekeeper初审：需修饰\n初审改案：初审案\nStylist复审[驳回]：无需修改\nArbiter仲裁[维持原译]：维持原译",
        rowSig: "sig-2",
        manualDone: false,
        aiDone: true,
      },
    }),
  });

  const ui = createWorkbench(storage, {
    rows: [
      { index: 1, jp: "A1", cn: "B1", relation: "1:1", score: 0.9, signature: "sig-1" },
      { index: 2, jp: "A2", cn: "B2", relation: "1:1", score: 0.9, signature: "sig-2" },
    ],
  });

  // 初始本页空间为空，指标为 0
  assert.equal(ui.element("metricStage1Passed").textContent, 0);
  assert.equal(ui.element("metricStage2Reviewed").textContent, 0);
  assert.equal(ui.element("metricStage3Arbitrated").textContent, 0);

  // 在“备注空间与找回”面板中，从历史空间找回记录
  ui.run(`
    const space = notesSpaceInventory.find((s) => s.key === ${JSON.stringify(historicalKey)});
    previewNotesRecovery(space);
  `);
  // 点击“应用找回”
  await ui.element("applyNotesRecovery").dispatch("click");

  // 找回后，阶段指标立刻更新为找回记录的统计
  assert.equal(ui.element("metricStage1Passed").textContent, 1);
  assert.equal(ui.element("metricFastPassHits").textContent, 1);
  assert.equal(ui.element("metricStage2Reviewed").textContent, 1);
  assert.equal(ui.element("metricCritiqueReject").textContent, 1);
  assert.equal(ui.element("metricStage3Arbitrated").textContent, 1);
});

test("clearing current notes space resets stage metrics dashboard to zero", async () => {
  const currentKey = "translation-compare-notes-v7:project:rows";
  const storage = storageFixture({
    [currentKey]: JSON.stringify({
      1: {
        note: "[AI校对]\n语义是否相同：相同\n是否需要修改：否\nGatekeeper初审：无误",
        aiDone: true,
      },
    }),
  });

  const ui = createWorkbench(storage, {
    rows: [
      { index: 1, jp: "A1", cn: "B1", relation: "1:1", score: 0.9, signature: "sig-1" },
    ],
    confirm: () => true, // 确认清空
  });

  assert.equal(ui.element("metricStage1Passed").textContent, 1);

  // 点击清空本页空间
  await ui.element("clearCurrentNotes").dispatch("click");

  // 阶段指标应正确归零
  assert.equal(ui.element("metricStage1Passed").textContent, 0);
  assert.equal(ui.element("metricFastPassHits").textContent, 0);
  assert.equal(ui.element("stage1StatusPill").textContent, "待命");
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { makeHtml } = require("./build-compare");
const { createWorkbench } = require("./workbench-fixture");
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
  assert.match(html, /id="metricCritiqueEscalate"/);
  assert.match(html, /id="metricStage3Arbitrated"/);
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

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createStageMetrics,
  classifyArbitrationWinner,
  computeResultMetricsDelta,
  applyMetricsDelta,
} = require("../src/workbenches/translation-compare/ai/stage-results");
const { createWorkbench, storageFixture } = require("./workbench-fixture");

const doneAfterReview = {
  index: 1,
  status: "ok",
  done: true,
  note: "[AI校对]\n是否需要修改：否",
  stylistReview: { attitude: "reject" },
  critique: { attitude: "reject" },
  stageResult: { stage: "stylist" },
};
const arbitrated = {
  index: 2,
  status: "suggestion",
  done: false,
  note: "[AI校对]\n是否需要修改：是",
  critique: { attitude: "modify" },
  stylistReview: {},
  arbitration: { winner: "融合初审与复审优点" },
  stageResult: { stage: "arbiter", needsEdit: true, revisedText: "x" },
};

test("仲裁胜方归类：结合类优先于初审/复审关键字", () => {
  assert.equal(classifyArbitrationWinner("融合初审与复审优点"), "synthesis");
  assert.equal(classifyArbitrationWinner("combined"), "synthesis");
  assert.equal(classifyArbitrationWinner("gatekeeper"), "gatekeeper");
  assert.equal(classifyArbitrationWinner("stylist"), "stylist");
  assert.equal(classifyArbitrationWinner("维持原译"), "original");
  assert.equal(classifyArbitrationWinner("???"), "other");
});

test("同一行重复写入：先撤销上次贡献，指标与只写一次完全一致", () => {
  const once = createStageMetrics();
  applyMetricsDelta(once, computeResultMetricsDelta(arbitrated), 1);

  const twice = createStageMetrics();
  const d1 = computeResultMetricsDelta(arbitrated);
  applyMetricsDelta(twice, d1, 1);
  applyMetricsDelta(twice, d1, -1);
  applyMetricsDelta(twice, computeResultMetricsDelta(arbitrated), 1);
  assert.deepEqual(twice, once);
});

test("添加后撤销：所有指标回到零，无泄漏", () => {
  for (const result of [doneAfterReview, arbitrated]) {
    const metrics = createStageMetrics();
    const delta = computeResultMetricsDelta(result);
    applyMetricsDelta(metrics, delta, 1);
    applyMetricsDelta(metrics, delta, -1);
    assert.deepEqual(metrics, createStageMetrics());
  }
});

test("done 但经过复审的行不同时计入初审通过与初审提改", () => {
  const metrics = createStageMetrics();
  applyMetricsDelta(metrics, computeResultMetricsDelta(doneAfterReview), 1);
  assert.equal(metrics.stage1Passed + metrics.stage1NeedsEdit + metrics.stage1Unclear, 1);
  assert.equal(metrics.stage1Total, 1);
  assert.equal(metrics.stage1NeedsEdit, 1);
});

test("仲裁行：分歧、仲裁、结合方案各计一次，待仲裁为零", () => {
  const metrics = createStageMetrics();
  applyMetricsDelta(metrics, computeResultMetricsDelta(arbitrated), 1);
  assert.equal(metrics.stage2Diverged, 1);
  assert.equal(metrics.stage3Arbitrated, 1);
  assert.equal(metrics.arbitrationSynthesis, 1);
  assert.equal(metrics.arbitrationGatekeeper, 0);
  assert.equal(metrics.stage3Pending, 0);
});

test("前端：合并服务端异常数不污染本地指标缓存", () => {
  const key = "translation-compare-notes-v7:project:rows";
  const storage = storageFixture({
    [key]: JSON.stringify({
      1: { note: "[AI校对]\n是否需要修改：否\nGatekeeper初审：无需修改", aiDone: true },
    }),
  });
  const ui = createWorkbench(storage, {
    rows: [{ index: 1, jp: "A", cn: "B", relation: "1:1", score: 0.9, signature: "s1" }],
  });
  ui.run(`updateStageMetricsDashboard({ stage1Errors: 5, stage1Passed: 1 }, {}, false)`);
  assert.equal(ui.run("cachedStageMetrics.stage1Errors"), 0, "缓存对象不应被覆盖异常数");
});

test("前端：仲裁胜方为混合文案时归入结合方案", () => {
  const key = "translation-compare-notes-v7:project:rows";
  const storage = storageFixture({
    [key]: JSON.stringify({
      1: {
        note: "[AI校对]\n是否需要修改：是\nGatekeeper初审：需调整\n初审改案：a\nStylist复审[调整]：润色\n复审改案：b\nArbiter仲裁[结合初审与复审方案]：融合\n仲裁改案：c\n修改结果：c",
        aiDone: true,
      },
    }),
  });
  const ui = createWorkbench(storage, {
    rows: [{ index: 1, jp: "A", cn: "B", relation: "1:1", score: 0.9, signature: "s1" }],
  });
  assert.equal(ui.element("metricArbSynthesis").textContent, 1);
  assert.equal(ui.element("metricArbGatekeeper").textContent, 0);
  assert.equal(ui.element("metricArbStylist").textContent, 0);
});

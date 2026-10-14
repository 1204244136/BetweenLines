const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createStageMetrics,
  classifyArbitrationWinner,
  computeResultMetricsDelta,
  applyMetricsDelta,
} = require("../src/workbenches/translation-compare/ai/stage-results");
const { createWorkbench, storageFixture, ROWS } = require("./workbench-fixture");

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

test("前端：快速直通只认备注里的显式标记，不再把所有放行行都算直通", () => {
  const key = "translation-compare-notes-v7:project:rows";
  const storage = storageFixture({
    [key]: JSON.stringify({
      1: { note: "[AI校对]\n是否需要修改：否\n快速直通：是", aiDone: true },
      2: { note: "[AI校对]\n是否需要修改：否", aiDone: true },
    }),
  });
  const ui = createWorkbench(storage, {
    rows: [
      { index: 1, jp: "A", cn: "B", relation: "1:1", score: 0.9, signature: "s1" },
      { index: 2, jp: "C", cn: "D", relation: "1:1", score: 0.9, signature: "s2" },
    ],
  });
  assert.equal(ui.element("metricFastPassHits").textContent, 1);
});

test("前端：失败备注文案带阶段关键字也一律记为阶段一异常", () => {
  const key = "translation-compare-notes-v7:project:rows";
  const storage = storageFixture({
    [key]: JSON.stringify({
      1: { note: "[AI校对]\n调用失败：Arbiter endpoint 404", aiDone: false },
    }),
  });
  const ui = createWorkbench(storage, {
    rows: [{ index: 1, jp: "A", cn: "B", relation: "1:1", score: 0.9, signature: "s1" }],
  });
  assert.equal(ui.run("cachedStageMetrics.stage1Errors"), 1);
  assert.equal(ui.run("cachedStageMetrics.stage3Errors"), 0);
});

test("初审队列耗尽但仍有异常：运行中和结束后均提示待重试，进度包含失败行", () => {
  const ui = createWorkbench(storageFixture(), {
    rows: Array.from({ length: 3078 }, (_, offset) => ({ ...ROWS[0], index: offset + 1, signature: "sig-" + (offset + 1) })),
  });
  for (const running of [true, false]) {
    ui.run(`renderAiStatus({ running: ${running},
      stageCascade: { toStylist: true },
      stageMetrics: { stage1Passed: 1971, stage1NeedsEdit: 1042, stage1Total: 3013, stage1Errors: 65 },
      stagePipelines: { stage1: { pending: 0, inFlight: 0 }, stage2: { inFlight: 1 } }, results: [] });`);
    assert.equal(ui.element("stage1StatusPill").textContent, "异常待重试");
    assert.equal(ui.element("stage1StatusPill").dataset.state, "queued");
    assert.match(ui.element("stage1StatusPill").title, /继续剩下的/);
    assert.equal(ui.element("stage1Progress").style.width, "98%");
    assert.match(ui.element("stage1ProgressWrap").title, /已完成 3013 \/ 共 3078 行.*异常待重试 65 行/);
    assert.equal(ui.element("metricStage1Errors").textContent, 65);
  }
});

test("初审全失败仍显示零进度；少量失败不能被四舍五入为满进度", () => {
  const ui = createWorkbench();
  ui.run("updateStageMetricsDashboard({ stage1Errors: 3 }, {}, false)");
  assert.equal(ui.element("stage1ProgressWrap").hidden, false);
  assert.equal(ui.element("stage1Progress").style.width, "0%");
  assert.match(ui.element("stage1ProgressWrap").title, /已完成 0 \/ 共 3 行/);
  const nearlyDone = createWorkbench(storageFixture(), {
    rows: Array.from({ length: 3014 }, (_, offset) => ({ ...ROWS[0], index: offset + 1, signature: "sig-" + (offset + 1) })),
  });
  nearlyDone.run("updateStageMetricsDashboard({ stage1Passed: 3013, stage1Errors: 1 }, {}, false)");
  assert.equal(nearlyDone.element("stage1Progress").style.width, "99%");
});

test("初审异常续跑显示处理中，成功后的最新备注消除异常和重试提示", () => {
  const key = "translation-compare-notes-v7:project:rows";
  const failure = "[AI校对]\n调用失败：请求超时";
  const ui = createWorkbench(storageFixture({ [key]: JSON.stringify({ 1: { note: failure } }) }), { rows: ROWS.slice(0, 1) });
  assert.equal(ui.element("stage1StatusPill").textContent, "异常待重试");
  ui.run("updateStageMetricsDashboard(null, { stage1: { inFlight: 1, activeRows: [1] } }, true)");
  assert.equal(ui.element("stage1StatusPill").textContent, "处理中");
  ui.run(`notes[1].note += "\\n\\n[AI校对]\\n是否需要修改：否\\nGatekeeper初审：无需修改";
    markNotesDirtyForMetrics(); updateStageMetricsDashboard(null, {}, true);`);
  assert.equal(ui.element("metricStage1Errors").textContent, 0);
  assert.equal(ui.element("stage1StatusPill").textContent, "已完成");
  assert.equal(ui.element("stage1Progress").style.width, "100%");
  assert.equal(ui.element("stage1StatusPill").title || "", "");
});

const initialNote = "[AI校对]\n是否需要修改：是\nGatekeeper初审：建议修改\n初审改案：本轮初审方案";
const disputeNote = initialNote + "\nStylist复审[调整]：语序调整\n复审改案：本轮复审方案";

for (const [stage, failure, success] of [
  ["stage1", "[AI校对]\n调用失败：请求超时", "[AI校对]\n是否需要修改：否\nGatekeeper初审：无需修改"],
  ["stage2", initialNote + "\nStylist复审调用异常：请求超时\n修改结果：本轮初审方案",
    initialNote + "\nStylist复审[采纳]：同意\n复审改案：本轮初审方案\n修改结果：本轮初审方案"],
  ["stage3", disputeNote + "\nArbiter仲裁调用异常：请求超时\n修改结果：本轮复审方案",
    disputeNote + "\nArbiter仲裁[复审方案]：采纳复审\n仲裁改案：本轮复审方案\n修改结果：本轮复审方案"],
]) {
  test(`${stage}：刷新及新任务保留异常，成功后清除；下游失败不作废上游方案`, async () => {
    const key = "translation-compare-notes-v7:project:rows";
    const storage = storageFixture({ [key]: JSON.stringify({ 1: { note: failure } }) });
    const options = { rows: ROWS.slice(0, 1), apiResponses: {
      "/api/ai-proofread/start": { ok: true, ai: { running: true, runId: "retry-run",
        stageMode: stage, stageCascade: { toArbiter: stage === "stage3" }, stageMetrics: createStageMetrics(), results: [] } },
    } };
    for (let reload = 0; reload < 2; reload += 1) {
      const ui = createWorkbench(storage, options);
      const number = stage.slice(-1);
      assert.equal(ui.element(`metricStage${number}Errors`).textContent, 1);
      assert.equal(ui.element(`stage${number}StatusPill`).textContent, "异常待重试");
      assert.match(ui.element(`${stage}ErrorItem`).title, /请求超时：1 行/);
      if (stage !== "stage1") {
        assert.equal(ui.run('isAiFailureNote(notes[1].note)'), false);
        assert.equal(ui.run('parseAutomatedNote(notes[1].note).revision'), stage === "stage2" ? "本轮初审方案" : "本轮复审方案");
        assert.match(ui.run('parseAutomatedNote(notes[1].note).analysis'), /调用异常/);
        assert.equal(ui.run('cachedStageMetrics.stage1NeedsEdit'), 1);
        assert.equal(ui.run('cachedStageMetrics.stage2Reviewed'), stage === "stage3" ? 1 : 0);
      }
      await ui.run(`startAiProofread({ continueOnly: true, stage: ${JSON.stringify(stage)} })`);
      const post = ui.posts.find((item) => item.url === "/api/ai-proofread/start");
      assert.equal(post.body.completedIndexes.includes(1), false);
      assert.equal(post.body.rowNotes[1], failure);
      assert.equal(ui.element(`metricStage${number}Errors`).textContent, 1);
      if (reload === 1) {
        ui.run(`notes[1].note += ${JSON.stringify("\n\n" + success)}; markNotesDirtyForMetrics(); updateStageMetricsDashboard()`);
        assert.equal(ui.element(`metricStage${number}Errors`).textContent, 0);
        assert.doesNotMatch(ui.element(`stage${number}StatusPill`).textContent, /异常/);
        assert.doesNotMatch(ui.element(`${stage}ErrorItem`).title, /请求超时/);
        assert.equal(ui.element(`stage${number}Progress`).style.width, "100%");
      }
    }
  });
}

test("新旧运行的不同失败行按并集统计，同一行异常明细与计数不重复", () => {
  const key = "translation-compare-notes-v7:project:rows";
  const ui = createWorkbench(storageFixture({ [key]: JSON.stringify({
    1: { note: initialNote + "\nStylist复审调用异常：请求超时" },
  }) }));
  ui.run(`updateStageMetricsDashboard({ stage2Errors: 2 }, {}, false, {
    stage2: { network: { count: 2, rows: [1, 2], sample: "连接失败" } }
  })`);
  assert.equal(ui.element("metricStage2Errors").textContent, 2);
  ui.run(`updateStageMetricsDashboard({ stage2Errors: 1 }, {}, false, {
    stage2: { network: { count: 1, rows: [2], sample: "连接失败" } }
  })`);
  assert.equal(ui.element("metricStage2Errors").textContent, 2);
  assert.match(ui.element("stage2ErrorItem").title, /请求超时：1 行/);
  assert.equal(ui.run("cachedStageMetrics.stage2Errors"), 1);
});

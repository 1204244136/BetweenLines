const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeHtml } = require("./build-compare");
const { createWorkbench, storageFixture, toastMessages } = require("./workbench-fixture");
const { createStageMetrics } = require("../src/workbenches/translation-compare/ai/stage-results");

test("工作台构建：渲染可见的 AI 阶段指标看板", () => {
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
  assert.match(html, /id="aiStageSummaryNeedsEdit"/);
  assert.match(html, /id="metricFinalNeedsEdit"/);
  assert.match(html, /id="aiStageSummaryUnchanged"/);
  assert.match(html, /id="metricFinalUnchanged"/);
  assert.match(html, /id="aiStageSummaryNeedsCheck"/);
  assert.match(html, /id="metricFinalNeedsCheck"/);
  assert.match(html, /id="metricStage1Passed"/);
  assert.match(html, /id="metricStage1NeedsEdit"/);
  assert.match(html, /id="metricStage1Total"/);
  assert.match(html, /id="metricFastPassHits"/);
  assert.match(html, /id="metricStage2Reviewed"/);
  assert.match(html, /id="metricStage2Diverged"/);
  assert.match(html, /id="metricCritiqueAccept"/);
  assert.match(html, /id="metricCritiqueModify"/);
  assert.match(html, /id="metricCritiqueReject"/);
  assert.match(html, /采纳:\s*<span id="metricCritiqueAccept">/);
  assert.match(html, /调整:\s*<span id="metricCritiqueModify">/);
  assert.match(html, /驳回:\s*<span id="metricCritiqueReject">/);
  assert.match(html, /升级仲裁:\s*<span id="metricCritiqueEscalate">/);
  assert.match(html, /id="metricStage3Arbitrated"/);
  assert.match(html, /id="metricStage3Settled"/);
  assert.match(html, /id="metricArbGatekeeper"/);
  assert.match(html, /id="metricArbStylist"/);
  assert.match(html, /id="metricArbSynthesis"/);
  assert.match(html, /id="metricArbOriginal"/);
  assert.match(html, /id="metricStage1Errors"/);
  assert.match(html, /id="metricStage2Errors"/);
  assert.match(html, /id="metricStage3Errors"/);
  assert.equal(/调:<span id="metricCritiqueModify">/.test(html), false, "不使用单字缩写「调:」");
  assert.equal(/驳:<span id="metricCritiqueReject">/.test(html), false, "不使用单字缩写「驳:」");
  assert.equal(html.includes('id="metricTotalTokens"'), false, "资源统计卡片已被移除");
  assert.equal(html.includes('id="aiPromptVisible"'), false, "内置提示词复选框已被移除");
  assert.equal(html.includes('id="clearAiLog"'), false, "清除AI记录按钮已被移除");
  assert.match(html, /id="stage1Start"/);
  assert.match(html, /id="stage1Stop"/);
  assert.match(html, /id="stage2Start"/);
  assert.match(html, /id="stage2Stop"/);
  assert.match(html, /id="stage3Start"/);
  assert.match(html, /id="stage3Stop"/);
  assert.match(html, /id="aiStageFastPassRate"/);
  assert.match(html, /id="stage1StatusPill"/);
  assert.match(html, /id="stage2StatusPill"/);
  assert.match(html, /id="stage3StatusPill"/);
  assert.match(html, /id="stage1ActiveInfo"/);
});

test("客户端状态渲染：renderAiStatus 实时更新页面内阶段看板指标", () => {
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

test("客户端状态渲染：renderAiStatus 展示多阶段流水线状态与激活徽标", () => {
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
  assert.match(statusText, /S1初审 2处理中 ➔ S2复审 1处理中\(2排队\) ➔ S3仲裁 空闲/);

  // Check stage pills
  const pill1 = ui.element("stage1StatusPill");
  assert.equal(pill1.dataset.state, "running");
  assert.match(pill1.textContent, /2处理中 · 150待审/);

  const pill2 = ui.element("stage2StatusPill");
  assert.equal(pill2.dataset.state, "running");
  assert.match(pill2.textContent, /1处理中 · 2排队/);

  const pill3 = ui.element("stage3StatusPill");
  assert.equal(pill3.dataset.state, "disabled");
  assert.equal(pill3.textContent, "未启用");

  // Check active rows text
  const active1Text = ui.element("stage1ActiveRowsText");
  assert.equal(active1Text.textContent, "70, 71");
  const active2Text = ui.element("stage2ActiveRowsText");
  assert.equal(active2Text.textContent, "68");
});

test("客户端重新载入时直接从备注中恢复阶段指标，无需等待 AI 状态轮询", () => {
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
  assert.equal(ui.element("metricFinalNeedsEdit").textContent, 2); // 行3与行4最终需修改
  assert.equal(ui.element("metricFinalUnchanged").textContent, 2); // 行1与行2无需修改
  assert.equal(ui.element("metricStage1Passed").textContent, 2); // 行1预筛通过 + 行2初审通过
  assert.equal(ui.element("metricStage1NeedsEdit").textContent, 2); // 行3与行4初审建议修改
  assert.equal(ui.element("metricStage1Total").textContent, 4); // 2 + 2 = 4
  assert.equal(ui.element("metricFastPassHits").textContent, 2);
  assert.equal(ui.element("aiStageFastPassRate").textContent, "快速直通: 100%");
  assert.equal(ui.element("metricStage2Reviewed").textContent, 2); // 行3调整 + 行4提交仲裁
  assert.equal(ui.element("metricStage2Diverged").textContent, 1); // 行4分歧进入仲裁
  assert.equal(ui.element("metricCritiqueModify").textContent, 1);
  assert.equal(ui.element("metricCritiqueEscalate").textContent, 1);
  assert.equal(ui.element("metricStage3Arbitrated").textContent, 1); // 行4仲裁
  assert.equal(ui.element("metricArbGatekeeper").textContent, 1); // 行4仲裁采纳初审方案
  assert.equal(ui.element("metricStage3Settled").textContent, 1);

  // Status pills reflect ready state
  assert.equal(ui.element("stage1StatusPill").dataset.state, "done");
  assert.equal(ui.element("stage1StatusPill").textContent, "就绪");
  assert.equal(ui.element("stage2StatusPill").dataset.state, "done");
  assert.equal(ui.element("stage2StatusPill").textContent, "就绪");
  assert.equal(ui.element("stage3StatusPill").dataset.state, "done");
  assert.equal(ui.element("stage3StatusPill").textContent, "就绪");
});

test("空闲且全为零的 AI 状态不覆盖从备注中恢复的阶段指标", () => {
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

test("从历史空间找回备注时同步恢复并更新阶段指标看板", async () => {
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

test("清空当前备注空间时将阶段指标看板归零重置", async () => {
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

test("阶段一初审通过（无需修改）的内容不计入阶段二文学复审驳回", () => {
  const currentKey = "translation-compare-notes-v7:project:rows";
  const storage = storageFixture({
    [currentKey]: JSON.stringify({
      1: {
        note: "[AI校对]\n语义是否相同：相同\n是否需要修改：否\nGatekeeper初审：原译准确无需修改",
        aiDone: true,
      },
      2: {
        note: "[AI校对]\n语义是否相同：相同\n是否需要修改：否\nGatekeeper初审：原译准确无需修改",
        aiDone: true,
      },
      3: {
        note: "[AI校对]\n语义是否相同：相同\n是否需要修改：是\nGatekeeper初审：建议润色\n初审改案：改案1\nStylist复审[调整]：深化隐喻\n复审改案：改案2\n修改结果：改案2",
        aiDone: true,
      },
    }),
  });

  const ui = createWorkbench(storage, {
    rows: [
      { index: 1, jp: "A1", cn: "B1", relation: "1:1", score: 0.9, signature: "sig-1" },
      { index: 2, jp: "A2", cn: "B2", relation: "1:1", score: 0.9, signature: "sig-2" },
      { index: 3, jp: "A3", cn: "B3", relation: "1:1", score: 0.9, signature: "sig-3" },
    ],
  });

  // 阶段一初审通过 2 行，直通 2 行
  assert.equal(ui.element("metricStage1Passed").textContent, 2);
  assert.equal(ui.element("metricFastPassHits").textContent, 2);
  // 阶段二文学复审只有第 3 行进入复审（调整: 1），驳回必须为 0，严禁将阶段一通过误算为驳回！
  assert.equal(ui.element("metricStage2Reviewed").textContent, 1);
  assert.equal(ui.element("metricCritiqueModify").textContent, 1);
  assert.equal(ui.element("metricCritiqueReject").textContent, 0);
});

test("客户端看板：各阶段调用异常与错误能够对应到对应阶段并渲染", () => {
  const currentKey = "translation-compare-notes-v7:project:rows";
  const storage = storageFixture({
    [currentKey]: JSON.stringify({
      1: {
        note: "[AI校对]\n调用失败：Stage 1 API 500 Server Error",
        aiDone: false,
      },
      2: {
        note: "[AI校对]\nStylist复审调用异常：超时",
        aiDone: false,
      },
      3: {
        note: "[AI校对]\n语义是否相同：相同\n是否需要修改：否\nGatekeeper初审：无误",
        aiDone: true,
      },
    }),
  });

  const ui = createWorkbench(storage, {
    rows: [
      { index: 1, jp: "A1", cn: "B1", relation: "1:1", score: 0.9, signature: "sig-1" },
      { index: 2, jp: "A2", cn: "B2", relation: "1:1", score: 0.9, signature: "sig-2" },
      { index: 3, jp: "A3", cn: "B3", relation: "1:1", score: 0.9, signature: "sig-3" },
    ],
  });

  // 阶段一有 1 次通过，1 次调用失败
  assert.equal(ui.element("metricStage1Passed").textContent, 1);
  assert.equal(ui.element("metricStage1Errors").textContent, 1);
  assert.equal(ui.element("stage1ErrorItem").classList.contains("has-errors"), true);

  // 阶段二有 1 次复审异常
  assert.equal(ui.element("metricStage2Errors").textContent, 1);
  assert.equal(ui.element("stage2ErrorItem").classList.contains("has-errors"), true);

  // 阶段三无异常
  assert.equal(ui.element("metricStage3Errors").textContent, 0);
  assert.equal(ui.element("stage3ErrorItem").classList.contains("has-errors"), false);
});

test("多阶段控制：各个阶段卡片均拥有独立的开始与停止按钮并联动运行状态", async () => {
  const ui = createWorkbench(storageFixture({}), {
    apiResponses: {
      "/api/ai-proofread/start": { ok: true, ai: { running: true, runId: "run-stage", results: [] } },
      "/api/ai-proofread/stop": { ok: true, ai: { running: false, stopRequested: true, runId: "run-stage", results: [] } },
    },
  });

  const s1Start = ui.element("stage1Start");
  const s1Stop = ui.element("stage1Stop");
  const s2Start = ui.element("stage2Start");
  const s2Stop = ui.element("stage2Stop");
  const s3Start = ui.element("stage3Start");
  const s3Stop = ui.element("stage3Stop");

  // 初始空闲状态：开始可用，停止禁用
  assert.equal(s1Start.disabled, false);
  assert.equal(s1Stop.disabled, true);
  assert.equal(s2Start.disabled, false);
  assert.equal(s2Stop.disabled, true);
  assert.equal(s3Start.disabled, false);
  assert.equal(s3Stop.disabled, true);

  // 点击阶段一「开始」
  await s1Start.dispatch("click");
  assert.equal(ui.posts.filter((p) => p.url === "/api/ai-proofread/start").length, 1);

  // 启动后全部开始禁用，全部停止可用
  assert.equal(s1Start.disabled, true);
  assert.equal(s1Stop.disabled, false);
  assert.equal(s2Start.disabled, true);
  assert.equal(s2Stop.disabled, false);
  assert.equal(s3Start.disabled, true);
  assert.equal(s3Stop.disabled, false);

  // 点击阶段二「停止」
  await s2Stop.dispatch("click");
  assert.equal(ui.fetches.filter((u) => u === "/api/ai-proofread/stop").length, 1);
});

test("独立三阶段执行：每个阶段开始按钮传递独立 stage 参数，分别独立执行", async () => {
  const ui = createWorkbench(storageFixture({}), {
    apiResponses: {
      "/api/ai-proofread/start": { ok: true, ai: { running: false, runId: "run-staged", results: [] } },
    },
  });

  // 1. 点击阶段一「开始」
  await ui.element("stage1Start").dispatch("click");
  let lastStartPost = ui.posts.at(-1);
  assert.equal(lastStartPost.url, "/api/ai-proofread/start");
  assert.equal(lastStartPost.body.stage, "stage1", "阶段一启动必须指定 stage=stage1，不自动跑阶段二");

  // 模拟阶段一产出建议行，且阶段二配置了预设
  ui.run(`
    aiIds.stage2Preset.value = "preset-s2";
    notes["1"] = {
      note: "[AI校对]\\n语义是否相同：相同\\n是否需要修改：是\\nGatekeeper初审：建议润色\\n初审改案：改案A\\n修改结果：改案A",
      revisionText: "改案A",
      manualDone: false,
      done: false,
      aiDone: true,
    };
  `);

  // 2. 点击阶段二「开始」
  await ui.element("stage2Start").dispatch("click");
  lastStartPost = ui.posts.at(-1);
  assert.equal(lastStartPost.body.stage, "stage2", "阶段二启动必须指定 stage=stage2，专门复审初审建议行");

  // 模拟阶段二产出分歧行，且阶段三配置了预设
  ui.run(`
    aiIds.stage3Preset.value = "preset-s3";
    notes["1"] = {
      note: "[AI校对]\\n语义是否相同：相同\\n是否需要修改：是\\nGatekeeper初审：建议润色\\n初审改案：改案A\\nStylist复审[提交仲裁]：存在分歧\\n复审改案：改案B\\n修改结果：改案A",
      revisionText: "改案A",
      manualDone: false,
      done: false,
      aiDone: true,
    };
  `);

  // 3. 点击阶段三「开始」
  await ui.element("stage3Start").dispatch("click");
  lastStartPost = ui.posts.at(-1);
  assert.equal(lastStartPost.body.stage, "stage3", "阶段三启动必须指定 stage=stage3，专门仲裁分歧行");
});

test("多阶段审核轨迹：右侧卡片仅保留评审意见与分析，不重复渲染改案文本", () => {
  const currentKey = "translation-compare-notes-v7:project:rows";
  const storage = storageFixture({
    [currentKey]: JSON.stringify({
      1: {
        note: "[AI校对]\n语义是否相同：相同\n是否需要修改：是\nGatekeeper初审：指出事实性硬伤\n初审改案：初审修改文本ABCD\nStylist复审[调整]：深化文学隐喻\n复审改案：复审修改文本EFGH\n修改结果：复审修改文本EFGH",
        revisionText: "复审修改文本EFGH",
        manualDone: false,
        done: false,
        aiDone: true,
      },
    }),
  });

  const ui = createWorkbench(storage, {
    rows: [
      { index: 1, jp: "原文A", cn: "译文B", relation: "1:1", score: 0.8, signature: "sig-1" },
    ],
  });

  const summaryHtml = ui.run('renderNoteSummary(notes["1"], "1")');
  // 右侧审核卡片中包含评审分析意见
  assert.match(summaryHtml, /指出事实性硬伤/);
  assert.match(summaryHtml, /深化文学隐喻/);
  // 但绝不重复打印改案标签（改案文本已在左侧分步演进明细中带 diff 呈现）
  assert.doesNotMatch(summaryHtml, /class="stage-proposal-mini/);
  assert.doesNotMatch(summaryHtml, /初审改案:/);
  assert.doesNotMatch(summaryHtml, /复审改案:/);
});

test("阶段等待与接力：阶段一运行中点击阶段二进入「等待阶段一」，阶段一完成后自动接力", async () => {
  const ui = createWorkbench(storageFixture({}), {
    apiResponses: {
      "/api/ai-proofread/start": { ok: true, ai: { running: true, runId: "run-relay", results: [] } },
    },
    statusQueue: [
      { ok: true, ai: { running: true, runId: "run-relay", results: [] } },
      { ok: true, ai: { running: true, runId: "run-relay", results: [] } },
      { ok: true, ai: { running: true, runId: "run-relay", results: [] } },
      { ok: true, ai: { running: true, runId: "run-relay", results: [] } },
    ],
  });

  // 配置阶段二预设
  ui.run('aiIds.stage2Preset.value = "preset-s2"');

  // 1. 启动阶段一
  await ui.element("stage1Start").dispatch("click");
  assert.equal(ui.run("runningAiStage"), "stage1");
  assert.equal(ui.element("stage1Start").disabled, true);

  // 2. 当前尚无任何修改建议行，点击阶段二「开始」
  await ui.element("stage2Start").dispatch("click");
  // 阶段二应进入等待状态，而不是直接报错
  assert.equal(ui.run("stage2WaitingForStage1"), true, "阶段二进入等待阶段一状态");
  assert.equal(ui.element("stage2StatusPill").textContent, "等待阶段一");
  assert.equal(ui.element("stage2StatusPill").dataset.state, "queued");
  assert.equal(ui.element("stage2Start").disabled, true);
  assert.equal(ui.element("stage2Stop").disabled, false, "等待中阶段的停止按钮应激活可供取消");
  assert.match(toastMessages(ui).join("|"), /等待阶段一产出建议/);

  // 3. 测试点击阶段二「停止」取消排队
  await ui.element("stage2Stop").dispatch("click");
  assert.equal(ui.run("stage2WaitingForStage1"), false, "点击停止取消阶段二排队等待");
  assert.match(toastMessages(ui).join("|"), /已取消阶段二文学复审的排队等待/);
  // 阶段一仍在运行中
  assert.equal(ui.run("currentAiRunning"), true);

  // 4. 再次点击阶段二「开始」重新排队
  await ui.element("stage2Start").dispatch("click");
  assert.equal(ui.run("stage2WaitingForStage1"), true);

  // 5. 模拟阶段一产出修改建议行并完成
  ui.run(`
    notes["1"] = {
      note: "[AI校对]\\n是否需要修改：是\\nGatekeeper初审：建议修改\\n初审改案：新方案",
      manualDone: false,
      done: false,
      aiDone: true,
    };
    renderAiStatus({
      kind: "ai",
      running: false,
      finishedAt: new Date().toISOString(),
      runId: "run-relay",
      results: [],
    });
  `);

  // 阶段一完成后，阶段二应自动解除等待，并准备接力调用
  assert.equal(ui.run("stage2WaitingForStage1"), false);
  assert.match(toastMessages(ui).join("|"), /自动接力启动阶段二/);
});

test("阶段等待与接力：已有建议行时在阶段一运行中点击阶段二依然安全排队，不发起并发启动请求", async () => {
  const ui = createWorkbench(storageFixture({}), {
    apiResponses: {
      "/api/ai-proofread/start": { ok: true, ai: { running: true, runId: "run-relay-2", results: [] } },
    },
    statusQueue: [
      { ok: true, ai: { running: true, runId: "run-relay-2", results: [] } },
      { ok: true, ai: { running: true, runId: "run-relay-2", results: [] } },
      { ok: true, ai: { running: true, runId: "run-relay-2", results: [] } },
    ],
  });

  // 1. 启动阶段一
  await ui.element("stage1Start").dispatch("click");
  assert.equal(ui.run("runningAiStage"), "stage1");
  const postsBefore = ui.posts.filter((p) => p.url === "/api/ai-proofread/start").length;
  assert.equal(postsBefore, 1);

  // 2. 模拟阶段一在运行过程中产出了初审建议行，并配置了阶段二预设
  ui.run(`
    aiIds.stage2Preset.value = "preset-s2";
    notes["1"] = {
      note: "[AI校对]\\n是否需要修改：是\\nGatekeeper初审：建议修改\\n初审改案：新方案",
      manualDone: false,
      done: false,
      aiDone: true,
    };
  `);

  // 3. 虽然 notes 中已有初审建议行，但阶段一仍在运行中，点击阶段二应排队而不是发起并发 start 请求
  await ui.element("stage2Start").dispatch("click");
  assert.equal(ui.run("stage2WaitingForStage1"), true, "必须安全进入排队状态");
  const postsAfter = ui.posts.filter((p) => p.url === "/api/ai-proofread/start").length;
  assert.equal(postsAfter, 1, "绝不发起并发 start 请求");
  assert.match(toastMessages(ui).join("|"), /已有初审建议，等待阶段一全部完成/);
});

test("样式与DOM：活跃行处理中提示在空闲与完成时必须正确隐藏并清空内容，CSS包含[hidden]保护", () => {
  const css = fs.readFileSync(path.resolve(__dirname, "../public/ai-panel.css"), "utf8");
  assert.match(css, /\.ai-stage-active-info\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/, "ai-panel.css 必须包含 .ai-stage-active-info[hidden] 隐藏规则");

  const baseCss = fs.readFileSync(path.resolve(__dirname, "../public/workbench-style.css"), "utf8");
  assert.match(baseCss, /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/, "workbench-style.css 必须包含全局 [hidden] 隐藏规则");

  const ui = createWorkbench(storageFixture({}));
  const active1 = ui.element("stage1ActiveInfo");
  const activeText1 = ui.element("stage1ActiveRowsText");
  assert.equal(active1.hidden, true);
  assert.equal(activeText1.textContent, "");

  // 模拟运行中有活跃行
  ui.run(`
    updateStageMetricsDashboard(null, {
      stage1: { inFlight: 1, pending: 0, activeRows: [5, 6] }
    }, true);
  `);
  assert.equal(active1.hidden, false);
  assert.equal(activeText1.textContent, "5, 6");

  // 模拟运行结束
  ui.run(`
    updateStageMetricsDashboard(null, {
      stage1: { inFlight: 0, pending: 0, activeRows: [] }
    }, false);
  `);
  assert.equal(active1.hidden, true);
  assert.equal(activeText1.textContent, "", "隐藏时清空活跃行文本");
});

test("认知审核流水线指标：数学意义严格闭环与明确流转脉络", () => {
  const ui = createWorkbench();

  // 模拟用户真实场景中的 271 行流转数据
  ui.run(`
    renderAiStatus({
      kind: "ai",
      running: false,
      finishedAt: "2026-01-01T00:00:00.000Z",
      queued: 271,
      total: 271,
      modelProcessed: 64,
      suggested: 62,
      errors: 0,
      stageMetrics: {
        stage1Passed: 208,
        stage1NeedsEdit: 63,
        stage1Total: 271,
        stage1Errors: 0,
        fastPassHits: 207,
        stage2Reviewed: 63,
        stage2Diverged: 42,
        stage2Errors: 0,
        critiqueAccept: 5,
        critiqueModify: 57,
        critiqueReject: 1,
        critiqueEscalate: 0,
        stage3Arbitrated: 42,
        stage3Settled: 42,
        stage3Errors: 0,
        arbitrationGatekeeper: 10,
        arbitrationStylist: 25,
        arbitrationSynthesis: 6,
        arbitrationOriginal: 1,
        finalNeedsEdit: 62,
        finalUnchanged: 209,
        finalNeedsCheck: 0,
        totalAudited: 271,
      },
      results: [],
    });
  `);

  // 1. 全局最终修改结论：明确回答「应该有几条需要改」
  const finalEdit = ui.element("metricFinalNeedsEdit");
  const finalUnchanged = ui.element("metricFinalUnchanged");
  assert.equal(Number(finalEdit.textContent), 62, "明确指出最终建议修改为 62 行");
  assert.equal(Number(finalUnchanged.textContent), 209, "明确指出无需修改为 209 行");
  assert.equal(Number(finalEdit.textContent) + Number(finalUnchanged.textContent), 271, "62 + 209 = 271，总量数学严格闭环");

  // 2. 阶段一事实初审：208 通过 + 63 提改 = 271 总检，63 流入阶段二
  const s1Passed = Number(ui.element("metricStage1Passed").textContent);
  const s1NeedsEdit = Number(ui.element("metricStage1NeedsEdit").textContent);
  const s1Total = Number(ui.element("metricStage1Total").textContent);
  const fpHits = Number(ui.element("metricFastPassHits").textContent);
  assert.equal(s1Passed, 208);
  assert.equal(s1NeedsEdit, 63);
  assert.equal(s1Total, 271);
  assert.equal(fpHits, 207);
  assert.equal(s1Passed + s1NeedsEdit, s1Total, "阶段一：208 通过 + 63 提改 = 271 总检");

  // 3. 阶段二文学复审：承接阶段一的 63 行提改
  const s2Reviewed = Number(ui.element("metricStage2Reviewed").textContent);
  const s2Diverged = Number(ui.element("metricStage2Diverged").textContent);
  const cAccept = Number(ui.element("metricCritiqueAccept").textContent);
  const cModify = Number(ui.element("metricCritiqueModify").textContent);
  const cReject = Number(ui.element("metricCritiqueReject").textContent);
  const cEscalate = Number(ui.element("metricCritiqueEscalate").textContent);
  assert.equal(s2Reviewed, 63, "阶段二复审量精确等于阶段一提改量 (63)");
  assert.equal(cAccept, 5);
  assert.equal(cModify, 57);
  assert.equal(cReject, 1);
  assert.equal(cEscalate, 0);
  assert.equal(cAccept + cModify + cReject + cEscalate, s2Reviewed, "阶段二：5 采纳 + 57 调整 + 1 驳回 + 0 升级 = 63 复审");
  assert.equal(s2Diverged, 42, "阶段二产生 42 行分歧，流入阶段三");

  // 4. 阶段三终审仲裁：承接阶段二的 42 行分歧
  const s3Arbitrated = Number(ui.element("metricStage3Arbitrated").textContent);
  const s3Settled = Number(ui.element("metricStage3Settled").textContent);
  const arbGK = Number(ui.element("metricArbGatekeeper").textContent);
  const arbStylist = Number(ui.element("metricArbStylist").textContent);
  const arbSynth = Number(ui.element("metricArbSynthesis").textContent);
  const arbOrig = Number(ui.element("metricArbOriginal").textContent);
  assert.equal(s3Arbitrated, 42, "阶段三仲裁量精确等于阶段二分歧量 (42)");
  assert.equal(s3Settled, 42);
  assert.equal(arbGK, 10);
  assert.equal(arbStylist, 25);
  assert.equal(arbSynth, 6);
  assert.equal(arbOrig, 1);
  assert.equal(arbGK + arbStylist + arbSynth + arbOrig, s3Arbitrated, "阶段三：10 初审胜 + 25 复审胜 + 6 结合 + 1 维持原译 = 42 仲裁");

  // 5. 快速直通率与状态提示文字
  const rateText = ui.element("aiStageFastPassRate").textContent;
  assert.match(rateText, /快速直通:\s*100%/);
  const rateTitle = ui.element("aiStageFastPassRate").title;
  assert.match(rateTitle, /207\s*行快速直通/);
  assert.match(rateTitle, /271/);
});

test("顶部审核结论指标筛选：点击建议修改/无需修改筛选对应行", async () => {
  const currentKey = "translation-compare-notes-v7:project:rows";
  const storage = storageFixture({
    [currentKey]: JSON.stringify({
      1: {
        note: "[规则预筛]\n是否需要修改：否\n分析：预筛通过。",
        aiDone: true,
      },
      2: {
        note: "[AI校对]\n是否需要修改：否\nGatekeeper初审：无需修改",
        aiDone: true,
      },
      3: {
        note: "[AI校对]\n是否需要修改：是\nGatekeeper初审：建议修改\n修改结果：改案3",
        aiDone: true,
      },
      4: {
        note: "[AI校对]\n是否需要修改：是\nGatekeeper初审：初审建议\nStylist复审[调整]：深化\n修改结果：改案4",
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

  // 初始加载：全部 4 行
  assert.equal(ui.run("filteredRows.length"), 4);

  // 点击「最终建议修改」徽标：筛选出 2 行（行3、行4）
  await ui.element("aiStageSummaryNeedsEdit").dispatch("click");
  assert.equal(ui.run("activeSummaryFilter"), "needsEdit");
  assert.equal(ui.run("filteredRows.length"), 2);
  const editIndices = Array.from(ui.run("filteredRows.map(r => r.index)"));
  assert.deepEqual(editIndices, [3, 4]);

  // 再次点击「最终建议修改」徽标：取消筛选，恢复 4 行
  await ui.element("aiStageSummaryNeedsEdit").dispatch("click");
  assert.equal(ui.run("activeSummaryFilter"), null);
  assert.equal(ui.run("filteredRows.length"), 4);

  // 点击「无需修改」徽标：筛选出 2 行（行1、行2）
  await ui.element("aiStageSummaryUnchanged").dispatch("click");
  assert.equal(ui.run("activeSummaryFilter"), "unchanged");
  assert.equal(ui.run("filteredRows.length"), 2);
  const unchangedIndices = Array.from(ui.run("filteredRows.map(r => r.index)"));
  assert.deepEqual(unchangedIndices, [1, 2]);

  // 再次点击取消筛选
  await ui.element("aiStageSummaryUnchanged").dispatch("click");
  assert.equal(ui.run("activeSummaryFilter"), null);
  assert.equal(ui.run("filteredRows.length"), 4);
});

test("三语语境校对：认知审核阶段指标严格闭环且初审存疑行顺利流入复审排队", async () => {
  const currentKey = "translation-compare-notes-v7:project:rows";
  const storage = storageFixture({
    [currentKey]: JSON.stringify({
      1: {
        note: "[AI校对]\n语义是否相同：相同\n是否需要修改：否\nGatekeeper初审：原译准确无需修改\n分析：目标列与原文贴合。",
        aiDone: true,
      },
      2: {
        note: "[AI校对]\n语义是否相同：相同\n是否需要修改：待人工确认\nGatekeeper初审：存疑转人工\n分析：两份非原文材料各有证据，上下文不足以定论。",
        aiDone: false,
      },
      3: {
        note: "[AI校对]\n语义是否相同：相同\n是否需要修改：是\nGatekeeper初审：建议融入对照列更优片段\n初审改案：融入改案A\nStylist复审[采纳]：同意初审方案\n修改结果：融入改案A",
        aiDone: true,
      },
      4: {
        note: "[AI校对]\n语义是否相同：相同\n是否需要修改：是\nGatekeeper初审：两版本均生硬需调整\n初审改案：初审案B\nStylist复审[调整]：文学润色改案C\n复审改案：复审案C\nArbiter仲裁[结合方案]：融合初审与复审优点\n仲裁改案：定案D\n修改结果：定案D",
        aiDone: true,
      },
    }),
  });

  const ui = createWorkbench(storage, {
    rows: [
      { index: 1, jp: "JP1", cn: "CN1", tw: "TW1", relation: "1:1", score: 0.9, signature: "sig-1" },
      { index: 2, jp: "JP2", cn: "CN2", tw: "TW2", relation: "1:1", score: 0.85, signature: "sig-2" },
      { index: 3, jp: "JP3", cn: "CN3", tw: "TW3", relation: "1:1", score: 0.8, signature: "sig-3" },
      { index: 4, jp: "JP4", cn: "CN4", tw: "TW4", relation: "1:1", score: 0.75, signature: "sig-4" },
    ],
  });

  // 1. 全局最终审核结论指标：严格闭环
  assert.equal(ui.element("metricFinalNeedsEdit").textContent, 2, "行3与行4最终需修改");
  assert.equal(ui.element("metricFinalUnchanged").textContent, 1, "行1无需修改");
  assert.equal(ui.element("metricFinalNeedsCheck").textContent, 1, "行2存疑待人工确认");

  // 2. 阶段一初审指标：存疑独立统计，总检严格闭环
  assert.equal(ui.element("metricStage1Passed").textContent, 1, "行1初审直接通过");
  assert.equal(ui.element("metricFastPassHits").textContent, 1, "行1快速直通");
  assert.equal(ui.element("metricStage1NeedsEdit").textContent, 2, "行3与行4初审建议修改");
  assert.equal(ui.element("metricStage1Unclear").textContent, 1, "行2初审存疑待定");
  assert.equal(ui.element("metricStage1Total").textContent, 4, "初审总检 = 通过1 + 提改2 + 存疑1 = 4");

  // 3. 阶段二文学复审指标：初审存疑行流入待复审排队（提改2 + 存疑1 - 已复审2 = 待复审1）
  assert.equal(ui.element("metricStage2Reviewed").textContent, 2, "行3与行4经历了复审");
  assert.equal(ui.element("metricCritiqueAccept").textContent, 1, "行3采纳");
  assert.equal(ui.element("metricCritiqueModify").textContent, 1, "行4调整");
  assert.equal(ui.element("metricStage2Pending").textContent, 1, "初审存疑行2顺利进入复审排队（待复审1）");
  assert.equal(ui.element("stage2PendingItem").hidden, false, "待复审徽标在有排队时展示");

  // 点击待复审徽标，准确筛选出待复审的行2
  await ui.element("stage2PendingItem").dispatch("click");
  assert.equal(ui.run("activeSummaryFilter"), "stage2Pending");
  assert.equal(ui.run("filteredRows.length"), 1, "准确筛选出待复审行");
  assert.equal(ui.run("filteredRows[0].index"), 2);
  await ui.element("stage2PendingItem").dispatch("click");

  // 4. 阶段三终审仲裁指标
  assert.equal(ui.element("metricStage3Arbitrated").textContent, 1, "行4仲裁");
  assert.equal(ui.element("metricArbSynthesis").textContent, 1, "行4结合方案");

  // 5. 待人工确认指标徽标在有存疑行时可见，并支持点击筛选
  const checkBadge = ui.element("aiStageSummaryNeedsCheck");
  assert.equal(checkBadge.hidden, false, "存在待确认行时待确认徽标必须展示");
  await checkBadge.dispatch("click");
  assert.equal(ui.run("activeSummaryFilter"), "needsCheck");
  assert.equal(ui.run("filteredRows.length"), 1, "准确筛选出 1 行待人工确认");
  assert.equal(ui.run("filteredRows[0].index"), 2);
});

test("三语语境校对：初审存疑经由复审与终审仲裁后，若终审难以定夺才落定为终审待判", async () => {
  const currentKey = "translation-compare-notes-v7:project:rows";
  const storage = storageFixture({
    [currentKey]: JSON.stringify({
      2: {
        note: "[AI校对]\n语义是否相同：相同\n是否需要修改：待人工确认\nGatekeeper初审：存疑待定\nStylist复审[提交仲裁]：两版本均生硬，语境不足需终审法官裁定\nArbiter仲裁[裁决]：经终审研判依据依然不足，建议转人工确认\n分析：两份非原文材料各有证据，上下文不足以定论。",
        aiDone: false,
      },
    }),
  });

  const ui = createWorkbench(storage, {
    rows: [
      { index: 2, jp: "JP2", cn: "CN2", tw: "TW2", relation: "1:1", score: 0.85, signature: "sig-2" },
    ],
  });

  // 全流水线流转完毕：
  assert.equal(ui.element("metricStage1Unclear").textContent, 1, "初审存疑");
  assert.equal(ui.element("metricStage2Reviewed").textContent, 1, "复审已处理该存疑行");
  assert.equal(ui.element("metricCritiqueEscalate").textContent, 1, "复审升级仲裁");
  assert.equal(ui.element("metricStage2Pending").textContent, 0, "复审排队已清零");
  assert.equal(ui.element("metricStage3Arbitrated").textContent, 1, "终审已仲裁");
  assert.equal(ui.element("metricFinalNeedsCheck").textContent, 1, "终审难以定夺，最终沉淀为待人工确认");
});

test("三语语境校对：Stylist 与 Arbiter 正确接收非原文目标列与带隔离防线的对照列语境", () => {
  const { buildStylistMessages, buildArbiterMessages } = require("../src/workbenches/translation-compare/ai/persona-runtime");

  const row = {
    index: 10,
    jp: "それは仕方のないことだ。",
    cn: "那是没办法的事。",
    tw: "那是莫可奈何的事。",
  };

  // 模拟三语校对，用户指定目标列为 tw（台版），对照列为 cn（简中）
  const gatekeeperDecision = {
    needsEdit: true,
    better: "counterpart",
    summary: "建议融入简中更贴合原文的词汇",
    revisedText: "那是莫可奈何的既定事实。",
    score: 85,
  };

  const stylistMessages = buildStylistMessages(row, gatekeeperDecision, {
    targetLabel: "非原文 C（台版）",
    targetText: row.tw,
    counterpartLabel: "非原文 B（简中）",
    counterpartText: row.cn,
    basePrompt: "通用提示词",
  });

  const stylistUserJson = JSON.parse(stylistMessages[1].content.split("\n\n")[0].replace(/^请审阅第 \d+ 行的翻译与初审方案：\n/, ""));
  assert.equal(stylistUserJson.sourceText, row.jp);
  assert.equal(stylistUserJson.targetText, row.tw, "目标文本必须是台版，绝不能取错为简中");
  assert.ok(stylistUserJson.referenceText, "必须提供对照列参考文本");
  assert.equal(stylistUserJson.referenceText.text, row.cn);
  assert.match(stylistUserJson.referenceText.note, /绝对不是修改目标.*严禁将参考文本.*强行搬入/, "必须包含严格的参考文本防污染隔离提示");

  // Arbiter 阶段验证
  const stylistCritique = {
    attitude: "modify",
    rationale: "微调语感",
    revisedText: "那是无可奈何的既定事实。",
  };

  const arbiterMessages = buildArbiterMessages(row, gatekeeperDecision, stylistCritique, {
    targetLabel: "非原文 C（台版）",
    targetText: row.tw,
    counterpartLabel: "非原文 B（简中）",
    counterpartText: row.cn,
    basePrompt: "通用提示词",
  });

  const arbiterUserJson = JSON.parse(arbiterMessages[1].content.split("\n\n")[0].replace(/^请裁决第 \d+ 行的分歧：\n/, ""));
  assert.equal(arbiterUserJson.targetText, row.tw, "Arbiter 目标文本必须是台版");
  assert.ok(arbiterUserJson.referenceText, "Arbiter 必须收到对照列参考文本");
  assert.equal(arbiterUserJson.referenceText.text, row.cn);
  assert.match(arbiterUserJson.referenceText.note, /严禁因为参考文本表述不同而强行引入无关改动/, "Arbiter 必须具备参考文本防偏向防线");
});

test("差异辅助：diffSummary 严格限制片段数量并对大范围差异智能平滑收敛", () => {
  const { diffSummary } = require("../src/workbenches/translation-compare/ai/ai-proofread");
  const labels = { cn: "简中版", tw: "台版" };

  // 1. 正常小差异：保留紧凑差异列表
  const normalDiff = diffSummary("那是没办法的事情。", "那是莫可奈何的事情。", labels);
  assert.match(normalDiff, /简中版 -> 台版简体化/);
  assert.match(normalDiff, /- 没办法/);
  assert.match(normalDiff, /\+ 莫可奈何/);

  // 2. 差异过大或句式完全不同：平滑收敛为高层防杂乱提示，避免输出长篇乱码碎词
  const heavyFrom = "在那个寂静无声的深夜里，少年独自一人静静地凝视着窗外繁星点点的夜空。";
  const heavyTo = "万籁俱寂的午夜时分，他默默站在窗前眺望着漫天星宿闪烁的苍穹宇宙。";
  const heavyDiff = diffSummary(heavyFrom, heavyTo, labels);
  assert.match(heavyDiff, /差异较大（行文与句式各有特色）：仅供理解参考，严禁把参考列的风格差异当成错误/);
  assert.equal(heavyDiff.includes("- "), false, "大范围差异时收敛，不输出杂乱碎词列表");
});

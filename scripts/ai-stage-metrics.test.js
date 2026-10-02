const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeHtml } = require("./build-compare");
const { createWorkbench, storageFixture, toastMessages } = require("./workbench-fixture");
const { createStageMetrics, createStagePipelines } = require("../src/workbenches/translation-compare/ai/stage-results");

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
  // 「级联下游」开关已移除：三个「开始」只表示起点，往下走到哪一段由阶段二/三配没配预设决定。
  assert.equal(html.includes("stageCascadeToggle"), false, "不再有「级联下游」模式开关");
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
        stage1: { inFlight: 2, pending: 150, activeRows: [70, 71], concurrency: 4, concurrencyMax: 32 },
        stage2: { inFlight: 1, pending: 2, activeRows: [68], concurrency: 3, concurrencyMax: 32 },
        stage3: { inFlight: 0, pending: 0, activeRows: [] },
      },
      results: [],
    });
  `);

  // 右上角固定状态行与全局进度条已移除：阶段进度改由每张阶段卡片自己的进度条承载。
  assert.equal(ui.element("aiStatus").textContent, "", "固定状态行已不再被写入");
  assert.equal(ui.element("stage1ProgressWrap").hidden, false, "阶段一进度条可见");
  assert.equal(
    ui.element("stage1ProgressWrap").title,
    "阶段一 事实初审进度：已完成 51 / 共 203 行（25%）",
    "阶段一进度 = 已完成 51 /（已完成 51 + 队列 150待审 + 2处理中）"
  );
  assert.equal(ui.element("stage1Progress").style.width, "25%");
  assert.equal(ui.element("stage2ProgressWrap").hidden, false, "阶段二进度条可见");
  assert.equal(
    ui.element("stage2ProgressWrap").title,
    "阶段二 文学复审进度：已完成 17 / 共 20 行（85%）",
    "阶段二进度 = 已复审 17 /（已完成 17 + 队列 2排队 + 1处理中）"
  );
  assert.equal(ui.element("stage3ProgressWrap").hidden, true, "阶段三未启用时不显示进度条");

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

  // Check active rows text：并发后缀默认只给「实际在飞 / 预设上限」。分子是实际在飞，
  // 分母是面板上的并发上限；控制器上探出来的许可值不进行内（它不会因为队列空了而回落，
  // 拿它当分子就会出现「1 处理中 · 并发 32/32」这种看着自相矛盾的画面），只在悬停里说明。
  // 这里正是「队列不足、实际在飞小于许可值」的场景：2/32 而不是 2/4。
  const active1Text = ui.element("stage1ActiveRowsText");
  assert.equal(active1Text.textContent, "70, 71 · （并发 2/32）");
  assert.match(ui.element("stage1ActiveInfo").title, /实际在飞 2 行；当前允许并发 4，并发上限 32；队列待派发 150 行/);
  const active2Text = ui.element("stage2ActiveRowsText");
  assert.equal(active2Text.textContent, "68 · （并发 1/32）");

  // 跑完后的流水线汇总同样不在状态行重复：阶段卡片上已经有同一组数字。
  // 放在阶段徽标断言之后，避免这一轮渲染把运行态徽标覆盖成 done。
  ui.run(`
    renderAiStatus({
      kind: "ai",
      running: false,
      finishedAt: "2026-01-01T00:00:00.000Z",
      queued: 273,
      modelProcessed: 273,
      total: 273,
      suggested: 17,
      errors: 1,
      stageMetrics: {
        stage1Passed: 51,
        fastPassHits: 51,
        stage1NeedsEdit: 17,
        stage2Reviewed: 17,
        stage3Arbitrated: 0,
      },
      stagePipelines: {
        stage1: { inFlight: 0, pending: 0, activeRows: [] },
        stage2: { inFlight: 0, pending: 0, activeRows: [] },
        stage3: { inFlight: 0, pending: 0, activeRows: [] },
      },
      results: [],
    });
  `);
  // 跑完后阶段卡片自己收口：进度条按各阶段最终总量走满，状态行依旧不被写入。
  assert.equal(ui.element("aiStatus").textContent, "", "固定状态行在任何状态下都不再被写入");
  assert.equal(ui.element("stage1ProgressWrap").title, "阶段一 事实初审进度：已完成 68 / 共 68 行（100%）");
  assert.equal(ui.element("stage2ProgressWrap").title, "阶段二 文学复审进度：已完成 17 / 共 17 行（100%）");
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
        note: "[AI校对]\n语义是否相同：相同\n是否需要修改：否\n快速直通：是\nGatekeeper初审：无需修改\n分析：原译准确。",
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
  assert.equal(ui.element("metricStage2Diverged").textContent, 2); // 行3调整与行4提交仲裁都算复审分歧
  assert.equal(ui.element("metricCritiqueModify").textContent, 1);
  assert.equal(ui.element("metricCritiqueEscalate").textContent, 1);
  assert.equal(ui.element("metricStage3Arbitrated").textContent, 1); // 行4仲裁
  assert.equal(ui.element("metricStage3Pending").textContent, 1); // 行3已分歧但尚未仲裁
  assert.equal(ui.element("stage3PendingItem").hidden, false, "存在未仲裁的分歧行时必须露出「待仲裁」");
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

test("复审分歧与启动弹窗同源：仲裁队列跑空后「分歧」不得塌回「已仲裁数」", async () => {
  const ui = createWorkbench(storageFixture({}), {
    apiResponses: {
      "/api/ai-proofread/start": { ok: true, ai: { running: true, runId: "run-arb", results: [] } },
    },
  });

  // 4 行复审分歧：2 行「调整」+ 1 行「升级仲裁」尚未仲裁，1 行已仲裁定案。
  // 仲裁队列此刻是空的——分歧数只能从备注里读出来，不能靠队列实时计数兜。
  ui.run(`
    aiIds.stage3Preset.value = "preset-s3";
    notes["1"] = {
      note: "[AI校对]\\n语义是否相同：相同\\n是否需要修改：是\\nGatekeeper初审：建议修改硬伤\\n初审改案：初审案1\\nStylist复审[调整]：深化文学隐喻\\n复审改案：复审案1\\n修改结果：复审案1",
      revisionText: "复审案1",
      manualDone: false,
      done: false,
      aiDone: true,
    };
    notes["2"] = {
      note: "[AI校对]\\n语义是否相同：相同\\n是否需要修改：是\\nGatekeeper初审：建议修改硬伤\\n初审改案：初审案2\\nStylist复审[调整]：调整语序\\n复审改案：复审案2\\n修改结果：复审案2",
      revisionText: "复审案2",
      manualDone: false,
      done: false,
      aiDone: true,
    };
    notes["3"] = {
      note: "[AI校对]\\n语义是否相同：相同\\n是否需要修改：是\\nGatekeeper初审：建议修改硬伤\\n初审改案：初审案3\\nStylist复审[提交仲裁]：存在分歧\\n复审改案：复审案3\\n修改结果：初审案3",
      revisionText: "初审案3",
      manualDone: false,
      done: false,
      aiDone: true,
    };
    notes["4"] = {
      note: "[AI校对]\\n语义是否相同：相同\\n是否需要修改：是\\nGatekeeper初审：建议修改硬伤\\n初审改案：初审案4\\nStylist复审[驳回]：原译文意顺畅\\nArbiter仲裁[维持原译]：维持原译\\n修改结果：译文四",
      revisionText: "译文四",
      manualDone: false,
      done: false,
      aiDone: true,
    };
  `);

  ui.run("markNotesDirtyForMetrics(); updateStageMetricsDashboard();");

  // 卡片「分歧」= 复审与初审产生分歧的全部行（含已仲裁与待仲裁），不是「已仲裁数」
  assert.equal(ui.element("metricStage2Diverged").textContent, 4, "分歧 = 已仲裁 1 + 待仲裁 3");
  assert.equal(ui.element("metricStage3Arbitrated").textContent, 1);
  assert.equal(ui.element("metricStage3Pending").textContent, 3, "待仲裁 = 分歧 4 − 已仲裁 1");

  // 「启动 AI 校对」弹窗里的待仲裁行数必须与卡片同源
  await ui.element("stage3Start").dispatch("click");
  assert.equal(ui.element("aiConfirmDialog").open, true, "已有仲裁方案且仍有分歧行时必须弹确认窗");
  assert.match(
    ui.element("aiConfirmMessage").innerHTML,
    /<strong>1<\/strong> 条终审仲裁方案，<strong>3<\/strong> 条分歧行待仲裁/
  );
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
        note: "[AI校对]\n语义是否相同：相同\n是否需要修改：否\n快速直通：是\nGatekeeper初审：无误",
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
        note: "[AI校对]\n语义是否相同：相同\n是否需要修改：否\n快速直通：是\nGatekeeper初审：原译准确无需修改",
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

  // 阶段一初审通过 2 行，只有显式标记的 1 行算快速直通
  assert.equal(ui.element("metricStage1Passed").textContent, 2);
  assert.equal(ui.element("metricFastPassHits").textContent, 1);
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

test("客户端看板：异常悬停提示只给类别与数量，不列行号", () => {
  const currentKey = "translation-compare-notes-v7:project:rows";
  const storage = storageFixture({
    [currentKey]: JSON.stringify({
      1: { note: "[AI校对]\n调用失败：请求超时，网络连接超时或模型响应过慢。", aiDone: false },
      2: { note: "[AI校对]\n调用失败：请求超时，网络连接超时或模型响应过慢。", aiDone: false },
      3: { note: "[AI校对]\n调用失败：请求受限或额度不足（HTTP 429）：遭遇并发频控（Rate Limit）。", aiDone: false },
      4: { note: "[AI校对]\n语义是否相同：相同\n是否需要修改：否\nGatekeeper初审：无误", aiDone: true },
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

  assert.equal(ui.element("metricStage1Errors").textContent, 3);
  const title = ui.element("stage1ErrorItem").title;
  assert.deepEqual(title.split("\n"), [
    "阶段一 事实初审 · 异常 3 行",
    "· 频控限流：1 行",
    "· 请求超时：2 行",
  ], "同类问题合并计数、按固定展示顺序排列，但不列行号、不带代表性错误消息");
});

test("客户端看板：服务端回报的异常分类明细并入悬停提示", () => {
  const ui = createWorkbench(storageFixture({}), {
    rows: [{ index: 7, jp: "A7", cn: "B7", relation: "1:1", score: 0.9, signature: "sig-7" }],
  });

  ui.run(`
    renderAiStatus({
      running: false,
      stageMetrics: { stage3Arbitrated: 1, stage3Errors: 2 },
      stageErrors: {
        stage3: { server_error: { count: 2, rows: [7, 9], sample: "模型服务端异常（HTTP 500）：服务提供方内部发生错误。" } },
      },
      stagePipelines: {},
      results: [],
    });
  `);

  const item = ui.element("stage3ErrorItem");
  assert.equal(ui.element("metricStage3Errors").textContent, 2);
  assert.equal(item.classList.contains("has-errors"), true);
  assert.match(item.title, /^阶段三 终审仲裁 · 异常 2 行/);
  assert.deepEqual(item.title.split("\n"), ["阶段三 终审仲裁 · 异常 2 行", "· 服务端错误：2 行"]);
});

test("客户端看板：异常清零后悬停提示恢复构建器写入的静态说明", () => {
  const ui = createWorkbench(storageFixture({}), {
    rows: [{ index: 1, jp: "A1", cn: "B1", relation: "1:1", score: 0.9, signature: "sig-1" }],
  });

  const item = ui.element("stage1ErrorItem");
  item.title = "阶段一调用失败/异常行数";
  delete item.dataset.defaultTitle; // 夹具已完成空页面初始化；模拟构建器在首次渲染前写入的 title。
  ui.run(`
    renderAiStatus({
      running: false,
      stageMetrics: { stage1Errors: 3 },
      stageErrors: { stage1: { timeout: { count: 3, rows: [1, 2, 3] } } },
      stagePipelines: {},
      results: [],
    });
  `);
  assert.match(item.title, /· 请求超时：3 行/);

  ui.run(`
    renderAiStatus({ running: false, stageMetrics: {}, stageErrors: {}, stagePipelines: {}, results: [] });
  `);
  assert.equal(item.title, "阶段一调用失败/异常行数", "清零后不能残留上一轮的分类明细");
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

  // 启动后各阶段状态独立解耦：阶段一运行中（开始禁用，停止可用）；阶段二与阶段三待命中（开始可用，停止禁用）
  assert.equal(s1Start.disabled, true, "阶段一运行中开始按钮应禁用");
  assert.equal(s1Stop.disabled, false, "阶段一运行中停止按钮应激活");
  assert.equal(s2Start.disabled, false, "阶段二未运行未排队，开始按钮应保持可用，不被强制绑定");
  assert.equal(s2Stop.disabled, true, "阶段二未运行未排队，停止按钮应保持禁用");
  assert.equal(s3Start.disabled, false, "阶段三未运行未排队，开始按钮应保持可用，不被强制绑定");
  assert.equal(s3Stop.disabled, true, "阶段三未运行未排队，停止按钮应保持禁用");

  // 点击阶段一「停止」
  await s1Stop.dispatch("click");
  assert.equal(ui.fetches.filter((u) => u === "/api/ai-proofread/stop").length, 1);
});

test("独立三阶段执行：未启用级联时，每个阶段开始按钮传递独立 stage 参数，分别独立执行", async () => {
  const ui = createWorkbench(storageFixture({}), {
    apiResponses: {
      "/api/ai-proofread/start": { ok: true, ai: { running: false, runId: "run-staged", results: [] } },
    },
  });

  // 1. 点击阶段一「开始」（此时阶段二尚未配置，没有可级联的下游）
  await ui.element("stage1Start").dispatch("click");
  let lastStartPost = ui.posts.at(-1);
  assert.equal(lastStartPost.url, "/api/ai-proofread/start");
  assert.equal(lastStartPost.body.stage, "stage1", "阶段二未配置时阶段一启动只跑初审，不自动跑阶段二");

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

test("阶段二实时计数：复审完但还在仲裁队列里的行必须计入复审与分歧，不能显示成「阶段三抢跑」", () => {
  const ui = createWorkbench();

  // 服务端此刻：阶段二已复审完 5 行（1 行定案 + 4 行移交仲裁），4 行正在仲裁。
  // stageMetrics 只有定案的那 1 行（仲裁中的行要等仲裁结束才 finalize）。
  ui.run(`
    renderAiStatus({
      kind: "ai",
      running: true,
      runId: "run-live",
      queued: 100,
      modelProcessed: 20,
      total: 100,
      stageMetrics: {
        stage1NeedsEdit: 30,
        stage1Total: 100,
        stage2Reviewed: 1,
        critiqueModify: 1,
      },
      stagePipelines: {
        stage1: { inFlight: 10, pending: 50 },
        stage2: { inFlight: 3, pending: 0, reviewed: 5, attitudes: { accept: 0, modify: 5, reject: 0, escalate: 0 } },
        stage3: { inFlight: 4, pending: 0 },
      },
      results: [],
    });
  `);

  assert.equal(ui.element("metricStage2Reviewed").textContent, 5, "复审数取流水线实时计数，不等仲裁定案");
  assert.equal(ui.element("metricCritiqueModify").textContent, 5, "复审立场同样实时");
  assert.equal(ui.element("metricStage2Diverged").textContent, 4, "正在仲裁的 4 行分歧已经成立，必须计入分歧");
  assert.equal(ui.element("metricStage2Pending").textContent, 25, "待复审 = 提改 30 − 已复审 5");
});

test("阶段二实时计数：实时计数未起步时不得把 stageMetrics 已有值拉低，任务结束后回落最终值", () => {
  const ui = createWorkbench();

  // 实时计数还是 0（例如刚启动、或这一轮没走复审），不能把已有的复审数冲成 0。
  ui.run(`
    renderAiStatus({
      kind: "ai",
      running: true,
      runId: "run-live-zero",
      queued: 100,
      modelProcessed: 20,
      total: 100,
      stageMetrics: { stage2Reviewed: 8, critiqueAccept: 8 },
      stagePipelines: { stage2: { inFlight: 0, pending: 0, reviewed: 0 } },
      results: [],
    });
  `);
  assert.equal(ui.element("metricStage2Reviewed").textContent, 8);
  assert.equal(ui.element("metricCritiqueAccept").textContent, 8);

  // 任务结束后流水线已重置：必须回落到 stageMetrics 的最终值，不被残留污染。
  ui.run(`
    renderAiStatus({
      kind: "ai",
      running: false,
      runId: "run-live-zero",
      queued: 100,
      modelProcessed: 100,
      total: 100,
      stageMetrics: { stage1NeedsEdit: 30, stage1Total: 100, stage2Reviewed: 30, stage2Diverged: 4, stage3Arbitrated: 4 },
      stagePipelines: { stage2: { inFlight: 0, pending: 0 }, stage3: { inFlight: 0, pending: 0 } },
      results: [],
    });
  `);
  assert.equal(ui.element("metricStage2Reviewed").textContent, 30);
  assert.equal(ui.element("metricStage2Diverged").textContent, 4);
});

test("阶段流水线契约：保留复审实时计数与立场分布，缺省归零而不是 undefined", () => {
  const pipelines = createStagePipelines({
    stage2: { inFlight: 3, pending: 1, reviewed: 5, attitudes: { accept: 1, modify: 4 } },
  });
  assert.equal(pipelines.stage2.reviewed, 5);
  assert.equal(pipelines.stage2.attitudes.accept, 1);
  assert.equal(pipelines.stage2.attitudes.modify, 4);
  assert.equal(pipelines.stage2.attitudes.reject, 0);
  assert.equal(pipelines.stage2.attitudes.escalate, 0);

  const empty = createStagePipelines();
  assert.equal(empty.stage2.reviewed, 0);
  assert.deepEqual(empty.stage2.attitudes, { accept: 0, modify: 0, reject: 0, escalate: 0 });
  // 非数字与负数一律归一成 0，客户端不用再防一遍。
  const dirty = createStagePipelines({ stage2: { reviewed: -3, attitudes: { accept: "x", modify: -1 } } });
  assert.equal(dirty.stage2.reviewed, 0);
  assert.equal(dirty.stage2.attitudes.accept, 0);
  assert.equal(dirty.stage2.attitudes.modify, 0);
});

test("旧版常驻服务：没有回报 stageCascade 时明确提示重启，并让阶段三显示「未接入」", () => {
  const ui = createWorkbench();

  ui.run('aiIds.stage2Preset.value = "preset-s2"; aiIds.stage3Preset.value = "preset-s3";');
  ui.run(`
    renderAiStatus({
      kind: "ai",
      running: true,
      runId: "run-legacy",
      queued: 10,
      modelProcessed: 1,
      total: 10,
      stageMode: "stage1",
      stagePipelines: {
        stage1: { inFlight: 2, pending: 8 },
        stage2: { inFlight: 0, pending: 0 },
        stage3: { inFlight: 0, pending: 0 },
      },
      results: [],
    });
  `);

  // 旧版服务不回报 stageCascade：级联范围无从得知，必须明说，别让用户对着
  // 「配了阶段三却从来不仲裁」猜原因。
  assert.match(toastMessages(ui).join("|"), /控制台服务未更新/, "缺 stageCascade 时必须提示重启服务");
  assert.equal(ui.element("stage3StatusPill").textContent, "未接入", "配了阶段三却没接入本次流水线时要显式标出");
  assert.match(ui.element("stage3StatusPill").title, /没有接入终审仲裁/);
});

test("旧版常驻服务：提示一轮只发一次，不刷屏", () => {
  const ui = createWorkbench();
  const status = `
    renderAiStatus({
      kind: "ai",
      running: true,
      runId: "run-legacy-once",
      queued: 10,
      modelProcessed: 1,
      total: 10,
      stageMode: "stage1",
      stagePipelines: { stage1: { inFlight: 2, pending: 8 } },
      results: [],
    });
  `;
  ui.run(status);
  ui.run(status);
  ui.run(status);

  const hits = toastMessages(ui).filter((text) => /控制台服务未更新/.test(text));
  assert.equal(hits.length, 1, "同一轮里只提示一次");
});

// 级联回归用的工作台：下游配没配模型由预设决定——只把下拉框 value 设成一个不存在的 id
// 不算「配了阶段二」，取不到预设就等于那一段没启用。
function createCascadeWorkbench(options = {}) {
  const ui = createWorkbench(storageFixture({}), options);
  ui.storage.setItem("translation-compare-ai-presets-v2", JSON.stringify([
    { id: "preset-s2", name: "Gemini 复审", protocol: "compatible", baseUrl: "https://example.invalid/v1", model: "gemini-3.8-flash" },
    { id: "preset-s3", name: "Kimi 仲裁", protocol: "compatible", baseUrl: "https://example.invalid/v1", model: "kimi-k3" },
  ]));
  ui.run("restoreAiConfig()");
  return ui;
}

// 服务端如实回报的「起点 + 级联范围」：客户端所有按钮态与文案都以它为准。
function cascadeStatus(runId, { toStylist = true, toArbiter = true } = {}) {
  return {
    ok: true,
    ai: { kind: "ai", running: true, runId, stageMode: "stage1", stageCascade: { toStylist, toArbiter }, results: [] },
  };
}

test("起点语义：三个「开始」只报起点，往下走到哪一段由下游配置决定", async () => {
  const ui = createCascadeWorkbench({
    apiResponses: {
      "/api/ai-proofread/start": { ok: true, ai: { running: false, runId: "run-origin", results: [] } },
    },
  });

  ui.run('aiIds.stage2Preset.value = "preset-s2"; aiIds.stage3Preset.value = "preset-s3";');
  const fromStage1 = ui.run("cascadeFromStage('stage1')");
  assert.equal(fromStage1.toStylist, true);
  assert.equal(fromStage1.toArbiter, true);
  const fromStage2 = ui.run("cascadeFromStage('stage2')");
  assert.equal(fromStage2.toStylist, false, "从阶段二起步不会再回到阶段二");
  assert.equal(fromStage2.toArbiter, true);
  const fromStage3 = ui.run("cascadeFromStage('stage3')");
  assert.equal(fromStage3.toStylist, false);
  assert.equal(fromStage3.toArbiter, false, "阶段三是尽头，没有下游");

  // 前端只报起点，级联由服务端按「下游配没配模型」决定。
  await ui.element("stage1Start").dispatch("click");
  assert.equal(ui.posts.at(-1).body.stage, "stage1");

  // 只配阶段二时，从阶段二起步也不会再往下走。
  ui.run('aiIds.stage3Preset.value = "";');
  const soloStage2 = ui.run("cascadeFromStage('stage2')");
  assert.equal(soloStage2.toStylist, false);
  assert.equal(soloStage2.toArbiter, false);
  const soloStage1 = ui.run("cascadeFromStage('stage1')");
  assert.equal(soloStage1.toStylist, true);
  assert.equal(soloStage1.toArbiter, false, "没配仲裁就不该报会走到仲裁");
});

test("起点语义：级联运行中三个「开始」全禁用、三个「停止」全可用（停的是同一条流水线）", async () => {
  const runningAi = cascadeStatus("run-cascade");
  const ui = createCascadeWorkbench({
    apiResponses: { "/api/ai-proofread/start": runningAi },
    statusQueue: [runningAi, runningAi, runningAi, runningAi],
  });

  ui.run('aiIds.stage2Preset.value = "preset-s2"; aiIds.stage3Preset.value = "preset-s3";');
  await ui.element("stage1Start").dispatch("click");
  // 启动后紧接着的状态轮询是异步的：先把它抽干，避免它把本地状态冲掉。
  for (let step = 0; step < 24; step += 1) await Promise.resolve();

  assert.equal(ui.run("runningAiStage"), "stage1", "起点仍是阶段一");
  const live = ui.run("currentStageCascade");
  assert.equal(live.toStylist, true, "级联范围以服务端回报为准");
  assert.equal(live.toArbiter, true);

  assert.equal(ui.element("stage1Start").disabled, true);
  assert.equal(ui.element("stage2Start").disabled, true);
  assert.equal(ui.element("stage3Start").disabled, true);
  assert.equal(ui.element("stage1Stop").disabled, false);
  assert.equal(ui.element("stage2Stop").disabled, false, "级联中任意停止按钮停的都是整条流水线，不能出现停不掉的死角");
  assert.equal(ui.element("stage3Stop").disabled, false);
});

test("起点语义：当前流水线已覆盖下游时，点阶段二/三只提示已包含，不再排队", async () => {
  const runningAi = cascadeStatus("run-cascade-live");
  const ui = createCascadeWorkbench({
    apiResponses: { "/api/ai-proofread/start": runningAi },
    statusQueue: [runningAi, runningAi, runningAi, runningAi],
  });

  ui.run('aiIds.stage2Preset.value = "preset-s2"; aiIds.stage3Preset.value = "preset-s3";');
  await ui.element("stage1Start").dispatch("click");
  for (let step = 0; step < 24; step += 1) await Promise.resolve();
  const postsBefore = ui.posts.filter((p) => p.url === "/api/ai-proofread/start").length;

  await ui.element("stage2Start").dispatch("click");
  assert.equal(ui.run("stage2WaitingForStage1"), false, "已覆盖时不再退回排队等待");
  assert.match(toastMessages(ui).join("|"), /阶段二已包含在当前流水线中/);

  await ui.element("stage3Start").dispatch("click");
  assert.equal(ui.run("stage3WaitingForStage2"), false);
  assert.match(toastMessages(ui).join("|"), /阶段三已包含在当前流水线中/);

  assert.equal(ui.posts.filter((p) => p.url === "/api/ai-proofread/start").length, postsBefore, "绝不发起并发的 start 请求");
});

test("起点语义：流水线跑完直接回报收尾，不走排队接力", async () => {
  const runningAi = cascadeStatus("run-cascade-done");
  const ui = createCascadeWorkbench({
    apiResponses: { "/api/ai-proofread/start": runningAi },
    statusQueue: [runningAi, runningAi, runningAi, runningAi],
  });

  ui.run('aiIds.stage2Preset.value = "preset-s2"; aiIds.stage3Preset.value = "preset-s3";');
  await ui.element("stage1Start").dispatch("click");
  for (let step = 0; step < 24; step += 1) await Promise.resolve();

  ui.run(`
    renderAiStatus({
      kind: "ai",
      running: false,
      stopRequested: false,
      finishedAt: new Date().toISOString(),
      runId: "run-cascade-done",
      stageMode: "stage1",
      stageCascade: { toStylist: true, toArbiter: true },
      results: [],
    });
  `);

  assert.equal(ui.run("runningAiStage"), null);
  const after = ui.run("currentStageCascade");
  assert.equal(after.toStylist, false, "任务结束后级联范围必须清零");
  assert.equal(after.toArbiter, false);
  assert.match(toastMessages(ui).join("|"), /流水线已完成：初审 → 复审 → 仲裁/);
});

test("起点语义：页面刷新后按服务端回报的起点与级联范围恢复按钮态", async () => {
  const ui = createWorkbench(storageFixture({}), {
    apiResponses: {
      "/api/ai-proofread/start": { ok: true, ai: { running: false, runId: "run-idle", results: [] } },
    },
  });

  // 模拟刷新：本地 runningAiStage 与级联范围都丢了，只剩服务端回报的这一份。
  assert.equal(ui.run("runningAiStage"), null);
  ui.run(`
    renderAiStatus({
      kind: "ai",
      running: true,
      runId: "run-cascade-restored",
      stageMode: "stage1",
      stageCascade: { toStylist: true, toArbiter: false },
      results: [],
    });
  `);

  assert.equal(ui.run("runningAiStage"), "stage1");
  const restored = ui.run("currentStageCascade");
  assert.equal(restored.toStylist, true);
  assert.equal(restored.toArbiter, false);
  assert.equal(ui.element("stage2Start").disabled, true, "恢复级联态后阶段二开始按钮必须禁用");
  assert.equal(ui.element("stage3Stop").disabled, false, "级联态下任意停止按钮都可用（停的是整条流水线）");
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

test("样式：阶段卡片的预设下拉按内容取宽，不再被固定上限截断", () => {
  const css = fs.readFileSync(path.resolve(__dirname, "../public/ai-panel.css"), "utf8");

  function ruleBody(selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = css.match(new RegExp(escaped + "\\s*\\{([^}]*)\\}"));
    assert.ok(match, `ai-panel.css 必须包含 ${selector} 规则`);
    // 注释里出现的属性名不算声明：只对剥掉注释后的正文做断言。
    return match[1].replace(/\/\*[\s\S]*?\*\//g, "");
  }

  // 预设标签是「供应商 / 预设名 · 模型」三段拼接（ai-presets.js 的 presetLabel）：
  // 固定宽度上限会把三个阶段的下拉截成同一段开头，用户分不清各自选了哪个预设。
  const combobox = ruleBody(".ai-stage-card-head .select-combobox");
  assert.match(combobox, /max-width:\s*none/, "预设下拉不得再有固定宽度上限");
  assert.doesNotMatch(combobox, /max-width:\s*\d+px/, "预设下拉不得回落到固定 px 上限");
  assert.match(combobox, /flex:\s*0\s+1\s+auto/, "预设下拉要能吃掉卡片头部标题右侧的空白");

  // 控件组必须可压缩，否则「标题 + 全宽下拉」在窄卡片里会顶破卡片边界。
  const ctrls = ruleBody(".ai-stage-card-ctrls");
  assert.match(ctrls, /flex:\s*0\s+1\s+auto/);
  assert.doesNotMatch(ctrls, /flex-shrink:\s*0/, "控件组整块不压缩会把下拉按回窄宽度");

  // 压缩顺序固定为「下拉先省略」：标题单行完整，开始/停止按钮不被挤变形。
  assert.match(ruleBody(".ai-stage-card-title-row"), /flex:\s*0\s+0\s+auto/);
  assert.match(ruleBody(".ai-stage-card-actions"), /flex:\s*0\s+0\s+auto/);
  // 原生 select 已换成 .select-combobox + .select-trigger，隐藏载体上不该再留宽度上限。
  assert.doesNotMatch(ruleBody(".ai-stage-preset-select"), /max-width:\s*\d+px/);
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

test("「待终审」独立成账：没走到终审的存疑行不混进「待人工确认」", async () => {
  const currentKey = "translation-compare-notes-v7:project:rows";
  const storage = storageFixture({
    [currentKey]: JSON.stringify({
      1: {
        // 初审存疑、复审采纳却没给出可用改案：没经过终审，按口径落「待终审」。
        note: "[AI校对]\n语义是否相同：不同\n是否需要修改：待终审\nGatekeeper初审：初审存疑，复审没能给出可用结论\nStylist复审[采纳]：同意初审判断，但手里没有可用改案\n分析：存疑未解除，等待终审定案。",
        aiDone: false,
      },
      2: {
        // 走到终审、终审仍定不了 → 才是「待人工确认」。
        note: "[AI校对]\n语义是否相同：相同\n是否需要修改：待人工确认\nGatekeeper初审：存疑待定\nStylist复审[提交仲裁]：依据不足\nArbiter仲裁[存疑待定]：终审也无法定案\n分析：终审定案为待人工确认。",
        aiDone: false,
      },
    }),
  });

  const ui = createWorkbench(storage, {
    rows: [
      { index: 1, jp: "JP1", cn: "CN1", tw: "TW1", relation: "1:1", score: 0.9, signature: "sig-1" },
      { index: 2, jp: "JP2", cn: "CN2", tw: "TW2", relation: "1:1", score: 0.85, signature: "sig-2" },
    ],
  });

  assert.equal(ui.element("metricFinalPendingArbiter").textContent, 1, "行1没走到终审，计入待终审");
  assert.equal(ui.element("metricFinalNeedsCheck").textContent, 1, "只有终审定案的行2算待人工确认");
  assert.equal(ui.element("aiStageSummaryPendingArbiter").hidden, false, "待终审徽章在有行时展示");

  // 轨迹：行1显示「待终审」，不能再声称「终审定案为待人工确认」。
  const html1 = ui.run('renderNoteSummary(notes["1"], "1")');
  assert.match(html1, /待终审/);
  assert.doesNotMatch(html1, /待人工确认/);
  const html2 = ui.run('renderNoteSummary(notes["2"], "2")');
  assert.match(html2, /待人工确认/);
  assert.doesNotMatch(html2, /待终审/);

  // 两个徽章各筛各的，不互相吞并。
  await ui.element("aiStageSummaryPendingArbiter").dispatch("click");
  assert.equal(ui.run("activeSummaryFilter"), "pendingArbiter");
  assert.equal(ui.run("filteredRows.length"), 1);
  assert.equal(ui.run("filteredRows[0].index"), 1);
  await ui.element("aiStageSummaryPendingArbiter").dispatch("click");

  await ui.element("aiStageSummaryNeedsCheck").dispatch("click");
  assert.equal(ui.run("activeSummaryFilter"), "needsCheck");
  assert.equal(ui.run("filteredRows.length"), 1);
  assert.equal(ui.run("filteredRows[0].index"), 2);
});

test("三语语境校对：认知审核阶段指标严格闭环且初审存疑行顺利流入复审排队", async () => {
  const currentKey = "translation-compare-notes-v7:project:rows";
  const storage = storageFixture({
    [currentKey]: JSON.stringify({
      1: {
        note: "[AI校对]\n语义是否相同：相同\n是否需要修改：否\n快速直通：是\nGatekeeper初审：原译准确无需修改\n分析：目标列与原文贴合。",
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

test("多阶段控制：阶段一执行时阶段二与阶段三开始按钮状态完全解耦，不被强制绑定禁用", async () => {
  const runningAiPayload = {
    running: true,
    runId: "run-staged-decouple",
    stagePipelines: {
      stage1: { inFlight: 10, pending: 25 },
      stage2: { inFlight: 0, pending: 0 },
      stage3: { inFlight: 0, pending: 0 },
    },
    results: [],
  };
  const ui = createWorkbench(storageFixture({}), {
    apiResponses: {
      "/api/ai-proofread/start": { ok: true, ai: runningAiPayload },
      "/api/ai-proofread/stop": { ok: true, ai: { running: false, stopRequested: true, runId: "run-staged-decouple", results: [] } },
    },
    statusQueue: [
      { ok: true, ai: runningAiPayload },
      { ok: true, ai: runningAiPayload },
      { ok: true, ai: runningAiPayload },
      { ok: true, ai: runningAiPayload },
      { ok: true, ai: runningAiPayload },
    ],
  });

  const s1Start = ui.element("stage1Start");
  const s1Stop = ui.element("stage1Stop");
  const s2Start = ui.element("stage2Start");
  const s2Stop = ui.element("stage2Stop");
  const s3Start = ui.element("stage3Start");
  const s3Stop = ui.element("stage3Stop");

  // 1. 启动阶段一
  await s1Start.dispatch("click");
  assert.equal(s1Start.disabled, true, "阶段一自身运行中，开始按钮禁用");
  assert.equal(s1Stop.disabled, false, "阶段一自身运行中，停止按钮激活");

  // 核心断言：阶段二与阶段三在阶段一执行期间绝不被强制绑定禁用
  assert.equal(s2Start.disabled, false, "阶段二处于待命，开始按钮必须可点击");
  assert.equal(s2Stop.disabled, true, "阶段二未在运行，停止按钮必须禁用");
  assert.equal(s3Start.disabled, false, "阶段三处于待命，开始按钮必须可点击");
  assert.equal(s3Stop.disabled, true, "阶段三未在运行，停止按钮必须禁用");

  // 2. 模拟从后台接收带 stagePipelines 的状态更新（例如 S1 处理中，S2 空闲，S3 空闲）
  ui.run(`
    renderAiStatus({
      kind: "ai",
      running: true,
      runId: "run-staged-decouple",
      stagePipelines: {
        stage1: { inFlight: 10, pending: 25 },
        stage2: { inFlight: 0, pending: 0 },
        stage3: { inFlight: 0, pending: 0 },
      },
    });
  `);

  assert.equal(s1Start.disabled, true, "流水线指示阶段一处理中，开始按钮禁用");
  assert.equal(s1Stop.disabled, false, "阶段一停止按钮激活");
  assert.equal(s2Start.disabled, false, "状态更新后阶段二开始按钮依然保持可用");
  assert.equal(s2Stop.disabled, true, "阶段二停止按钮依然保持禁用");
  assert.equal(s3Start.disabled, false, "阶段三开始按钮依然保持可用");
  assert.equal(s3Stop.disabled, true, "阶段三停止按钮依然保持禁用");

  // 3. 配置阶段二预设，点击阶段二「开始」进行安全排队
  ui.run('aiIds.stage2Preset.value = "preset-s2"');
  await s2Start.dispatch("click");
  assert.equal(ui.run("stage2WaitingForStage1"), true, "阶段二进入排队状态");
  assert.equal(s2Start.disabled, true, "排队中的阶段二开始按钮被禁用");
  assert.equal(s2Stop.disabled, false, "排队中的阶段二停止按钮激活，用于随时取消排队");
  assert.equal(s3Start.disabled, false, "阶段三依然不受干扰，保持可点击");

  // 4. 点击阶段二「停止」取消排队
  await s2Stop.dispatch("click");
  assert.equal(ui.run("stage2WaitingForStage1"), false, "已成功取消排队");
  assert.equal(s2Start.disabled, false, "取消排队后阶段二开始按钮恢复可用");
  assert.equal(s2Stop.disabled, true, "取消排队后阶段二停止按钮恢复禁用");
  assert.equal(s1Stop.disabled, false, "阶段一仍然在运行，未被误停止");
});

test("待判行各阶段审查记录完整保留且卡片默认直接展开", async () => {
  const currentKey = "translation-compare-notes-v7:project:rows";
  const storage = storageFixture({
    [currentKey]: JSON.stringify({
      33: {
        note: "[AI校对]\n语义是否相同：不同\n是否需要修改：待人工确认\nGatekeeper初审：译文遗漏句首惊叹反应「ハッ!?」及关键动作「外に出て」，且将强调语气的「这一定是」误译。\nStylist复审[提交仲裁]：两处瑕疵属实，但句尾语气是否需强行重构存疑，建议终审裁定\nArbiter仲裁[存疑待定]：经终审法官全面权衡各方证据，依据依然不足，建议转人工确认\n分析：依据依然不足，转人工确认。",
        aiDone: false,
      },
      36: {
        // 向后兼容存量仅有「分析：需要修改……」的历史待判备注
        note: "[AI校对]\n语义是否相同：相同\n是否需要修改：待人工确认\n分析：需要修改：译文多出原文没有的“源自”，造成语句修饰关系与搭配不当，应做最小删改。",
        aiDone: false,
      },
    }),
  });

  const ui = createWorkbench(storage, {
    rows: [
      { index: 33, jp: "JP33", cn: "CN33", tw: "TW33", relation: "1:1", score: 0.7, signature: "sig-33" },
      { index: 36, jp: "JP36", cn: "CN36", tw: "TW36", relation: "1:1", score: 0.77, signature: "sig-36" },
    ],
  });

  // 行 33: 完整包含初审、复审、终审，且默认展开
  const html33 = ui.run('renderNoteSummary(notes["33"], "33")');
  assert.match(html33, /阶段一：事实初审/);
  assert.match(html33, /译文遗漏句首惊叹反应/);
  assert.match(html33, /阶段二：文学复审/);
  assert.match(html33, /两处瑕疵属实/);
  assert.match(html33, /阶段三：终审仲裁/);
  assert.match(html33, /依据依然不足/);
  assert.doesNotMatch(html33, /id="pipelineDetails_33"\s+hidden/, "待人工确认行审核轨迹默认直接展开呈现，不加 hidden");

  // 行 36: 向后兼容存量初审分析，自动以初审卡片形式展开
  const html36 = ui.run('renderNoteSummary(notes["36"], "36")');
  assert.match(html36, /阶段一：事实初审/);
  assert.match(html36, /译文多出原文没有的“源自”/);
  assert.doesNotMatch(html36, /id="pipelineDetails_36"\s+hidden/, "存量待判行同样默认展开初审审查卡片");
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { createWorkbench } = require("./workbench-fixture");

test("parseAutomatedNote extracts structured multi-stage review trace", () => {
  const ui = createWorkbench();

  const noteWithStages = [
    "[AI校对]",
    "语义是否相同：不同",
    "是否需要修改：是",
    "Gatekeeper初审：发现否定时态遗漏，原文带有「〜なかった」。",
    "Stylist复审[调整]：认同否定问题，但语调过于僵硬，调整为更自然的主谓句。",
    "Arbiter仲裁[Stylist方案]：Stylist方案文采自然且忠实原文，裁定采纳Stylist方案。",
    "修改结果：他终究还是没能推开那扇门。",
  ].join("\n");

  const parsed = ui.run(`parseAutomatedNote(${JSON.stringify(noteWithStages)})`);
  assert.ok(parsed);
  assert.equal(parsed.stage1, "发现否定时态遗漏，原文带有「〜なかった」。");
  assert.ok(parsed.stage2);
  assert.equal(parsed.stage2.attitude, "调整");
  assert.ok(parsed.stage2.text.includes("认同否定问题"));
  assert.ok(parsed.stage3);
  assert.equal(parsed.stage3.winner, "Stylist方案");
  assert.ok(parsed.stage3.text.includes("Stylist方案文采自然"));
  assert.equal(parsed.revision, "他终究还是没能推开那扇门。");
});

test("renderNoteSummary generates compact pipeline capsule and expandable drawer", () => {
  const ui = createWorkbench();

  const noteWithStages = [
    "[AI校对]",
    "语义是否相同：不同",
    "是否需要修改：是",
    "Gatekeeper初审：指出词义偏差",
    "Stylist复审[采纳]：完全认同初审发现",
    "修改结果：正确的译文",
  ].join("\n");

  const html = ui.run(`renderNoteSummary({ note: ${JSON.stringify(noteWithStages)} }, "1")`);

  // 1. 紧凑胶囊条
  assert.match(html, /<div class="stage-pipeline-badge" data-pipeline-toggle="1"/);
  assert.match(html, /<span class="pipeline-step is-gk">初审<\/span>/);
  assert.match(html, /<span class="pipeline-step is-accept">复审·采纳<\/span>/);
  assert.match(html, /<span class="pipeline-expand-hint">审核轨迹 ▾<\/span>/);

  // 2. 结构化展开卡片抽屉（默认 hidden，不占多余空间）
  assert.match(html, /<div class="stage-pipeline-details" id="pipelineDetails_1" hidden>/);
  assert.match(html, /🛡️ 阶段一：事实初审/);
  assert.match(html, /指出词义偏差/);
  assert.match(html, /✍️ 阶段二：文学复审/);
  assert.match(html, /完全认同初审发现/);
});

test("stage card filter: clicking stage cards filters table rows", async () => {
  const ui = createWorkbench(undefined, {
    rows: [
      { index: 1, relation: "1:1", jp: "A1", cn: "B1", signature: "sig1" },
      { index: 2, relation: "1:1", jp: "A2", cn: "B2", signature: "sig2" },
      { index: 3, relation: "1:1", jp: "A3", cn: "B3", signature: "sig3" },
    ],
  });

  // Setup notes with different stages
  ui.run(`
    notes["1"] = { note: "[AI校对]\\n是否需要修改：否\\nGatekeeper初审：无误", manualDone: false };
    notes["2"] = { note: "[AI校对]\\n是否需要修改：是\\nGatekeeper初审：漏译\\nStylist复审[调整]：修饰\\n修改结果：新译", manualDone: false };
    notes["3"] = { note: "[AI校对]\\n是否需要修改：是\\nGatekeeper初审：分歧\\nStylist复审[驳回]：驳回\\nArbiter仲裁[维持原译]：终审\\n修改结果：原译", manualDone: false };
  `);

  // Click Stage 2 card -> filters only row 2 and row 3 (which underwent Stylist review)
  const card2 = ui.element("stage2Card");
  assert.ok(card2);
  card2.dataset.filterStage = "2";
  await card2.dispatch("click");

  let visible = ui.run("filteredRows.map(r => r.index)");
  assert.deepEqual([...visible], [2, 3]);

  // Click Stage 3 card -> filters only row 3 (which underwent arbitration)
  const card3 = ui.element("stage3Card");
  assert.ok(card3);
  card3.dataset.filterStage = "3";
  await card3.dispatch("click");

  visible = ui.run("filteredRows.map(r => r.index)");
  assert.deepEqual([...visible], [3]);

  // Click again to cancel filter -> shows all rows
  await card3.dispatch("click");
  visible = ui.run("filteredRows.map(r => r.index)");
  assert.deepEqual([...visible], [1, 2, 3]);
});

test("selecting stage preset or clicking header does not trigger stage filter", async () => {
  const ui = createWorkbench(undefined, {
    rows: [
      { index: 1, relation: "1:1", jp: "A1", cn: "B1", signature: "sig1" },
      { index: 2, relation: "1:1", jp: "A2", cn: "B2", signature: "sig2" },
      { index: 3, relation: "1:1", jp: "A3", cn: "B3", signature: "sig3" },
    ],
  });

  ui.run(`
    notes["1"] = { note: "[AI校对]\\n是否需要修改：否\\nGatekeeper初审：无误", manualDone: false };
    notes["2"] = { note: "[AI校对]\\n是否需要修改：是\\nGatekeeper初审：漏译\\nStylist复审[调整]：修饰\\n修改结果：新译", manualDone: false };
    notes["3"] = { note: "[AI校对]\\n是否需要修改：是\\nGatekeeper初审：分歧\\nStylist复审[驳回]：驳回\\nArbiter仲裁[维持原译]：终审\\n修改结果：原译", manualDone: false };
  `);

  const card2 = ui.element("stage2Card");
  const select2 = ui.element("stage2PresetSelect");
  assert.ok(card2);
  assert.ok(select2);
  card2.dataset.filterStage = "2";

  // 1. 用户与下拉选框交互（点击、改变选项）绝不应触发阶段筛选
  await select2.dispatch("mousedown", { target: select2 });
  await select2.dispatch("click", { target: select2 });
  await select2.dispatch("change", { target: select2 });

  let visible = ui.run("filteredRows.map(r => r.index)");
  assert.deepEqual([...visible], [1, 2, 3], "All rows remain visible after preset select interactions");
  assert.equal(ui.run("activeStageFilter"), null);
  assert.equal(card2.classList.contains("is-active-filter"), false);

  // 2. 在操作下拉选框后的时间抑制窗口内（<=600ms），即使有穿透合成点击落在卡片主体上，也被拦截
  await card2.dispatch("click", { target: card2 });
  visible = ui.run("filteredRows.map(r => r.index)");
  assert.deepEqual([...visible], [1, 2, 3], "Card click within suppression window is ignored");
  assert.equal(ui.run("activeStageFilter"), null);

  // 3. 等待抑制窗口过期（650ms）
  await new Promise((resolve) => setTimeout(resolve, 650));

  // 4. 点击卡片头部（标题文字、标签区域、或下拉框容器）绝不触发阶段筛选
  const fakeHeaderElement = {
    closest(selector) {
      if (selector.includes(".ai-stage-card-head")) return true;
      return null;
    },
  };
  await card2.dispatch("click", { target: fakeHeaderElement });
  visible = ui.run("filteredRows.map(r => r.index)");
  assert.deepEqual([...visible], [1, 2, 3], "Header click is ignored even after suppression window");
  assert.equal(ui.run("activeStageFilter"), null);

  // 5. 用户正常点击卡片主体指标时，正常触发阶段筛选
  await card2.dispatch("click", { target: card2 });
  visible = ui.run("filteredRows.map(r => r.index)");
  assert.deepEqual([...visible], [2, 3], "Legitimate metric click filters stage rows");
  assert.equal(ui.run("activeStageFilter"), "2");
  assert.equal(card2.classList.contains("is-active-filter"), true);

  // 6. 点击「清筛选」按钮重置所有筛选时，阶段筛选状态与卡片高亮也一并重置
  const clearFilterBtn = ui.element("clearFilter");
  assert.ok(clearFilterBtn);
  await clearFilterBtn.dispatch("click");
  visible = ui.run("filteredRows.map(r => r.index)");
  assert.deepEqual([...visible], [1, 2, 3], "Clear filter resets stage filter");
  assert.equal(ui.run("activeStageFilter"), null);
  assert.equal(card2.classList.contains("is-active-filter"), false);
});

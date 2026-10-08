const test = require("node:test");
const assert = require("node:assert/strict");
const { createWorkbench, storageFixture } = require("./workbench-fixture");

test("自动备注解析：parseAutomatedNote 提取结构化多阶段评审轨迹", () => {
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

test("备注摘要渲染：renderNoteSummary 生成紧凑流程胶囊与可折叠抽屉", () => {
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

test("阶段指标筛选：切换指标、再次点击取消，卡片空白处不筛选", async () => {
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

  ui.run("markNotesDirtyForMetrics()");
  const card2 = ui.element("stage2Card");
  await card2.dispatch("click");
  assert.deepEqual([...ui.run("filteredRows.map(r => r.index)")], [1, 2, 3]);
  assert.equal(card2.listenerCount("click"), 0);
  await ui.element("stage2ReviewedItem").dispatch("click");

  let visible = ui.run("filteredRows.map(r => r.index)");
  assert.deepEqual([...visible], [2, 3]);

  const card3 = ui.element("stage3ArbitratedItem");
  await card3.dispatch("click");

  visible = ui.run("filteredRows.map(r => r.index)");
  assert.deepEqual([...visible], [3]);
  assert.equal(ui.element("stage2ReviewedItem").getAttribute("aria-pressed"), "false");
  assert.equal(card3.getAttribute("aria-pressed"), "true");

  // Click again to cancel filter -> shows all rows
  await card3.dispatch("click");
  visible = ui.run("filteredRows.map(r => r.index)");
  assert.deepEqual([...visible], [1, 2, 3]);
  assert.equal(card3.getAttribute("aria-pressed"), "false");
});

test("阶段卡片筛选：选择阶段预设或点击卡片头部不触发筛选", async () => {
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

  // 1. 用户与下拉选框交互（点击、改变选项）绝不应触发阶段筛选
  await select2.dispatch("mousedown", { target: select2 });
  await select2.dispatch("click", { target: select2 });
  await select2.dispatch("change", { target: select2 });

  let visible = ui.run("filteredRows.map(r => r.index)");
  assert.deepEqual([...visible], [1, 2, 3], "All rows remain visible after preset select interactions");
  assert.equal(ui.run("activeSummaryFilter"), null);
  assert.equal(card2.classList.contains("is-active-filter"), false);

  // 2. 下拉关闭后的合成点击即使落在卡片空白处，也不会筛选。
  await card2.dispatch("click", { target: card2 });
  visible = ui.run("filteredRows.map(r => r.index)");
  assert.deepEqual([...visible], [1, 2, 3], "Card background does not filter");
  assert.equal(ui.run("activeSummaryFilter"), null);

  // 3. 点击卡片头部不触发筛选。
  const fakeHeaderElement = {
    closest(selector) {
      if (selector.includes(".ai-stage-card-head")) return true;
      return null;
    },
  };
  await card2.dispatch("click", { target: fakeHeaderElement });
  visible = ui.run("filteredRows.map(r => r.index)");
  assert.deepEqual([...visible], [1, 2, 3], "Header click does not filter");
  assert.equal(ui.run("activeSummaryFilter"), null);

  // 4. 具体指标仍能筛选。
  ui.run("markNotesDirtyForMetrics()");
  await ui.element("stage2ReviewedItem").dispatch("click");
  visible = ui.run("filteredRows.map(r => r.index)");
  assert.deepEqual([...visible], [2, 3], "Legitimate metric click filters stage rows");
  assert.equal(ui.run("activeSummaryFilter"), "stage2Reviewed");
  assert.equal(ui.element("stage2ReviewedItem").classList.contains("is-active"), true);

  // 5. 清筛选同时清除指标高亮与辅助状态。
  const clearFilterBtn = ui.element("clearFilter");
  assert.ok(clearFilterBtn);
  await clearFilterBtn.dispatch("click");
  visible = ui.run("filteredRows.map(r => r.index)");
  assert.deepEqual([...visible], [1, 2, 3], "Clear filter resets stage filter");
  assert.equal(ui.run("activeSummaryFilter"), null);
  assert.equal(ui.element("stage2ReviewedItem").classList.contains("is-active"), false);
  assert.equal(ui.element("stage2ReviewedItem").getAttribute("aria-pressed"), "false");
});

test("所有阶段数字独立筛选最新记录，筛选数量与统计一致", async () => {
  const initial = (modify = "是") => "[AI校对]\n是否需要修改：" + modify;
  const reviewed = (attitude) => initial() + "\n初审改案：初审案\nStylist复审[" + attitude + "]：复审结论\n修改结果：复审案";
  const arbitrated = (winner) => reviewed("调整") + "\nArbiter仲裁[" + winner + "]：终审结论";
  const noteTexts = [
    "[规则预筛]\n是否需要修改：否",
    initial("否"),
    initial(),
    initial("待终审") + "\nGatekeeper初审：存疑",
    reviewed("采纳"), reviewed("modify"), reviewed("驳回"), reviewed("escalate"),
    arbitrated("Gatekeeper方案"), arbitrated("复审方案"), arbitrated("combined"), arbitrated("维持原译"),
    "[AI校对]\n调用失败：网络断开",
    initial() + "\nStylist复审调用异常：网络断开",
    reviewed("调整") + "\nArbiter仲裁调用异常：超时",
    arbitrated("原译") + "\n\n" + initial("否"),
    arbitrated("初审方案"), reviewed("调整"),
  ];
  const rows = noteTexts.map((_, i) => ({ index: i + 1, jp: "A" + i, cn: "B" + i, signature: "sig" + i }));
  const ui = createWorkbench(undefined, { rows, strictIds: true });
  const noteItems = Object.fromEntries(noteTexts.map((note, i) => [i + 1, { note, manualDone: i >= 16 }]));
  ui.run(`Object.assign(notes, ${JSON.stringify(noteItems)}); markNotesDirtyForMetrics(); updateStageMetricsDashboard();`);
  const cases = [
    ["stage1PassedItem", "stage1Passed", [1, 2, 16]],
    ["stage1NeedsEditItem", "stage1NeedsEdit", [3, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 17, 18]],
    ["stage1UnclearPill", "stage1Unclear", [4]],
    ["stage1FastPassItem", "fastPassHits", [1]],
    ["stage1TotalItem", "stage1Total", rows.map((r) => r.index).filter((i) => i !== 13)],
    ["stage1ErrorItem", "stage1Errors", [13]],
    ["stage2ReviewedItem", "stage2Reviewed", [5, 6, 7, 8, 9, 10, 11, 12, 15, 17, 18]],
    ["stage2DivergedItem", "stage2Diverged", [6, 7, 8, 9, 10, 11, 12, 15, 17]],
    ["stage2AcceptItem", "critiqueAccept", [5]],
    ["stage2ModifyItem", "critiqueModify", [6, 9, 10, 11, 12, 15, 17, 18]],
    ["stage2RejectItem", "critiqueReject", [7]],
    ["stage2EscalateItem", "critiqueEscalate", [8]],
    ["stage2PendingItem", "stage2Pending", [3, 4, 14]],
    ["stage2ErrorItem", "stage2Errors", [14]],
    ["stage3ArbitratedItem", "stage3Arbitrated", [9, 10, 11, 12, 17]],
    ["stage3SettledItem", "stage3Settled", [9, 10, 11, 12, 17]],
    ["stage3GatekeeperItem", "arbitrationGatekeeper", [9, 17]],
    ["stage3StylistItem", "arbitrationStylist", [10]],
    ["stage3SynthesisItem", "arbitrationSynthesis", [11]],
    ["stage3OriginalItem", "arbitrationOriginal", [12]],
    ["stage3PendingItem", "stage3Pending", [6, 7, 8, 15]],
    ["stage3ErrorItem", "stage3Errors", [15]],
  ];
  for (const [id, metric, expected] of cases) {
    const button = ui.element(id);
    assert.match(ui.html, new RegExp('<button[^>]*id="' + id + '"[^>]*>'));
    assert.equal(button.listenerCount("keydown"), 0, id + " uses native keyboard activation");
    await button.dispatch("click");
    assert.deepEqual([...ui.run("filteredRows.map(r => r.index)")], expected, id);
    assert.equal(ui.run(`computeStageMetricsFromNotes().${metric}`), expected.length, metric);
    assert.equal(button.getAttribute("aria-pressed"), "true", id);
  }
  await ui.element("aiStageSummaryUnchanged").dispatch("click");
  assert.equal(ui.element("stage3ErrorItem").getAttribute("aria-pressed"), "false");
  await ui.element("stage2AcceptItem").dispatch("click");
  assert.equal(ui.element("aiStageSummaryUnchanged").getAttribute("aria-pressed"), "false");
  ui.run(`notes["5"].note = "[AI校对]\\n调用失败：重试失败"; markNotesDirtyForMetrics(); applyFilters();`);
  assert.deepEqual([...ui.run("filteredRows.map(r => r.index)")], []);
  await ui.element("clearFilter").dispatch("click");
  assert.equal(ui.run("filteredRows.length"), rows.length);
  for (const [id] of cases) assert.equal(ui.element(id).getAttribute("aria-pressed"), "false");
});

test("自动备注解析：parseAutomatedNote 提取各阶段改案并支持旧版兼容推断", () => {
  const ui = createWorkbench();

  // 1. 新格式：显式包含 初审改案 与 复审改案
  const noteNew = [
    "[AI校对]",
    "语义是否相同：相同",
    "是否需要修改：是",
    "Gatekeeper初审：指出语病重复与事实增补",
    "初审改案：彼时，亚雷斯塔尚未登门。",
    "Stylist复审[调整]：深化隐喻，修饰节奏",
    "复审改案：彼时，亚雷斯塔尚未叩响门扉。",
    "修改结果：彼时，亚雷斯塔尚未叩响门扉。",
  ].join("\n");

  const parsedNew = ui.run(`parseAutomatedNote(${JSON.stringify(noteNew)})`);
  assert.equal(parsedNew.stage1Revision, "彼时，亚雷斯塔尚未登门。");
  assert.equal(parsedNew.stage2Revision, "彼时，亚雷斯塔尚未叩响门扉。");
  assert.equal(parsedNew.revision, "彼时，亚雷斯塔尚未叩响门扉。");

  // 2. 历史/旧格式：仅在 Stylist 评语中提及初审处理
  const noteLegacy = [
    "[AI校对]",
    "语义是否相同：相同",
    "是否需要修改：是",
    "Gatekeeper初审：指出原译‘还尚未’语义重复。",
    "Stylist复审[调整]：Gatekeeper 处理为‘亚雷斯塔尚未登门’过于平淡直白，宜深化隐喻色彩。",
    "修改结果：彼时，亚雷斯塔尚未叩响门扉。",
  ].join("\n");

  const parsedLegacy = ui.run(`parseAutomatedNote(${JSON.stringify(noteLegacy)})`);
  assert.equal(parsedLegacy.stage1Revision, "亚雷斯塔尚未登门");
  assert.equal(parsedLegacy.stage2Revision, "彼时，亚雷斯塔尚未叩响门扉。");
});

test("改动演进可视化：renderNoteSummary 与 renderDiffBlock 渲染分步对比与版本切换器", async () => {
  const ui = createWorkbench(undefined, {
    rows: [
      {
        index: 2,
        relation: "1:1",
        jp: "未だアレイスターが門を叩く前の、ある意味においては平和な时代のお话。",
        cn: "这个故事发生在某种意义上尚算平和的时代——彼时，亚雷斯塔还尚未登门拜师。",
        signature: "sig2",
      },
    ],
  });

  const noteWithProgression = [
    "[AI校对]",
    "语义是否相同：相同",
    "是否需要修改：是",
    "质量评分：97分 (-3)",
    "Gatekeeper初审：指出语病重复与增补",
    "初审改案：这个故事发生在某种意义上尚算平和的时代——彼时，亚雷斯塔尚未登门。",
    "Stylist复审[调整]：增强隐喻色彩并调谐用字",
    "复审改案：这个故事发生在某种意义上还算平和的时代——彼时，亚雷斯塔尚未叩响门扉。",
    "修改结果：这个故事发生在某种意义上还算平和的时代——彼时，亚雷斯塔尚未叩响门扉。",
  ].join("\n");

  ui.run(`
    notes["2"] = {
      note: ${JSON.stringify(noteWithProgression)},
      revisionText: "这个故事发生在某种意义上还算平和的时代——彼时，亚雷斯塔尚未叩响门扉。",
      manualDone: false,
    };
  `);

  // 1. 检查差异辅助（renderDiffBlock）：默认展示全貌对比，分步演进明细默认展开（<details open>）
  const rowObj = ui.run('allRows.find(r => r.index === 2)');
  const diffHtml = ui.run(`renderDiffBlock(${JSON.stringify(rowObj)}, notes["2"])`);
  assert.match(diffHtml, /译文 → 修改结果/);
  assert.match(diffHtml, /<details open class="diff-step-details">/);
  assert.match(diffHtml, /分步演进明细/);
  assert.match(diffHtml, /步骤 1：事实初审/);
  assert.match(diffHtml, /步骤 2：文学复审/);

  // 2. 检查审核轨迹卡片与版本切换器（renderNoteSummary）：精简轻量，消除重复分析栏与冗余改案重复
  const summaryHtml = ui.run(`renderNoteSummary(notes["2"], "2")`);
  assert.match(summaryHtml, /指出语病重复与增补/);
  assert.match(summaryHtml, /增强隐喻色彩并调谐用字/);
  assert.doesNotMatch(summaryHtml, /初审改案:/, "右侧审核卡片不再机械重复打印初审改案全文");
  // 阶段卡片只保留审查意见；各阶段改案全文只在左侧「差异辅助（修改结果对比 + 分步演进明细）」
  // 与「修改结果」编辑框中呈现一次，绝不在右侧卡片里重复打印。
  assert.equal(summaryHtml.includes("stage-report-rev"), false, "阶段卡片不得再挂出改案全文块");
  assert.equal(summaryHtml.includes("初审建议："), false, "初审改案全文不得在右侧阶段卡片重复出现");
  assert.equal(summaryHtml.includes("复审建议："), false, "复审改案全文不得在右侧阶段卡片重复出现");
  assert.match(summaryHtml, /revision-stage-pills/);
  assert.match(summaryHtml, /data-apply-stage="1"/);
  assert.match(summaryHtml, /data-apply-stage="2"/);
  assert.equal(summaryHtml.includes('note-reason'), false, "初审与分析100%重复时已消除冗余分析栏");

  // 3. 测试点击「采纳初审方案」切换版本
  ui.run('applyStageRevision("2", "1")');
  const activeRev = ui.run('notes["2"].revisionText');
  assert.equal(activeRev, "这个故事发生在某种意义上尚算平和的时代——彼时，亚雷斯塔尚未登门。");

  // 切换后再次生成 diffHtml，此时当前选中的已是初审改案
  const diffAfterS1 = ui.run(`renderDiffBlock(${JSON.stringify(rowObj)}, notes["2"])`);
  assert.ok(diffAfterS1);
});

test("未显式包含 stage1Revision 的多阶段行仍正常渲染版本按钮并可展开演进对比", () => {
  const ui = createWorkbench(undefined, {
    rows: [
      {
        index: 8,
        relation: "1:1",
        jp: "「新婦ミナよ。あなたは結婚を申し込んだ人生の伴侶メイザースを認め、ミナ=メイザースというご自身の新たな名前を受け入れますか?」",
        cn: "「新娘米娜，请问你愿意接受马瑟斯先生成为你的人生伴侣，并从此改名为米娜·马瑟斯吗？」",
        signature: "sig8",
      },
    ],
  });

  // 模拟历史数据：只有初审说明和复审调整，没有独立的「初审改案：」
  const noteRow8 = [
    "[AI校对]",
    "语义是否相同：相同",
    "是否需要修改：是",
    "质量评分：95分 (-5)",
    "Gatekeeper初审：需要修改：译文漏译原文限定语「結婚を申し込んだ」（主动求婚的），属性忌遗漏，其余语义一致。",
    "Stylist复审[调整]：初审员敏锐地指出了限定语的漏译。然而初审修改稿仍残留明显的翻译腔与口吻偏差……因此需在补全信息的基础上，重塑誓词的典雅庄重文风。",
    "修改结果：「新娘米娜。你是否愿意承认向你求婚的人生伴侣马瑟斯，并接纳‘米娜·马瑟斯’这一属于你自己的新名字？」",
  ].join("\n");

  ui.run(`
    notes["8"] = {
      note: ${JSON.stringify(noteRow8)},
      revisionText: "「新娘米娜。你是否愿意承认向你求婚的人生伴侣马瑟斯，并接纳‘米娜·马瑟斯’这一属于你自己的新名字？」",
      manualDone: false,
    };
  `);

  const rowObj = ui.run('allRows.find(r => r.index === 8)');

  // 1. 差异辅助应包含默认展开的分步演进
  const diffHtml = ui.run(`renderDiffBlock(${JSON.stringify(rowObj)}, notes["8"])`);
  assert.match(diffHtml, /<details open class="diff-step-details">/);
  assert.match(diffHtml, /步骤 1：事实初审/);
  assert.match(diffHtml, /步骤 2：文学复审/);

  // 2. 修改结果区必须渲染「版本: [初审] [复审]」切换按钮，绝不缺失！
  const summaryHtml = ui.run(`renderNoteSummary(notes["8"], "8")`);
  assert.match(summaryHtml, /revision-stage-pills/);
  assert.match(summaryHtml, /data-apply-stage="1"/);
  assert.match(summaryHtml, /data-apply-stage="2"/);
});

test("删除与增译意见不将删除词句误推断为 stage1Revision 改案", () => {
  const ui = createWorkbench(undefined, {
    rows: [
      {
        index: 58,
        relation: "1:1",
        jp: "ずばーん!! と大きく扉を開け放ってメイザースが入室してきた。",
        cn: "哐！！门被人猛地推开，马瑟斯大步流星地走了进来。",
        signature: "sig58",
      },
    ],
  });

  const noteRow58 = [
    "[AI校对]",
    "语义是否相同：相同",
    "是否需要修改：是",
    "质量评分：97分 (-3)",
    "Gatekeeper初审：需要修改：译文加入原文没有的入室方式「大步流星」，属轻微增译，删除后与原文一致。",
    "Stylist复审[调整]：Gatekeeper 正确指出了原译「大步流星」属于无中生有的成语化增译；但 Gatekeeper 依然保留了「门被人猛地推开」这一生硬的无名被动结构。原文中推门与进门的主体皆为马瑟斯（大きく扉を開け放ってメイザースが入室してきた），直接使用主动语序连贯叙述，不仅能彻底消除「门被人……」的机械翻译腔，而且更能传达原文推门而入的冲击感与镜头张力。",
    "修改结果：哐！！马瑟斯猛地推开门，走了进来。",
  ].join("\n");

  const parsed = ui.run(`parseAutomatedNote(${JSON.stringify(noteRow58)})`);
  assert.equal(parsed.stage1Revision, "", "待删除的增译词「大步流星」绝不可误提取为初审改案");

  ui.run(`
    notes["58"] = {
      note: ${JSON.stringify(noteRow58)},
      revisionText: "哐！！马瑟斯猛地推开门，走了进来。",
      manualDone: false,
    };
  `);

  const rowObj = ui.run('allRows.find(r => r.index === 58)');
  const diffHtml = ui.run(`renderDiffBlock(${JSON.stringify(rowObj)}, notes["58"])`);
  assert.equal(diffHtml.includes("建议替换为："), false, "删除意图绝不可显示为「建议替换为：大步流星」");
  assert.match(diffHtml, /事实审查重点/);
  assert.match(diffHtml, /审查要点：/);
  assert.match(diffHtml, /全句文学润色/);

  const summaryHtml = ui.run(`renderNoteSummary(notes["58"], "58")`);
  assert.equal(summaryHtml.includes("初审改案:"), false, "初审仅为审查要点时卡片不得挂出初审改案标签");

  // 脏数据测试：即便历史 note 显式包含「初审改案：大步流星」，解析与渲染层亦应防呆清洗
  const dirtyNote = [
    "[AI校对]",
    "语义是否相同：相同",
    "是否需要修改：是",
    "Gatekeeper初审：需要修改：译文加入原文没有的入室方式「大步流星」，属轻微增译，删除后与原文一致。",
    "初审改案：大步流星",
    "Stylist复审[调整]：采纳删除建议并润色全句",
    "修改结果：哐！！马瑟斯猛地推开门，走了进来。",
  ].join("\n");
  const parsedDirty = ui.run(`parseAutomatedNote(${JSON.stringify(dirtyNote)})`);
  assert.equal(parsedDirty.stage1Revision, "", "历史脏数据中的待删除词亦被自动清洗为空");
});

test("修改结果区结构精炼：长列名提取为轻量徽标，版本工具栏与操作按钮分层排布不拥挤", () => {
  const ui = createWorkbench(undefined, {
    labels: {
      jp: "日文原文",
      cn: "主文本（待修改文本）",
    },
    rows: [
      {
        index: 2,
        relation: "1:1",
        jp: "未だアレイスターが門を叩く前の、ある意味においては平和な時代のお話。",
        cn: "这个故事发生在某种意义上尚算和平的时代——彼时，亚雷斯塔尚未登门拜师。",
        signature: "sig2",
      },
    ],
  });

  const noteRow2 = [
    "[AI校对]",
    "语义是否相同：相同",
    "是否需要修改：是",
    "质量评分：97分 (-3)",
    "Gatekeeper初审：事实初审意见",
    "初审改案：初审修改案文本",
    "Stylist复审[调整]：文学复审意见",
    "修改结果：文学复审最终修改结果",
  ].join("\n");

  ui.run(`
    pageLabels.cn = "主文本（待修改文本）";
    notes["2"] = {
      note: ${JSON.stringify(noteRow2)},
      revisionText: "文学复审最终修改结果",
      revisionTarget: "cn",
      manualDone: false,
    };
  `);

  const summaryHtml = ui.run(`renderNoteSummary(notes["2"], "2")`);

  // 1. 标题必须保持简洁统一的「修改结果」，绝不可把长文本拼成「主文本（待修改文本）修改结果」
  assert.match(summaryHtml, /<span class="note-summary-key">修改结果<\/span>/);
  assert.equal(summaryHtml.includes("主文本（待修改文本）修改结果"), false, "冗长列名不得直接拼接在 key 中");

  // 2. 括号内的注释被剥离，以简洁的 badge 展示，并保留完整描述在 title 中
  assert.match(summaryHtml, /<span class="revision-target-badge" title="修改目标：主文本（待修改文本）">主文本<\/span>/);

  // 3. 顶行操作区包含写回和复制按钮
  assert.match(summaryHtml, /<div class="revision-head-actions"><button[^>]*class="writeback-revision"/);
  assert.match(summaryHtml, /<button[^>]*class="copy-revision"/);

  // 4. 版本切换栏作为独立工具栏行，位于顶栏之后、文本框之前
  const headPos = summaryHtml.indexOf('class="note-detail-head"');
  const pillsPos = summaryHtml.indexOf('class="revision-stage-pills"');
  const editorPos = summaryHtml.indexOf('class="revision-editor"');
  assert.ok(headPos > 0 && pillsPos > headPos && editorPos > pillsPos, "排版层次为：顶栏 -> 版本工具栏 -> 编辑框");
});

test("阶段三仲裁显示：胜出方案标签强制纯中文化，杜绝 Stylist/Gatekeeper 等英文词汇溢出", () => {
  const ui = createWorkbench();

  const noteWithEnglishWinner = [
    "[AI校对]",
    "语义是否相同：相同",
    "是否需要修改：是",
    "Gatekeeper初审：事实硬伤",
    "Stylist复审[调整]：文学润色",
    "Arbiter仲裁[Stylist方案]：采纳文学复审方案",
    "修改结果：最终润色文本",
  ].join("\n");

  const summaryHtml = ui.run(`renderNoteSummary({ note: ${JSON.stringify(noteWithEnglishWinner)} }, "1")`);
  // 胶囊条中显示纯中文「仲裁·复审方案」
  assert.match(summaryHtml, /<span class="pipeline-step is-arbiter">仲裁·复审方案<\/span>/);
  // 卡片标签中显示纯中文「复审方案」
  assert.match(summaryHtml, /<span class="stage-report-tag is-arbiter">复审方案<\/span>/);
  // 绝不出现未经翻译的英文单词 Stylist
  assert.equal(summaryHtml.includes("Stylist方案"), false, "胶囊和卡片标签中不得包含英文单词 Stylist");

  // 测试打破二选一的结合修改方案（synthesis / 结合方案）渲染
  const noteWithSynthesis = [
    "[AI校对]",
    "语义是否相同：相同",
    "是否需要修改：是",
    "Gatekeeper初审：事实硬伤",
    "初审改案：初审纠错",
    "Stylist复审[调整]：文学润色",
    "复审改案：复审润色",
    "Arbiter仲裁[结合方案]：融合初审纠错与复审润色长处",
    "仲裁改案：最终结合定案文本",
    "修改结果：最终结合定案文本",
  ].join("\n");
  const synthesisSummaryHtml = ui.run(`renderNoteSummary({ note: ${JSON.stringify(noteWithSynthesis)} }, "1")`);
  assert.match(synthesisSummaryHtml, /<span class="pipeline-step is-arbiter">仲裁·结合方案<\/span>/);
  assert.match(synthesisSummaryHtml, /<span class="stage-report-tag is-arbiter">结合方案<\/span>/);
  assert.match(synthesisSummaryHtml, /class="stage-pill-btn is-arbiter is-active"/);
  assert.equal(synthesisSummaryHtml.includes("仲裁定案："), false, "仲裁定案全文不得在右侧阶段卡片重复出现");
});

test("修改结果默认版本显示逻辑：无关筛选，默认显示最后的版本（仲裁 ＞ 复审 ＞ 初审）", () => {
  const ui = createWorkbench(undefined, {
    rows: [
      { index: 1, relation: "1:1", jp: "A1", cn: "B1", signature: "sig1" },
      { index: 2, relation: "1:1", jp: "A2", cn: "B2", signature: "sig2" },
      { index: 3, relation: "1:1", jp: "A3", cn: "B3", signature: "sig3" },
    ],
  });

  ui.run(`
    // 行 1：只有初审改案
    notes["1"] = {
      note: "[AI校对]\\n是否需要修改：是\\nGatekeeper初审：初审意见\\n初审改案：初审案1\\n修改结果：初审案1",
      manualDone: false,
    };
    // 行 2：初审 + 复审改案
    notes["2"] = {
      note: "[AI校对]\\n是否需要修改：是\\nGatekeeper初审：初审意见\\n初审改案：初审案2\\nStylist复审[调整]：复审意见\\n复审改案：复审案2\\n修改结果：复审案2",
      manualDone: false,
    };
    // 行 3：初审 + 复审 + 仲裁改案
    notes["3"] = {
      note: "[AI校对]\\n是否需要修改：是\\nGatekeeper初审：初审意见\\n初审改案：初审案3\\nStylist复审[提交仲裁]：分歧\\n复审改案：复审案3\\nArbiter仲裁[复审方案]：仲裁意见\\n仲裁改案：仲裁案3\\n修改结果：仲裁案3",
      manualDone: false,
    };
  `);

  // 1. 行 1 默认取初审版本
  assert.equal(ui.run('revisionTextFor(notes["1"])'), "初审案1");
  const s1Html = ui.run('renderNoteSummary(notes["1"], "1")');
  assert.match(s1Html, /class="stage-pill-btn is-gk is-active"/);

  // 2. 行 2 默认取复审版本（复审 ＞ 初审）
  assert.equal(ui.run('revisionTextFor(notes["2"])'), "复审案2");
  const s2Html = ui.run('renderNoteSummary(notes["2"], "2")');
  assert.match(s2Html, /class="stage-pill-btn is-stylist is-active"/);

  // 3. 行 3 默认取仲裁版本（仲裁 ＞ 复审 ＞ 初审）
  assert.equal(ui.run('revisionTextFor(notes["3"])'), "仲裁案3");
  const s3Html = ui.run('renderNoteSummary(notes["3"], "3")');
  assert.match(s3Html, /class="stage-pill-btn is-arbiter is-active"/);

  // 4. 无论处于何种阶段筛选状态（比如筛选了阶段一），默认版本保持不变（仍是最后的版本）
  ui.run('activeSummaryFilter = "stage1NeedsEdit"');
  assert.equal(ui.run('revisionTextFor(notes["3"])'), "仲裁案3");
  ui.run('activeSummaryFilter = null');

  // 5. 若用户手动点击了「初审」版本按钮，遵循显式选择
  ui.run('applyStageRevision("3", "1")');
  assert.equal(ui.run('revisionTextFor(notes["3"])'), "初审案3");
  const s3SwitchedHtml = ui.run('renderNoteSummary(notes["3"], "3")');
  assert.match(s3SwitchedHtml, /class="stage-pill-btn is-gk is-active"/);
});

test("长段与含noteref行中局部修正提议绝不覆盖整段修改结果", () => {
  const row525Text = "该怎么办？\\n\\n从这里开始还能有正确的选择吗？！\\n\\n就算是能回答任何问题的狐狗狸<a class=\"nodeco\" epub:type=\"noteref\" href=\"S6_22.06.10-Note.xhtml#note10\"><sup>㊟</sup></a>或者悟君<a class=\"nodeco\" epub:type=\"noteref\" href=\"S6_22.06.10-Note.xhtml#note11\"><sup>㊟</sup></a>，见到如此场景恐怕也会被吓到，还是决定先观望一下吧！！！！！！";
  const ui = createWorkbench(undefined, {
    rows: [
      {
        index: 525,
        relation: "简台 细分 3:3 / 日文 1:1",
        jp: "どうすれば良い？ ここから何か正解の選択肢とかあんのか!? 頼めば何でも答えてくれるこっくりさんとかさとるくんでもビビって様子見を決め込むんじゃないか、この状況ッッッ!!!!!!",
        cn: row525Text.replace(/\\n/g, "\n"),
        signature: "sig525",
      },
    ],
  });

  const noteRow525 = [
    "[AI校对]",
    "语义是否相同：不同",
    "是否需要修改：待人工确认",
    "Gatekeeper初审：原文首句「どうすれば良い？」，当前译文「该怎么办？」，建议改为「该怎么办才好？」，后文保留原译。",
    "初审改案：该怎么办？",
    "Stylist复审[采纳]：认同初审意见。",
    "Arbiter仲裁[复审方案]：采纳复审方案。",
    "分析：模型给出的修改结果丢失了目标列的 EPUB noteref 注释标记（目标列 2 个、修改结果 0 个），已作废并转人工确认。",
  ].join("\n");

  const parsed = ui.run(`parseAutomatedNote(${JSON.stringify(noteRow525)}, ${JSON.stringify(row525Text.replace(/\\n/g, "\n"))})`);
  assert.ok(parsed, "解析 note 成功");
  assert.equal(parsed.stage1Revision, "该怎么办？", "保留初审的局部建议文本");
  assert.equal(parsed.stage2Revision, "", "采纳局部提议时，复审改案绝不可被填充为 5 字短句");
  assert.equal(parsed.stage3Revision, "", "裁决采纳复审时，仲裁定案绝不可被填充为 5 字短句");
  assert.equal(parsed.revision, "", "整行的修改结果绝不可被 5 字短句覆盖");

  ui.run(`
    notes["525"] = {
      note: ${JSON.stringify(noteRow525)},
      manualDone: false,
    };
  `);

  // revisionTextFor 绝不能返回 5 个字的碎片覆盖整段
  const effectiveRev = ui.run('revisionTextFor(notes["525"])');
  assert.equal(effectiveRev, "", "对于局部修正提议且全量修改已作废的行，revisionTextFor 不得返回短句覆盖整行");

  // renderNoteSummary 生成的编辑框不能填入 5 个字短句
  const summaryHtml = ui.run('renderNoteSummary(notes["525"], "525")');
  assert.equal(summaryHtml.includes('<textarea class="revision-editor" data-revision="525">该怎么办？</textarea>'), false, "编辑框不得被填入 5 字短句");

  // 点击「初审」切换版本时，由于该提议是局部短语，不能直接把整行变成 5 个字
  ui.run('applyStageRevision("525", "1")');
  const afterClickRev = ui.run('notes["525"].revisionText || ""');
  assert.notEqual(afterClickRev, "该怎么办？", "applyStageRevision 不得直接将 5 字局部短语写为整行 revisionText");
});

test("终审维持原译的行不带默认修改结果，被否掉的过程稿不得被写回成品", () => {
  const ui = createWorkbench(undefined, {
    rows: [
      { index: 1, relation: "1:1", jp: "A1", cn: "B1", signature: "sig1" },
      { index: 2, relation: "1:1", jp: "A2", cn: "B2", signature: "sig2" },
    ],
  });

  // 行 1：初审在评语里提了改案，复审驳回、终审维持原译——备注里没有独立的改案行。
  const rejected = [
    "[AI校对]",
    "语义是否相同：不同",
    "是否需要修改：否",
    "Gatekeeper初审：原译增出原文没有的宾语；改为「金钱方面的事情」并保留否定语气。",
    "Stylist复审[驳回]：初审属翻译腔负优化，原译符合中文表达习惯。",
    "Arbiter仲裁[维持原译]：初审改动是反向劣化，维持原译。",
  ].join("\n");
  // 行 2：终审明确采纳初审方案，仍要按阶段传播给出默认修改结果。
  const adopted = [
    "[AI校对]",
    "语义是否相同：不同",
    "是否需要修改：是",
    "Gatekeeper初审：漏译句末断定助动词。",
    "初审改案：初审案2",
    "Stylist复审[采纳]：同意初审判断。",
    "Arbiter仲裁[初审方案]：采纳初审方案。",
  ].join("\n");

  const rejectedParsed = ui.run(`parseAutomatedNote(${JSON.stringify(rejected)})`);
  assert.equal(rejectedParsed.stage1Revision, "金钱方面的事情", "初审过程稿仍可在阶段卡片里回看");
  assert.equal(rejectedParsed.stage2Revision, "", "复审驳回后不得把初审改案回填成复审改案");
  assert.equal(rejectedParsed.stage3Revision, "", "终审维持原译后不得把初审改案回填成仲裁定案");
  assert.equal(rejectedParsed.revision, "", "终审结论是不改的行没有默认修改结果");

  const adoptedParsed = ui.run(`parseAutomatedNote(${JSON.stringify(adopted)})`);
  assert.equal(adoptedParsed.stage3Revision, "初审案2", "终审采纳初审方案时仍按阶段传播");
  assert.equal(adoptedParsed.revision, "初审案2", "被采纳的改案仍是默认修改结果");

  ui.run(`
    notes["1"] = { note: ${JSON.stringify(rejected)}, manualDone: false };
    notes["2"] = { note: ${JSON.stringify(adopted)}, manualDone: false };
  `);
  assert.equal(ui.run('revisionTextFor(notes["1"])'), "", "不改行不得带默认修改结果");
  assert.equal(ui.run('revisionTextFor(notes["2"])'), "初审案2");

  // 修改结果区整块不渲染：过程稿只能留在阶段卡片里，不能进待写回文本，也不给「写回」按钮。
  const summary = ui.run('renderNoteSummary(notes["1"], "1")');
  assert.equal(summary.includes('class="note-detail note-revision"'), false, "不改行不得渲染修改结果区");
  assert.equal(summary.includes("data-writeback-revision"), false, "不改行不得给出单行写回按钮");
  assert.match(summary, /仲裁·维持原译/);
});

test("存量备注迁移：不改行自动推导的修改结果在载入时清空，人工内容保留", () => {
  const currentKey = "translation-compare-notes-v7:project:rows";
  const keepNote = [
    "[AI校对]",
    "语义是否相同：不同",
    "是否需要修改：否",
    "Gatekeeper初审：原译增出原文没有的宾语；改为「金钱方面的事情」并保留否定语气。",
    "Stylist复审[驳回]：初审属翻译腔负优化。",
    "Arbiter仲裁[维持原译]：维持原译。",
  ].join("\n");
  const storage = storageFixture({
    [currentKey]: JSON.stringify({
      1: { note: keepNote, revisionText: "金钱方面的事情", revisionTarget: "cn", aiDone: true, manualDone: false, rowSig: "sig-1" },
      2: { note: keepNote, revisionText: "人工自己写的结果。", revisionTarget: "cn", aiDone: true, manualDone: false, rowSig: "sig-2" },
      3: { note: keepNote, revisionText: "金钱方面的事情", revisionTarget: "cn", revisionStageActive: "1", aiDone: true, manualDone: false, rowSig: "sig-3" },
    }),
  });
  const ui = createWorkbench(storage, {
    rows: [
      { index: 1, jp: "A1", cn: "B1", relation: "1:1", score: 0.9, signature: "sig-1" },
      { index: 2, jp: "A2", cn: "B2", relation: "1:1", score: 0.9, signature: "sig-2" },
      { index: 3, jp: "A3", cn: "B3", relation: "1:1", score: 0.9, signature: "sig-3" },
    ],
  });

  assert.equal(ui.run('notes["1"].revisionText'), "", "自动推导的过程稿在载入时清掉");
  assert.equal(ui.run('revisionTextFor(notes["1"])'), "");
  assert.equal(ui.run('revisionTextFor(notes["2"])'), "人工自己写的结果。", "人工自己写的文本保留");
  assert.equal(ui.run('revisionTextFor(notes["3"])'), "金钱方面的事情", "显式切换过版本的选择保留");
});

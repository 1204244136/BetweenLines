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

test("parseAutomatedNote extracts stage-specific revisions and supports legacy inference", () => {
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

test("renderNoteSummary and renderDiffBlock visualize step progression and version switcher", async () => {
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

  // 2. 检查审核轨迹卡片与版本切换器（renderNoteSummary）：精简轻量，消除重复分析栏
  const summaryHtml = ui.run(`renderNoteSummary(notes["2"], "2")`);
  assert.match(summaryHtml, /初审改案:/);
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

test("multi-stage rows without explicit stage1Revision still render version buttons and open step progression", () => {
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

test("deletion/addition intent does not misinterpret deleted words as stage1Revision", () => {
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

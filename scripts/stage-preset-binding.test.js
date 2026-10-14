const test = require("node:test");
const assert = require("node:assert/strict");
const { makeHtml } = require("./build-compare");
const { createWorkbench, storageFixture, toastMessages } = require("./workbench-fixture");
const { createPresetTools } = require("../src/workbenches/translation-compare/ai-presets");

test("工作台构建：在阶段卡片内渲染预设选择下拉框", () => {
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

  // 验证上方冗杂的绑定区域已被移除
  assert.equal(html.includes('id="aiStageBindingBox"'), false, "上方的审核编排冗杂区域已移除");

  // 验证选择器直接位于各卡片内部
  assert.match(html, /id="stage1PresetSelect"/);
  assert.match(html, /id="stage2PresetSelect"/);
  assert.match(html, /id="stage3PresetSelect"/);
});

test("客户端阶段预设绑定：级联激活与 AI 配置组装", async () => {
  const presetTools = createPresetTools();
  const ui = createWorkbench();

  // Seed two presets
  ui.storage.setItem("translation-compare-ai-presets-v2", JSON.stringify([
    {
      id: "preset_claude",
      name: "Claude 文学润色",
      protocol: "claude",
      baseUrl: "https://api.anthropic.com",
      model: "claude-3-7-sonnet",
      apiKey: "sk-claude",
    },
    {
      id: "preset_r1",
      name: "DeepSeek 推理仲裁",
      protocol: "compatible",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-reasoner",
      apiKey: "sk-deepseek",
    },
  ]));

  // Re-initialize workbench with saved presets
  ui.run("restoreAiConfig()");

  const s1Select = ui.element("stage1PresetSelect");
  const s2Select = ui.element("stage2PresetSelect");
  const s3Select = ui.element("stage3PresetSelect");

  assert.ok(s1Select);
  assert.ok(s2Select);
  assert.ok(s3Select);

  // 1. 默认状态：Stage 2 未启用，Stage 3 必须为 disabled
  assert.equal(s2Select.value, "");
  assert.equal(s3Select.disabled, true);

  // 初始时未启用 Stage 2，aiConfig() 为经典单阶段模式
  let config = ui.run("aiConfig()");
  assert.equal(config.multiStageEnabled, false);
  assert.equal(config.challengerEnabled, false);
  assert.equal(config.stylistConfig, null);
  assert.equal(config.arbiterConfig, null);

  // 2. 启用 Stage 2（选择 Claude）
  s2Select.value = "preset_claude";
  await s2Select.dispatch("change");

  // Stage 3 应该被解禁
  assert.equal(s3Select.disabled, false);

  config = ui.run("aiConfig()");
  assert.equal(config.multiStageEnabled, true);
  assert.equal(config.challengerEnabled, true);
  assert.ok(config.stylistConfig);
  assert.equal(config.stylistConfig.model, "claude-3-7-sonnet");
  assert.equal(config.arbiterConfig, null);
  assert.equal(config.arbiterEnabled, false); // Stage 3 尚未选预设，不启用仲裁

  // 3. 启用 Stage 3（选择 DeepSeek R1）
  s3Select.value = "preset_r1";
  await s3Select.dispatch("change");

  config = ui.run("aiConfig()");
  assert.equal(config.arbiterEnabled, true);
  assert.ok(config.arbiterConfig);
  assert.equal(config.arbiterConfig.model, "deepseek-reasoner");

  // 4. 重置 Stage 2 为未启用：Stage 3 必须自动重置并锁回 disabled
  s2Select.value = "";
  await s2Select.dispatch("change");

  assert.equal(s3Select.value, "");
  assert.equal(s3Select.disabled, true);

  config = ui.run("aiConfig()");
  assert.equal(config.multiStageEnabled, false);
  assert.equal(config.stylistConfig, null);
  assert.equal(config.arbiterConfig, null);
});

test("阶段多预设下拉栏：收纳适用预设并遵从当前并发数/当前并发上限/触顶规则", async () => {
  const ui = createWorkbench();

  // 写入 3 个模型预设
  ui.storage.setItem("translation-compare-ai-presets-v2", JSON.stringify([
    { id: "p1", name: "词元聚合", protocol: "compatible", model: "v3", concurrency: 4 },
    { id: "p2", name: "火山方舟", protocol: "compatible", model: "doubao", concurrency: 8 },
    { id: "p3", name: "WorkBud", protocol: "compatible", model: "claude", concurrency: 32 },
  ]));

  ui.run("restoreAiConfig()");

  const s1Dropdown = ui.element("stage1AppliedDropdown");
  const s1Trigger = ui.element("stage1AppliedTrigger");
  const s1Value = ui.element("stage1AppliedValue");
  const s1Menu = ui.element("stage1AppliedMenu");
  const s1Tags = ui.element("stage1PresetTags");
  const s1Select = ui.element("stage1PresetSelect");
  const s1Add = ui.element("stage1PresetAdd");

  assert.ok(s1Dropdown, "阶段一适用预设下拉栏存在");
  assert.ok(s1Trigger, "阶段一适用预设 Trigger 存在");
  assert.ok(s1Value, "阶段一适用预设文本展示存在");
  assert.ok(s1Menu, "阶段一适用预设浮层菜单存在");
  assert.equal(s1Menu.hidden, true, "菜单默认收起");

  // 1. 默认无预设时：阶段一显示「适用：主配置」
  assert.equal(s1Value.textContent, "适用：主配置");

  // 2. 点击 Trigger 展开下拉菜单，再次点击收起
  s1Trigger.click();
  assert.equal(s1Menu.hidden, false, "点击 Trigger 展开适用预设菜单");
  assert.equal(s1Trigger.getAttribute("aria-expanded"), "true");

  s1Trigger.click();
  assert.equal(s1Menu.hidden, true, "再次点击 Trigger 收起适用预设菜单");
  assert.equal(s1Trigger.getAttribute("aria-expanded"), "false");

  // 3. 依次添加 3 个预设到阶段一
  s1Select.value = "p1";
  s1Add.click();
  assert.match(s1Value.textContent, /适用：.*词元聚合/);

  s1Select.value = "p2";
  s1Add.click();
  assert.equal(s1Value.textContent, "适用 (2)");

  s1Select.value = "p3";
  s1Add.click();
  // 3 个预设被收纳进下拉栏中，标题为「适用 (3)」，头部保持整洁
  assert.equal(s1Value.textContent, "适用 (3)");
  assert.equal(s1Tags.children.length, 3, "下拉菜单内包含 3 个预设条目");

  // 4. 并发信息展示规则：未运行时，额定并发上限 32 不展示
  const tag1 = s1Tags.children[0];
  const tag2 = s1Tags.children[1];
  const tag3 = s1Tags.children[2];
  assert.equal(tag1.children[1].textContent, "", "未运行时不显示「并发上限 4」占位");
  assert.match(tag1.children[1].title, /额定并发上限 4/);
  assert.equal(tag3.children[1].textContent, "", "未运行时不显示「并发上限 32」占位");
  assert.match(tag3.children[1].title, /额定并发上限 32/);

  // 5. 运行状态下：展示「当前并发数/当前并发上限」，触顶时提示「触顶」
  ui.run(`
    latestPresetPipelines = {
      stage1: [
        { presetId: "p1", inFlight: 2, quota: 3, configuredConcurrency: 4, pending: 5, activeRows: [10, 11] },
        { presetId: "p2", inFlight: 8, quota: 8, configuredConcurrency: 8, pending: 1, activeRows: [12] },
        { presetId: "p3", inFlight: 0, quota: 16, configuredConcurrency: 32, pending: 0, activeRows: [] },
      ]
    };
    renderStagePresetSelection("stage1");
  `);

  const activeTag1 = s1Tags.children[0];
  const activeTag2 = s1Tags.children[1];
  const activeTag3 = s1Tags.children[2];

  // p1: 运行 2，配额 3，未触顶（2 < 4）
  assert.equal(activeTag1.children[1].textContent, "运行 2 · 当前配额 3 · 配置上限 4 · 排队 5");
  assert.match(activeTag1.children[1].title, /当前运行 2 \/ 动态配额 3 \/ 配置并发上限 4 \/ 待派发 5/);

  // p2: 运行 8，配额 8，额定上限 8，已触顶（8 >= 8）
  assert.equal(activeTag2.children[1].textContent, "运行 8 · 当前配额 8 · 配置上限 8 · 触顶 · 排队 1");
  assert.match(activeTag2.children[1].title, /已触顶/);

  // Trigger 汇总显示：inFlight=2+8+0=10, quota=3+8+16=27，只有 p2 顶到了自己的配置上限 8
  assert.equal(s1Value.textContent, "适用 (3)", "触顶要精确到「几个预设触顶」");
  assert.equal(s1Value.classList.contains("is-part-topped"), false, "部分触顶给警示色");
  assert.equal(s1Value.classList.contains("is-all-topped"), false);
  // 悬停里说清是哪一个触顶，而不是只给一个数字
  assert.match(s1Trigger.title, /1\. [^\n]*词元聚合[^\n]*运行 2，当前配额 3，配置上限 4/);
  assert.match(s1Trigger.title, /2\. [^\n]*火山方舟[^\n]*运行 8，当前配额 8，配置上限 8 · 已触顶/);
  assert.match(s1Trigger.title, /已触顶 1\/3 个预设/);

  // 6. 全部预设都顶到各自上限：换成「全部触顶」并加粗强调
  ui.run(`
    latestPresetPipelines = {
      stage1: [
        { presetId: "p1", inFlight: 4, quota: 4, configuredConcurrency: 4, pending: 0, activeRows: [10] },
        { presetId: "p2", inFlight: 8, quota: 8, configuredConcurrency: 8, pending: 0, activeRows: [11] },
        { presetId: "p3", inFlight: 32, quota: 32, configuredConcurrency: 32, pending: 0, activeRows: [12] },
      ]
    };
    renderStagePresetSelection("stage1");
  `);
  assert.equal(s1Value.textContent, "适用 (3)");
  assert.equal(s1Value.classList.contains("is-all-topped"), false, "全部触顶才用更强的一档");
  assert.equal(s1Value.classList.contains("is-part-topped"), false);
  assert.match(s1Trigger.title, /已触顶 3\/3 个预设（全部触顶）/);

  // 7. 服务端回报 topped 字段时以它为准（不再由页面重算触顶口径）
  ui.run(`
    latestPresetPipelines = {
      stage1: [
        { presetId: "p1", inFlight: 1, quota: 4, configuredConcurrency: 4, topped: true, pending: 0, activeRows: [10] },
        { presetId: "p2", inFlight: 8, quota: 8, configuredConcurrency: 8, topped: false, pending: 0, activeRows: [11] },
        { presetId: "p3", inFlight: 0, quota: 32, configuredConcurrency: 32, topped: false, pending: 0, activeRows: [] },
      ]
    };
    renderStagePresetSelection("stage1");
  `);
  assert.equal(s1Value.textContent, "适用 (3)", "服务端的 topped 字段优先于页面的 inFlight 比较");
  assert.equal(s1Tags.children[0].children[1].textContent, "运行 1 · 当前配额 4 · 配置上限 4 · 触顶");

  // 8. 停止运行后不能残留触顶样式
  ui.run(`
    latestPresetPipelines = {
      stage1: [
        { presetId: "p1", inFlight: 0, quota: 4, configuredConcurrency: 4, pending: 0, activeRows: [] },
        { presetId: "p2", inFlight: 0, quota: 8, configuredConcurrency: 8, pending: 0, activeRows: [] },
        { presetId: "p3", inFlight: 0, quota: 32, configuredConcurrency: 32, pending: 0, activeRows: [] },
      ]
    };
    renderStagePresetSelection("stage1");
  `);
  assert.equal(s1Value.textContent, "适用 (3)");
  assert.equal(s1Value.classList.contains("is-all-topped"), false, "停下后必须清掉上一轮的触顶样式");
  assert.equal(s1Value.classList.contains("is-part-topped"), false);

  // 9. 移除预设：点击 p3 的删除按钮
  const removeBtn3 = s1Tags.children[2].children[2];
  removeBtn3.click();
  assert.match(s1Value.textContent, /适用 \(2\)/);
  assert.equal(s1Tags.children.length, 2, "移除后菜单内剩余 2 个条目");

  // 10. 只剩一个预设时不写「1/1 触顶」，沿用原来的「触顶」
  s1Tags.children[1].children[2].click();
  assert.equal(s1Tags.children.length, 1);
  ui.run(`
    latestPresetPipelines = {
      stage1: [{ presetId: "p1", inFlight: 4, quota: 4, configuredConcurrency: 4, pending: 2, activeRows: [10] }]
    };
    renderStagePresetSelection("stage1");
  `);
  assert.match(s1Value.textContent, /适用：.*词元聚合/, "单个预设不写「1/1 触顶」");
  assert.equal(s1Value.classList.contains("is-all-topped"), false);
});

test("阶段多预设热更新：运行中增删立刻同步给服务端，未运行时留给下次启动", async () => {
  const ui = createWorkbench(storageFixture({
    "translation-compare-ai-presets-v2": JSON.stringify([
      { id: "p1", name: "甲", protocol: "compatible", baseUrl: "https://a.example/v1", model: "m1", apiKey: "k1", concurrency: 2 },
      { id: "p2", name: "乙", protocol: "compatible", baseUrl: "https://b.example/v1", model: "m2", apiKey: "k2", concurrency: 2 },
    ]),
  }), {
    apiResponses: {
      "/api/ai-proofread/presets": { ok: true, stage: "stage1", added: ["p2"], removed: ["p3"], fallback: false },
    },
  });
  ui.run("restoreAiConfig();");
  ui.run('stagePresetSelections.stage1 = ["p1", "p2"]; renderStagePresetSelection("stage1");');

  const syncPosts = () => ui.posts.filter((post) => post.url === "/api/ai-proofread/presets");
  const removeButtons = () => ui.element("stage1PresetTags").children.map((tag) => tag.children[2]);

  // 未运行：改动只落本地配置，不打扰服务端。
  removeButtons()[1].click();
  await ui.settle();
  assert.equal(syncPosts().length, 0, "任务没在跑时不该发起同步请求");
  assert.deepEqual([...ui.run("stagePresetSelections.stage1")], ["p1"]);

  // 运行中删除：立刻同步，服务端据此把该预设的待审行改派给其余预设。
  ui.run('stagePresetSelections.stage1 = ["p1", "p2"]; renderStagePresetSelection("stage1");');
  ui.run("currentAiRunning = true;");
  removeButtons()[1].click();
  await ui.settle();
  assert.equal(syncPosts().length, 1, "运行中删预设必须立刻同步");
  assert.equal(syncPosts()[0].body.stage, "stage1");
  assert.deepEqual(syncPosts()[0].body.presets.map((item) => item.presetId), ["p1"]);
  assert.match(toastMessages(ui).join("|"), /阶段一预设已即时生效/, "同步结果要给回执");

  // 运行中加入：同样立刻同步，新预设马上参与派发。
  ui.run('aiIds.stage1Preset.value = "p2";');
  ui.element("stage1PresetAdd").click();
  await ui.settle();
  assert.equal(syncPosts().length, 2, "运行中加预设必须立刻同步");
  assert.deepEqual(syncPosts()[1].body.presets.map((item) => item.presetId), ["p1", "p2"]);
});

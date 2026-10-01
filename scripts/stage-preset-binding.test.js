const test = require("node:test");
const assert = require("node:assert/strict");
const { makeHtml } = require("./build-compare");
const { createWorkbench } = require("./workbench-fixture");
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

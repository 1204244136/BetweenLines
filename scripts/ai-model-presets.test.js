const assert = require("node:assert/strict");
const test = require("node:test");
const { createPresetTools } = require("../src/workbenches/translation-compare/ai-presets");
const { createWorkbench, storageFixture, toastMessages } = require("./workbench-fixture");

test("模型预设：listPresets 容错处理空值、畸形与非数组存储", () => {
  const tools = createPresetTools();
  const storage = storageFixture();

  assert.deepEqual(tools.listPresets(storage), []);
  assert.deepEqual(tools.listPresets(null), []);

  storage.setItem(tools.storageKey, "invalid-json{");
  assert.deepEqual(tools.listPresets(storage), []);

  storage.setItem(tools.storageKey, JSON.stringify({ not: "an array" }));
  assert.deepEqual(tools.listPresets(storage), []);

  storage.setItem(tools.storageKey, JSON.stringify([null, 123, "string", {}]));
  assert.deepEqual(tools.listPresets(storage), []);
});

test("模型预设：sanitizePreset 校验清洗所有字段并提供安全回退", () => {
  const tools = createPresetTools();

  assert.equal(tools.sanitizePreset(null), null);
  assert.equal(tools.sanitizePreset({}), null);
  assert.equal(tools.sanitizePreset({ name: "   " }), null);

  const cleaned = tools.sanitizePreset({
    name: " DeepSeek-V3 ",
    provider: "unknown-provider",
    baseUrl: "  https://api.example.com/v1  ",
    apiKey: "sk-secret-key",
    model: "  deepseek-chat ",
    modelOptions: ["deepseek-chat", "deepseek-reasoner", "", 123],
    reasoningEffort: "high",
    gptReasoningEffort: "medium",
    nonGptIntensity: "high",
    concurrency: 99,
    breakerThreshold: " 40% ",
    breakerDisabled: true,
  });

  assert.equal(cleaned.name, "DeepSeek-V3");
  assert.equal(cleaned.provider, "local"); // 非法 provider 回退为 local
  assert.equal(cleaned.baseUrl, "https://api.example.com/v1");
  assert.equal(cleaned.apiKey, "sk-secret-key");
  assert.equal(cleaned.model, "deepseek-chat");
  assert.deepEqual(cleaned.modelOptions, ["deepseek-chat", "deepseek-reasoner", "123"]);
  assert.equal(cleaned.concurrency, 32); // 99 超出 1~32 截断为上限，不再回落到 3
  assert.equal(cleaned.breakerThreshold, "40%");
  assert.equal(cleaned.breakerDisabled, true);
  assert.ok(cleaned.id.startsWith("preset_"));
  assert.ok(cleaned.createdAt > 0);
  assert.ok(cleaned.updatedAt > 0);
});

test("模型预设：savePreset 保存新预设并支持按 ID 查询", () => {
  const tools = createPresetTools();
  const storage = storageFixture();

  const preset1 = tools.savePreset(storage, {
    name: "本地 Qwen2.5",
    provider: "local",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen2.5:32b",
    concurrency: 1,
  });

  assert.ok(preset1);
  assert.equal(preset1.name, "本地 Qwen2.5");
  assert.equal(preset1.concurrency, 1);

  const list = tools.listPresets(storage);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, preset1.id);

  const found = tools.getPreset(storage, preset1.id);
  assert.deepEqual(found, preset1);
});

test("模型预设：savePreset 更新已有预设并保留原始创建时间", () => {
  const tools = createPresetTools();
  const storage = storageFixture();

  const original = tools.savePreset(storage, {
    name: "SiliconFlow R1",
    provider: "compatible",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "deepseek-ai/DeepSeek-R1",
    concurrency: 4,
    createdAt: 100000,
  });

  const updated = tools.savePreset(storage, {
    id: original.id,
    name: "SiliconFlow R1 (更新)",
    provider: "compatible",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "deepseek-ai/DeepSeek-R1",
    concurrency: 6,
  });

  assert.equal(updated.id, original.id);
  assert.equal(updated.name, "SiliconFlow R1 (更新)");
  assert.equal(updated.concurrency, 6);
  assert.equal(updated.createdAt, original.createdAt);
  assert.ok(updated.updatedAt >= original.updatedAt);

  const list = tools.listPresets(storage);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "SiliconFlow R1 (更新)");
});

test("模型预设：savePreset 在名称相同时覆盖已有预设", () => {
  const tools = createPresetTools();
  const storage = storageFixture();

  const first = tools.savePreset(storage, {
    name: "Claude 3.7",
    provider: "claude",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-3-7-sonnet-20250219",
    concurrency: 2,
  });

  const second = tools.savePreset(storage, {
    name: "Claude 3.7",
    provider: "claude",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-3-7-sonnet-20250219",
    concurrency: 5,
  });

  assert.equal(second.id, first.id);
  assert.equal(second.concurrency, 5);

  const list = tools.listPresets(storage);
  assert.equal(list.length, 1);
  assert.equal(list[0].concurrency, 5);
});

test("模型预设：deletePreset 安全删除指定目标预设", () => {
  const tools = createPresetTools();
  const storage = storageFixture();

  const p1 = tools.savePreset(storage, { name: "P1", model: "m1" });
  const p2 = tools.savePreset(storage, { name: "P2", model: "m2" });

  assert.equal(tools.listPresets(storage).length, 2);

  assert.equal(tools.deletePreset(storage, "non-existent-id"), false);
  assert.equal(tools.listPresets(storage).length, 2);

  assert.equal(tools.deletePreset(storage, p1.id), true);
  const remaining = tools.listPresets(storage);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, p2.id);
  assert.equal(tools.getPreset(storage, p1.id), null);
});

test("模型预设：优雅处理存储配额超额错误", () => {
  const tools = createPresetTools();
  const storage = storageFixture();
  storage.failWrites = true;

  assert.equal(tools.savePreset(storage, { name: "Test" }), null);
  assert.equal(tools.deletePreset(storage, "some-id"), false);
});

test("模型预设界面：渲染预设控件并在下拉框中呈现已存预设", async () => {
  const tools = createPresetTools();
  const storage = storageFixture();
  tools.savePreset(storage, {
    name: "DeepSeek V3 (测试)",
    provider: "compatible",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    concurrency: 5,
  });

  const ui = createWorkbench(storage);
  const select = ui.element("aiPresetSelect");
  const saveBtn = ui.element("aiPresetSave");
  const saveAsBtn = ui.element("aiPresetSaveAs");
  const deleteBtn = ui.element("aiPresetDelete");

  assert.ok(select, "aiPresetSelect exists");
  assert.ok(saveBtn, "aiPresetSave exists");
  assert.ok(saveAsBtn, "aiPresetSaveAs exists");
  assert.ok(deleteBtn, "aiPresetDelete exists");

  // 初始未选中预设
  assert.equal(select.value, "");
  assert.equal(saveBtn.disabled, true);
  assert.equal(deleteBtn.disabled, true);
  assert.equal(saveAsBtn.disabled, false);

  // 下拉列表包含默认选项和存储的预设
  assert.equal(select.children.length, 2);
  assert.equal(select.children[0].textContent, "-- 自定义 / 未选择预设 --");
  assert.equal(select.children[1].textContent, "DeepSeek V3 (测试)");
});

test("模型预设界面：选择预设时更新表单字段、启用操作按钮并弹出提示", async () => {
  const tools = createPresetTools();
  const storage = storageFixture();
  const p = tools.savePreset(storage, {
    name: "Claude 3.7",
    provider: "claude",
    baseUrl: "https://api.anthropic.com/v1",
    apiKey: "sk-ant-123",
    model: "claude-3-7-sonnet-20250219",
    concurrency: 2,
  });

  const ui = createWorkbench(storage);
  const select = ui.element("aiPresetSelect");
  const saveBtn = ui.element("aiPresetSave");
  const deleteBtn = ui.element("aiPresetDelete");

  select.value = p.id;
  await select.dispatch("change");

  // 检查字段被正确填充
  assert.equal(ui.element("aiProvider").value, "claude");
  assert.equal(ui.element("aiBaseUrl").value, "https://api.anthropic.com/v1");
  assert.equal(ui.element("aiApiKey").value, "sk-ant-123");
  assert.equal(ui.element("aiModel").value, "claude-3-7-sonnet-20250219");
  assert.equal(ui.element("aiConcurrency").value, 2);

  // 按钮变为启用
  assert.equal(saveBtn.disabled, false);
  assert.equal(deleteBtn.disabled, false);

  // Toast 提示已应用预设
  const toasts = toastMessages(ui);
  assert.ok(toasts.some((msg) => msg.includes("已应用模型预设「Claude 3.7」")));
});

test("模型预设界面：另存为预设创建新预设并自动选中", async () => {
  const storage = storageFixture();
  const ui = createWorkbench(storage, {
    prompt: () => "我的新模型预设",
  });

  ui.element("aiProvider").value = "compatible";
  ui.element("aiBaseUrl").value = "https://api.my-service.com/v1";
  ui.element("aiApiKey").value = "my-key-456";
  ui.element("aiModel").value = "custom-model";
  ui.element("aiConcurrency").value = 4;

  const saveAsBtn = ui.element("aiPresetSaveAs");
  await saveAsBtn.dispatch("click");

  const select = ui.element("aiPresetSelect");
  assert.notEqual(select.value, "");
  assert.equal(ui.element("aiPresetSave").disabled, false);
  assert.equal(ui.element("aiPresetDelete").disabled, false);

  const tools = createPresetTools();
  const presets = tools.listPresets(storage);
  assert.equal(presets.length, 1);
  assert.equal(presets[0].name, "我的新模型预设");
  assert.equal(presets[0].baseUrl, "https://api.my-service.com/v1");
  assert.equal(presets[0].apiKey, "my-key-456");
  assert.equal(presets[0].model, "custom-model");
  assert.equal(presets[0].concurrency, 4);

  const toasts = toastMessages(ui);
  assert.ok(toasts.some((msg) => msg.includes("已保存模型预设「我的新模型预设」")));
});

test("模型预设界面：修改预设更新存储中的已有配置", async () => {
  const tools = createPresetTools();
  const storage = storageFixture();
  const p = tools.savePreset(storage, {
    name: "本地 Ollama",
    provider: "local",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen2.5:14b",
    concurrency: 2,
  });

  const ui = createWorkbench(storage, {
    confirm: () => true,
  });

  const select = ui.element("aiPresetSelect");
  select.value = p.id;
  await select.dispatch("change");

  // 用户调整了模型和并发
  ui.element("aiModel").value = "qwen2.5:32b";
  ui.element("aiConcurrency").value = 1;

  const saveBtn = ui.element("aiPresetSave");
  await saveBtn.dispatch("click");

  // 检查 storage 已更新
  const updated = tools.getPreset(storage, p.id);
  assert.equal(updated.model, "qwen2.5:32b");
  assert.equal(updated.concurrency, 1);

  const toasts = toastMessages(ui);
  assert.ok(toasts.some((msg) => msg.includes("已更新模型预设「本地 Ollama」")));
});

test("模型预设界面：删除预设从存储中移除并重置下拉选择", async () => {
  const tools = createPresetTools();
  const storage = storageFixture();
  const p = tools.savePreset(storage, {
    name: "待删预设",
    model: "temp",
  });

  const ui = createWorkbench(storage, {
    confirm: () => true,
  });

  const select = ui.element("aiPresetSelect");
  select.value = p.id;
  await select.dispatch("change");

  const deleteBtn = ui.element("aiPresetDelete");
  await deleteBtn.dispatch("click");

  // storage 中已删除
  assert.equal(tools.listPresets(storage).length, 0);
  assert.equal(select.value, "");
  assert.equal(ui.element("aiPresetSave").disabled, true);
  assert.equal(ui.element("aiPresetDelete").disabled, true);

  const toasts = toastMessages(ui);
  assert.ok(toasts.some((msg) => msg.includes("已删除模型预设「待删预设」")));
});

test("模型预设界面：页面初始化时自动恢复先前激活的预设", async () => {
  const tools = createPresetTools();
  const storage = storageFixture();
  const p = tools.savePreset(storage, {
    name: "默认预设",
    provider: "compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o",
    concurrency: 3,
  });

  // 存入 aiConfigStorageKey 中已选中的 currentPresetId
  storage.setItem("translation-compare-ai-config-v1", JSON.stringify({
    currentPresetId: p.id,
    provider: "compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o",
  }));

  const ui = createWorkbench(storage);
  const select = ui.element("aiPresetSelect");
  assert.equal(select.value, p.id);
  assert.equal(ui.element("aiPresetSave").disabled, false);
  assert.equal(ui.element("aiPresetDelete").disabled, false);
});

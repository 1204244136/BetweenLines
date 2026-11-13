const assert = require("node:assert/strict");
const test = require("node:test");
const { inferProtocolFromBaseUrl, normalizeConnectionConfig } = require("../src/ai/connection-config");
const { createPresetTools } = require("../src/workbenches/translation-compare/ai-presets");
const { cleanConfig, clientStatus } = require("../src/workbenches/translation-compare/ai/ai-proofread");
const { buildProtocolHeaders } = require("../src/ai/llm-client");
const { createWorkbench, storageFixture, toastMessages, addPoolPreset } = require("./workbench-fixture");
const { makeHtml } = require("./build-compare");

const presetTools = createPresetTools();
const preset = (provider, overrides = {}) => ({
  name: "校对", protocol: "compatible", provider, model: "same-model",
  baseUrl: "https://example.test/v1", apiKey: "", ...overrides,
});
const options = (select) => select.children.flatMap((node) => node.tagName === "OPTGROUP" ? node.children : [node]);

test("连接契约：protocol 决定传输，provider 只保留供应商；旧请求明确拒绝", () => {
  assert.deepEqual(normalizeConnectionConfig({ protocol: "compatible", provider: " claude " }), { protocol: "compatible", provider: "claude" });
  assert.throws(() => normalizeConnectionConfig({ provider: "claude" }), { code: "MISSING_PROTOCOL" });
  assert.throws(() => cleanConfig({ provider: "compatible" }), { code: "MISSING_PROTOCOL" });
  const config = cleanConfig(preset("claude", {
    stylistConfig: preset("复审服务", { protocol: "claude" }),
    arbiterConfig: preset("仲裁服务"),
  }));
  assert.equal(config.protocol, "compatible");
  assert.equal(config.provider, "claude");
  assert.equal(config.stylistConfig.protocol, "claude");
  assert.equal(config.stylistConfig.provider, "复审服务");
  assert.equal(config.arbiterConfig.provider, "仲裁服务");
  assert.deepEqual(buildProtocolHeaders({ protocol: "compatible", provider: "claude", apiKey: "test-key" }), {
    "content-type": "application/json", authorization: "Bearer test-key",
  });
  assert.equal(buildProtocolHeaders({ protocol: "claude", provider: "本地服务", apiKey: "test-key" })["x-api-key"], "test-key");
  assert.ok(clientStatus().protocolDefaults);
  assert.equal("providerDefaults" in clientStatus(), false);
});

test("接口类型：按地址自动推断，显式值优先，识别不出才回落调用方默认档", () => {
  const cases = [
    ["http://127.0.0.1:11434/v1", "local"],
    ["localhost:8080", "local"],
    ["http://192.168.1.9:8000/v1", "local"],
    ["http://10.0.0.7/v1", "local"],
    ["http://[::1]:11434/v1", "local"],
    ["http://[fd00::1]:11434/v1", "local"],
    ["https://api.anthropic.com", "claude"],
    ["https://api.anthropic.com/v1", "claude"],
    ["https://claude.ai/api", "claude"],
    ["http://127.0.0.1:8080/v1/messages", "claude"],
    ["https://api.deepseek.com/v1", "compatible"],
    ["https://opencode.ai/inference/go/openai/v1", "compatible"],
    ["", ""],
    ["ftp://example.test", ""],
  ];
  for (const [url, expected] of cases) assert.equal(inferProtocolFromBaseUrl(url).protocol, expected, url);
  // 本机转发 Claude Messages 端点仍按 Claude 协议处理：路径信号优先于回环地址。
  assert.equal(inferProtocolFromBaseUrl("http://127.0.0.1:8080/v1/messages").protocol, "claude");
  assert.equal(normalizeConnectionConfig({ baseUrl: "https://api.deepseek.com" }).protocol, "compatible");
  assert.equal(normalizeConnectionConfig({ baseUrl: "" }, "compatible").protocol, "compatible");
  assert.equal(normalizeConnectionConfig({ protocol: "claude", baseUrl: "https://api.deepseek.com" }).protocol, "claude");
});

test("界面：接口类型不占控件，地址变化直接切换协议，恢复预设也以地址为准", async () => {
  const ui = createWorkbench();
  // 隐藏字段承载协议，页面不出现类型下拉或手动指定入口。
  assert.equal(ui.element("aiProtocol").value, "local");
  assert.equal(ui.html.includes("aiProtocolToggle"), false);
  assert.equal(ui.html.includes("aiProtocolSummary"), false);
  assert.equal(/<select id="aiProtocol"/.test(ui.html), false);

  ui.element("aiBaseUrl").value = "https://api.anthropic.com";
  await ui.element("aiBaseUrl").dispatch("input");
  assert.equal(ui.element("aiProtocol").value, "claude");

  ui.element("aiBaseUrl").value = "https://proxy.example.com/v1";
  await ui.element("aiBaseUrl").dispatch("input");
  assert.equal(ui.element("aiProtocol").value, "compatible");

  ui.element("aiBaseUrl").value = "http://127.0.0.1:3425/v1";
  await ui.element("aiBaseUrl").dispatch("input");
  assert.equal(ui.element("aiProtocol").value, "local");
});

test("提供商预设：相同模型与名称跨供应商独立保存、更新和删除", () => {
  const storage = storageFixture();
  const a = presetTools.savePreset(storage, preset("服务甲"));
  const b = presetTools.savePreset(storage, preset("服务乙"));
  assert.notEqual(a.id, b.id);
  assert.equal(presetTools.listPresets(storage).length, 2);
  const updated = presetTools.savePreset(storage, preset("服务甲", { concurrency: 8 }));
  assert.equal(updated.id, a.id);
  assert.equal(presetTools.getPreset(storage, b.id).concurrency, 3);
  assert.equal(presetTools.savePreset(storage, { ...a, provider: "服务乙" }), null);
  assert.equal(presetTools.deletePreset(storage, a.id), true);
  assert.equal(presetTools.getPreset(storage, b.id).provider, "服务乙");
});

test("未命名提供商按协议和地址区分；显示地址去掉凭证和查询串", () => {
  const storage = storageFixture();
  const a = presetTools.savePreset(storage, preset("", { baseUrl: "https://a.test/v1/" }));
  const b = presetTools.savePreset(storage, preset("", { baseUrl: "https://b.test/v1" }));
  const updated = presetTools.savePreset(storage, preset("", { baseUrl: "https://A.test/v1" }));
  assert.equal(updated.id, a.id);
  assert.notEqual(a.id, b.id);
  assert.equal(presetTools.providerLabel(preset("", { baseUrl: "https://user:secret@a.test/v1?key=secret#secret" })), "https://a.test/v1");
});

test("供应商名称清洗与分组支持相同协议名，不猜测模型所属厂商", () => {
  const a = presetTools.sanitizePreset(preset(" claude "));
  assert.equal(a.protocol, "compatible");
  assert.equal(a.provider, "claude");
  assert.equal(presetTools.providerKey(a), presetTools.providerKey(preset("CLAUDE")));
  assert.equal(presetTools.groupPresets([a, preset("另一家")]).length, 2);
});

test("界面：主配置及共享池显示提供商分组和完整模型标签", () => {
  const storage = storageFixture();
  const a = presetTools.savePreset(storage, preset("服务甲"));
  const b = presetTools.savePreset(storage, preset("服务乙"));
  const ui = createWorkbench(storage);
  for (const id of ["aiPresetSelect", "aiPoolPresetSelect"]) {
    const select = ui.element(id);
    assert.equal(select.children.filter((node) => node.tagName === "OPTGROUP").length, 2);
    assert.equal(options(select).find((item) => item.value === a.id).textContent, "服务甲 / 校对 · same-model");
    assert.equal(options(select).find((item) => item.value === b.id).textContent, "服务乙 / 校对 · same-model");
  }
  assert.deepEqual(Array.from(ui.element("aiProviderNames").children, (item) => item.value), ["服务甲", "服务乙"]);
});

test("界面：保存同名模型到不同提供商不覆盖，切换后刷新仍保留提供商", async () => {
  const storage = storageFixture();
  presetTools.savePreset(storage, preset("服务甲"));
  const ui = createWorkbench(storage, { prompt: () => "校对", confirm: () => { throw new Error("跨供应商不应触发覆盖确认"); } });
  ui.element("aiProtocol").value = "compatible";
  ui.element("aiProvider").value = "服务乙";
  ui.element("aiBaseUrl").value = "https://b.test/v1";
  ui.element("aiModel").value = "same-model";
  await ui.element("aiPresetSaveAs").dispatch("click");
  assert.equal(presetTools.listPresets(storage).length, 2);
  const id = ui.element("aiPresetSelect").value;
  const refreshed = createWorkbench(storage);
  assert.equal(refreshed.element("aiPresetSelect").value, id);
  assert.equal(refreshed.element("aiProvider").value, "服务乙");
  assert.equal(refreshed.element("aiProtocol").value, "compatible");
});

test("阶段请求：同名模型取各自协议、供应商、地址与 Key，空值不串用主配置", async () => {
  const storage = storageFixture();
  const a = presetTools.savePreset(storage, preset("服务甲", { reasoningEffort: "" }));
  const b = presetTools.savePreset(storage, preset("服务乙", { protocol: "claude", baseUrl: "https://b.test", apiKey: "key-b" }));
  const c = presetTools.savePreset(storage, preset("服务丙", { baseUrl: "https://c.test", apiKey: "key-c" }));
  const ui = createWorkbench(storage);
  ui.element("aiApiKey").value = "main-key";
  ui.element("aiReasoningEffort").value = "high";
  addPoolPreset(ui, a.id, ["stage1"]);
  addPoolPreset(ui, b.id, ["stage2"]);
  addPoolPreset(ui, c.id, ["stage3"]);
  const config = ui.run("aiConfig()");
  const [initial, review, arbiter] = config.presetPool;
  assert.equal(initial.protocol, "compatible");
  assert.equal(initial.provider, "服务甲");
  assert.equal(initial.apiKey, "");
  assert.equal(initial.reasoningEffort, "");
  assert.equal(review.protocol, "claude");
  assert.equal(review.provider, "服务乙");
  assert.equal(review.apiKey, "key-b");
  assert.equal(arbiter.provider, "服务丙");
  assert.equal(arbiter.baseUrl, "https://c.test");
  assert.equal(arbiter.apiKey, "key-c");
});

test("保存修改后更换提供商保持 ID 与阶段绑定；冲突时保留双方", async () => {
  const storage = storageFixture();
  const a = presetTools.savePreset(storage, preset("服务甲"));
  const b = presetTools.savePreset(storage, preset("服务乙"));
  const ui = createWorkbench(storage);
  ui.element("aiPresetSelect").value = a.id;
  await ui.element("aiPresetSelect").dispatch("change");
  addPoolPreset(ui, a.id, ["stage2"]);
  addPoolPreset(ui, b.id, ["stage3"]);
  ui.element("aiProvider").value = "服务乙";
  await ui.element("aiPresetSave").dispatch("click");
  assert.equal(presetTools.getPreset(storage, a.id).provider, "服务甲");
  assert.ok(toastMessages(ui).some((message) => message.includes("已有同名预设")));
  ui.element("aiProvider").value = "服务丙";
  await ui.element("aiPresetSave").dispatch("click");
  assert.equal(presetTools.getPreset(storage, a.id).provider, "服务丙");
  assert.deepEqual([...ui.run('committedStagePresetIds("stage2")')], [a.id]);
  assert.deepEqual([...ui.run('committedStagePresetIds("stage3")')], [b.id]);
  const refreshed = createWorkbench(storage);
  assert.equal(refreshed.element("aiProvider").value, "服务丙");
  assert.deepEqual([...refreshed.run('committedStagePresetIds("stage2")')], [a.id]);
});

test("切换提供商预设后丢弃另一供应商同名模型的能力缓存", async () => {
  const storage = storageFixture();
  const b = presetTools.savePreset(storage, preset("服务乙"));
  const ui = createWorkbench(storage);
  ui.run('setModelOptions([{id:"same-model", reasoning:true, reasoningEfforts:["max"]}])');
  assert.equal(ui.run('getClientModelCapabilities("same-model").reasoning'), true);
  ui.element("aiPresetSelect").value = b.id;
  await ui.element("aiPresetSelect").dispatch("change");
  assert.equal(ui.run('aiModelMetadataMap.has("same-model")'), false);
});

test("应用预设保留手填模型，默认推理强度不沿用前一个预设", async () => {
  const storage = storageFixture();
  const saved = presetTools.savePreset(storage, preset("服务乙", { model: "gpt-test", modelOptions: ["other-model"], reasoningEffort: "" }));
  const ui = createWorkbench(storage);
  ui.element("aiReasoningEffort").value = "high";
  ui.element("aiPresetSelect").value = saved.id;
  await ui.element("aiPresetSelect").dispatch("change");
  assert.equal(ui.element("aiModel").value, "gpt-test");
  assert.equal(ui.element("aiReasoningEffort").value, "");
});

test("提供商或账号切换时忽略尚未返回的旧模型列表与连通性结果", async () => {
  for (const field of ["provider", "apiKey"]) {
    for (const action of ["refreshAiModels", "testAiModel"]) {
      const ui = createWorkbench();
      ui.element("aiProtocol").value = "compatible";
      ui.element("aiProvider").value = "服务甲";
      ui.element("aiApiKey").value = "key-a";
      ui.element("aiBaseUrl").value = "https://example.test/v1";
      ui.run('setModelOptions(["same-model"])');
      ui.run(`fetch = async () => {
        aiIds.${field}.value = "changed";
        return { ok: true, json: async () => ({ ok: true, models: [{ id: "old-response-model" }], model: "same-model", latencyMs: 1 }) };
      }`);
      await ui.run(action + "()");
      assert.equal(ui.element("aiModel").value, "same-model");
      assert.ok(toastMessages(ui).some((message) => message.includes("已忽略")), field + "/" + action);
    }
  }
});

test("界面模型查询和连通性请求携带分离的 protocol 与 provider", async () => {
  const ui = createWorkbench(undefined, { apiResponses: {
    "/api/ai-proofread/models": { ok: true, models: [{ id: "same-model" }] },
    "/api/ai-proofread/test": { ok: true, model: "same-model", latencyMs: 1 },
  } });
  ui.element("aiProtocol").value = "compatible";
  ui.element("aiProvider").value = "服务甲";
  ui.element("aiBaseUrl").value = "https://example.test";
  ui.element("aiApiKey").value = "key-a";
  await ui.run("refreshAiModels()");
  await ui.run("testAiModel()");
  const posts = ui.posts.filter((post) => /ai-proofread\/(models|test)$/.test(post.url));
  assert.equal(posts.length, 2);
  for (const post of posts) {
    assert.equal(post.body.protocol, "compatible");
    assert.equal(post.body.provider, "服务甲");
    assert.equal(post.body.apiKey, "key-a");
  }
});

test("提供商控件：复用现有菜单和箭头样式，去除原生 datalist 与独立说明行", () => {
  const html = makeHtml([], { comparisonMode: "bilingual", files: {}, labels: {} }, {
    projectKey: "test", generatedAt: "2026-10-01", rowsSignature: "rows", notesStorage: { key: "notes" },
  });
  const field = html.slice(html.indexOf('<div class="ai-field ai-provider-name-field">'), html.indexOf('<div class="ai-field ai-url-field">'));
  assert.match(field, /class="select-combobox provider-combobox"/);
  assert.match(field, /id="aiProvider"[^>]*role="combobox"/);
  assert.match(field, /class="select-trigger provider-toggle"/);
  assert.match(field, /class="select-icon"/);
  assert.match(field, /id="aiProviderNames" class="select-menu" role="listbox"/);
  assert.doesNotMatch(field, /<datalist|\slist=|class="hint"/);
});

function providerPicker() {
  const storage = storageFixture();
  presetTools.savePreset(storage, preset("服务甲"));
  presetTools.savePreset(storage, preset("服务乙"));
  const ui = createWorkbench(storage);
  return { ui, input: ui.element("aiProvider"), toggle: ui.element("aiProviderToggle"), menu: ui.element("aiProviderNames") };
}

test("提供商控件：展开候选并选择时保存名称，同时同步收起与无障碍状态", async () => {
  const { ui, input, toggle, menu } = providerPicker();
  assert.equal(menu.hidden, true);
  await toggle.dispatch("click");
  assert.equal(menu.hidden, false);
  assert.equal(input.getAttribute("aria-expanded"), "true");
  assert.equal(menu.children[0].className, "select-option");
  await menu.children[1].dispatch("click");
  assert.equal(input.value, "服务乙");
  assert.equal(menu.hidden, true);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(input.getAttribute("aria-expanded"), "false");
  assert.equal(JSON.parse(ui.storage.getItem("translation-compare-ai-config-v2")).provider, "服务乙");
});

test("提供商控件：输入筛选、无匹配时保留自定义名称，重新展开可选全部", async () => {
  const { ui, input, toggle, menu } = providerPicker();
  input.value = "乙";
  await input.dispatch("input");
  assert.deepEqual(Array.from(menu.children, (item) => item.textContent), ["服务乙"]);
  input.value = "新供应商";
  await input.dispatch("input");
  assert.match(menu.children[0].textContent, /无匹配项/);
  assert.equal(JSON.parse(ui.storage.getItem("translation-compare-ai-config-v2")).provider, "新供应商");
  await input.dispatch("keydown", { key: "Escape" });
  await toggle.dispatch("click");
  assert.deepEqual(Array.from(menu.children, (item) => item.textContent), ["服务甲", "服务乙"]);
  assert.equal(input.value, "新供应商");
});

test("提供商控件：连续方向键与 Enter 选择，Tab 和公共关闭逻辑均清理焦点状态", async () => {
  const { ui, input, menu } = providerPicker();
  const key = (value) => input.dispatch("keydown", { key: value, preventDefault() {} });
  await key("ArrowDown");
  assert.equal(input.getAttribute("aria-activedescendant"), "aiProviderOption-0");
  await key("ArrowDown");
  assert.equal(input.getAttribute("aria-activedescendant"), "aiProviderOption-1");
  await key("Enter");
  assert.equal(input.value, "服务乙");
  assert.equal(menu.hidden, true);
  await key("ArrowUp");
  await key("Tab");
  assert.equal(menu.hidden, true);
  assert.equal(input.getAttribute("aria-activedescendant"), null);
  await key("ArrowDown");
  ui.run('document.querySelectorAll = () => [document.getElementById("aiProviderCombobox")]; closeAllSelects();');
  assert.equal(menu.hidden, true);
  assert.equal(input.getAttribute("aria-expanded"), "false");
  assert.equal(input.getAttribute("aria-activedescendant"), null);
});

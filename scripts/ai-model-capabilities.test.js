const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { createWorkbench, storageFixture } = require("./workbench-fixture");
const { createPresetTools } = require("../src/workbenches/translation-compare/ai-presets");
const { cleanConfig } = require("./ai-proofread");

const {
  ALL_THINKING_LEVELS,
  detectModelCapabilities,
  isReasoningModel,
  normalizeModelReasoningEffort,
  normalizeModelId,
  browserModelCapabilitiesSource,
} = require("../src/workbenches/translation-compare/ai/model-capabilities");

const {
  buildChatCompletionBody,
  buildClaudeMessageBody,
  listModels,
} = require("./ai-proofread");

// 传入空的 models.dev 数据 → 强制走 manifest / 启发式 / 保守默认，保证测试确定性
function caps(model, provider = "") {
  return detectModelCapabilities(model, provider, {});
}

test("思考档位全集与 pi-ai 词汇表对齐", () => {
  assert.deepEqual(ALL_THINKING_LEVELS, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("Gemini 3.8 Flash 网关别名仅匹配能力，不改请求 ID 或增加档位", () => {
  for (const id of ["gemini-3.8-flash", "gemini-3.8-flash-high", "gemini-3.8-flash-low", "gemini-3.8-flash-medium", "gemini-3.8-flash-tiered", "google/gemini-3.8-flash-preview", "global:gemini-3.8-flash-high-sg"]) {
    const meta = caps(id);
    assert.equal(meta.id, id);
    assert.equal(meta.reasoning, true);
    assert.deepEqual(meta.reasoningEfforts, ["low", "medium", "high"]);
    for (const effort of ["low", "medium", "high", "max", "xhigh", "ultra", ""]) {
      const body = buildChatCompletionBody([], { model: id, reasoningEffort: effort });
      assert.equal(body.model, id);
      assert.equal(body.reasoning_effort, ["low", "medium", "high"].includes(effort) ? effort : undefined);
      assert.equal("temperature" in body, false);
    }
  }
});

test("归一化不剥掉独立 max 模型档与 Ollama 冒号标签", () => {
  assert.equal(normalizeModelId("hf:vendor/gemini-3.8-flash-high"), "gemini-3-8-flash");
  assert.equal(normalizeModelId("gpt-5.1-codex-max"), "gpt-5-1-codex-max");
  assert.equal(normalizeModelId("gpt-oss:20b"), "gpt-oss:20b");
  assert.notEqual(normalizeModelId("qwen3-max"), normalizeModelId("qwen3"));
});

test("模型能力优先采用已维护档位与端点声明；没有档位不猜通用三级", () => {
  assert.deepEqual(detectModelCapabilities("gemini-3.8-flash-high", "", {}, {
    reasoningEfforts: ["low", "medium", "high", "max"],
  }).reasoningEfforts, ["low", "medium", "high"]);
  const declared = detectModelCapabilities("custom-reasoner", "", {}, {
    supports_reasoning: true, reasoning_supported_efforts: ["LOW", "high", "invalid", "high"],
  });
  assert.deepEqual(declared.reasoningEfforts, ["low", "high"]);
  assert.equal(declared.source, "provider");
  assert.deepEqual(detectModelCapabilities("custom-reasoner", "", {}, { supports_reasoning: true }).reasoningEfforts, []);
  assert.equal(detectModelCapabilities("custom-thinking", "", {}, { supports_reasoning: false }).reasoning, false);
});

test("网关名称不在 models.dev 时，优先真实厂商而非随机网关", () => {
  const result = detectModelCapabilities("gemini-fixture-flash-high", "Custom Gateway", {
    gateway: { models: { "gemini-fixture-flash": { reasoning: true, reasoning_options: { type: "effort", values: ["max"] } } } },
    google: { models: { "gemini-fixture-flash": { reasoning: true, reasoning_options: { type: "effort", values: ["low", "high"] } } } },
  });
  assert.deepEqual(result.reasoningEfforts, ["low", "high"]);
});

test("纯浏览器解析器与服务端共用清单与别名匹配，无 Node 或网络依赖", () => {
  const vm = require("node:vm");
  const resolve = vm.runInNewContext(browserModelCapabilitiesSource() + "\nresolveClientModelCapabilities;");
  for (const id of ["gemini-3.8-flash-high", "openai/o1-mini", "kimi-k3", "qwen2.5:14b-instruct", "gpt-5.6"]) {
    assert.deepEqual(JSON.parse(JSON.stringify(resolve(id, "", {}))), caps(id));
  }
});

test("manifest 命中：kimi-k3 只支持 max 档且不支持 temperature", () => {
  const c = caps("kimi-k3");
  assert.equal(c.reasoning, true);
  assert.deepEqual(c.reasoningEfforts, ["max"]);
  assert.equal(c.supportsTemperature, false);
  assert.equal(c.source, "manifest");
});

test("manifest 命中：deepseek-reasoner 支持 high/max 档", () => {
  const c = caps("deepseek-reasoner");
  assert.equal(c.reasoning, true);
  assert.deepEqual(c.reasoningEfforts, ["high", "max"]);
  assert.equal(c.supportsTemperature, false);
  assert.equal(c.source, "manifest");
});

test("manifest 命中：o3-mini 支持 low/medium/high 且不支持 temperature", () => {
  const c = caps("o3-mini");
  assert.equal(c.reasoning, true);
  assert.deepEqual(c.reasoningEfforts, ["low", "medium", "high"]);
  assert.equal(c.supportsTemperature, false);
  assert.equal(c.source, "manifest");
});

test("名字匹配：带提供方前缀的 o 系列变体命中内置清单", () => {
  const c = caps("openai/o1-mini");
  assert.equal(c.reasoning, true);
  assert.deepEqual(c.reasoningEfforts, ["low", "medium", "high"]);
  assert.equal(c.supportsTemperature, false);
  assert.equal(c.source, "manifest");
});

test("启发式：deepseek-r1 与 QwQ 命中推理规则", () => {
  assert.equal(caps("deepseek-r1-distill-qwen-32b").reasoning, true);
  const qwq = caps("Qwen/QwQ-32B");
  assert.equal(qwq.reasoning, true);
  assert.deepEqual(qwq.reasoningEfforts, ["low", "medium", "high", "xhigh"]);
});

test("启发式：名字含 thinking/reasoner 的模型视为推理模型", () => {
  assert.equal(caps("qwen3-32b-thinking").reasoning, true);
  assert.equal(caps("glm-4-reasoner").reasoning, true);
});

test("保守默认：普通非推理模型走 temperature", () => {
  const c = caps("qwen2.5:14b-instruct");
  assert.equal(c.reasoning, false);
  assert.deepEqual(c.reasoningEfforts, []);
  assert.equal(c.supportsTemperature, true);
  assert.equal(c.source, "default");
  assert.equal(isReasoningModel("qwen2.5:14b-instruct", c), false);
});

test("manifest 命中不受模型名前缀/日期后缀影响", () => {
  const c = caps("kimi-k3-20260101");
  assert.equal(c.source, "manifest");
  assert.deepEqual(c.reasoningEfforts, ["max"]);
});

test("normalizeModelReasoningEffort 只接受该模型声明的档位", () => {
  const kimi = caps("kimi-k3");
  assert.equal(normalizeModelReasoningEffort("max", "kimi-k3", kimi), "max");
  assert.equal(normalizeModelReasoningEffort("high", "kimi-k3", kimi), "");
  assert.equal(normalizeModelReasoningEffort("0.8", "kimi-k3", kimi), "");

  const deepseek = caps("deepseek-reasoner");
  assert.equal(normalizeModelReasoningEffort("HIGH", "deepseek-reasoner", deepseek), "high");
  assert.equal(normalizeModelReasoningEffort("low", "deepseek-reasoner", deepseek), "");
});

test("推理模型请求携带 reasoning_effort 且不带 temperature", () => {
  const body = buildChatCompletionBody([{ role: "user", content: "proofread" }], {
    model: "deepseek-reasoner",
    reasoningEffort: "high",
  });
  assert.deepEqual(body, {
    model: "deepseek-reasoner",
    messages: [{ role: "user", content: "proofread" }],
    stream: false,
    reasoning_effort: "high",
  });
});

test("推理模型不支持 temperature：即使传入数值也不发送", () => {
  const body = buildChatCompletionBody([], {
    model: "deepseek-reasoner",
    reasoningEffort: "0.8",
  });
  assert.equal(Object.hasOwn(body, "reasoning_effort"), false);
  assert.equal(Object.hasOwn(body, "temperature"), false);
});

test("模型不支持的思考档位不会写入请求", () => {
  const body = buildChatCompletionBody([], {
    model: "kimi-k3",
    reasoningEffort: "high",
  });
  assert.equal(Object.hasOwn(body, "reasoning_effort"), false);
  assert.equal(Object.hasOwn(body, "temperature"), false);
});

test("非推理模型仍使用 temperature 采样", () => {
  const body = buildChatCompletionBody([], {
    model: "qwen2.5:14b-instruct",
    reasoningEffort: "0.8",
  });
  assert.deepEqual(body, {
    model: "qwen2.5:14b-instruct",
    messages: [],
    stream: false,
    temperature: 0.8,
  });
});

test("Claude 思考模型按档位映射 thinking budget", () => {
  const messages = [
    { role: "system", content: "proofread carefully" },
    { role: "user", content: "text" },
  ];
  const body = buildClaudeMessageBody(messages, {
    model: "claude-sonnet-5",
    reasoningEffort: "high",
  });
  assert.equal(body.thinking.type, "enabled");
  assert.deepEqual(body.thinking, { type: "enabled", budget_tokens: 8192 });
  assert.equal(body.max_tokens, 12288);
  assert.equal(Object.hasOwn(body, "temperature"), false);
});

test("Claude 非 thinking 请求保持 temperature 行为", () => {
  const messages = [
    { role: "system", content: "proofread carefully" },
    { role: "user", content: "text" },
  ];
  const body = buildClaudeMessageBody(messages, {
    model: "claude-sonnet-5",
    reasoningEffort: "0.2",
  });
  assert.equal(Object.hasOwn(body, "thinking"), false);
  assert.equal(body.temperature, 0.2);
  assert.equal(body.max_tokens, 4096);
});

test("模型列表发现会富化推理能力与思考档位", async (t) => {
  // 该用例只验证本地模型列表与能力合并；禁止单测为加载 models.dev 发起真实公网请求。
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url) === "https://models.dev/api.json") {
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }
    return realFetch(url, options);
  });
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      data: [
        { id: "kimi-k3" },
        { id: "qwen2.5:14b-instruct" },
        { id: "gemini-3.8-flash-high" },
        { id: "custom-effort-model", supports_reasoning: true, reasoning_supported_efforts: ["low", "high"] },
      ],
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    const result = await listModels({
      protocol: "compatible",
      baseUrl: `http://127.0.0.1:${address.port}`,
    });

    const kimi = result.models.find((model) => model.id === "kimi-k3");
    const qwen = result.models.find((model) => model.id === "qwen2.5:14b-instruct");
    assert.equal(kimi.reasoning, true);
    assert.equal(Array.isArray(kimi.reasoningEfforts), true);
    assert.equal(qwen.reasoning, false);
    assert.equal(qwen.supportsTemperature, true);
    assert.deepEqual(result.models.find((model) => model.id === "gemini-3.8-flash-high").reasoningEfforts, ["low", "medium", "high"]);
    assert.deepEqual(result.models.find((model) => model.id === "custom-effort-model").reasoningEfforts, ["low", "high"]);
    const { listProviderModels } = require("../src/ai/llm-client");
    const sharedModels = await listProviderModels({ protocol: "compatible", baseUrl: `http://127.0.0.1:${address.port}` });
    assert.deepEqual(sharedModels.find((model) => model.id === "custom-effort-model").reasoningEfforts, ["low", "high"]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("页面首次打开、手填模型与恢复旧预设均显示 Gemini 专属三档", async () => {
  const storage = storageFixture();
  const tools = createPresetTools();
  const preset = tools.savePreset(storage, {
    name: "Gemini", protocol: "compatible", provider: "Gateway", model: "gemini-3.8-flash-high", reasoningEffort: "max",
  });
  const ui = createWorkbench(storage);
  ui.run('setModelOptions(["gemini-3.8-flash-high"])');
  const values = () => Array.from(ui.element("aiReasoningEffort").children, (item) => item.value);
  assert.deepEqual(values(), ["", "low", "medium", "high"]);
  assert.equal(ui.element("aiReasoningEffort").dataset.mode, "reasoning");
  ui.element("aiPresetSelect").value = preset.id;
  await ui.element("aiPresetSelect").dispatch("change");
  assert.deepEqual(values(), ["", "low", "medium", "high"]);
  assert.equal(ui.element("aiReasoningEffort").value, "");
  const refreshed = createWorkbench(storage);
  assert.deepEqual(Array.from(refreshed.element("aiReasoningEffort").children, (item) => item.value), ["", "low", "medium", "high"]);
});

test("端点专属档位随配置和预设保存，刷新后经各阶段进入实际请求", async () => {
  const storage = storageFixture();
  const ui = createWorkbench(storage, { prompt: () => "端点模型" });
  ui.element("aiProtocol").value = "compatible";
  ui.element("aiProvider").value = "Service";
  ui.element("aiBaseUrl").value = "https://example.test/v1";
  ui.run('setModelOptions([{id:"custom-effort-model",reasoning:true,reasoningEfforts:["low","high"],source:"provider"}])');
  ui.element("aiReasoningEffort").value = "high";
  await ui.element("aiPresetSaveAs").dispatch("click");
  const presetId = ui.element("aiPresetSelect").value;
  const refreshed = createWorkbench(storage);
  assert.deepEqual(Array.from(refreshed.element("aiReasoningEffort").children, (item) => item.value), ["", "low", "high"]);
  assert.equal(refreshed.element("aiReasoningEffort").value, "high");
  for (const stage of ["stage1", "stage2", "stage3"]) {
    refreshed.element(`${stage}PresetSelect`).value = presetId;
    refreshed.element(`${stage}PresetAdd`).click();
  }
  const config = cleanConfig(refreshed.run("aiConfig()"));
  for (const stage of [config, config.stylistConfig, config.arbiterConfig]) {
    assert.equal(stage.reasoningEffort, "high");
    assert.deepEqual(Array.from(stage.modelMeta.reasoningEfforts), ["low", "high"]);
    const body = buildChatCompletionBody([], stage);
    assert.equal(body.model, "custom-effort-model");
    assert.equal(body.reasoning_effort, "high");
    assert.equal("temperature" in body, false);
  }
});

test("未知档位与跨模型元数据不得扩展思考范围，普通模型保留采样强度", () => {
  const ui = createWorkbench();
  ui.run('setModelOptions([{id:"opaque-reasoner",reasoning:true,reasoningEfforts:[]}])');
  assert.deepEqual(Array.from(ui.element("aiReasoningEffort").children, (item) => item.value), [""]);
  const modelMeta = { id: "another-model", reasoning: true, reasoningEfforts: ["high"] };
  const body = buildChatCompletionBody([], { model: "qwen2.5:14b-instruct", modelMeta, reasoningEffort: "high" });
  assert.equal("reasoning_effort" in body, false);
  assert.equal(body.temperature, 0.7);
});
